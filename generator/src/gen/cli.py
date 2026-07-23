"""CLI entry point: `uv run gen ...`

Generates a coloring-page SVG with the chosen backend and upserts it into the
app's catalog.json.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import NamedTuple

from dotenv import load_dotenv

from . import animate, banana, batch_api, catalog, dupes, gemma, svgtools, translate

# generator/.env, loaded regardless of current working directory.
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(_ENV_PATH)

# Default output dir: <repo>/app/public/images, derived from this file's location
# (generator/src/gen/cli.py -> repo root is 3 parents up).
DEFAULT_OUT = Path(__file__).resolve().parents[3] / "app" / "public" / "images"

# Post-threshold black/white PNGs are cached here so `gen animate` can reuse
# them as the image-edit input without re-rasterizing the SVG.
CACHE_DIR = Path(__file__).resolve().parents[2] / "cache" / "pngs"

# In-flight `--batch-api` jobs: one JSON file per job, holding everything
# needed to finish processing once the job completes (items, out dir, force).
# Lets `gen batch-status --job-id ...` re-attach after a Ctrl-C without the
# caller having to re-supply the batch file or re-run the dupe check.
BATCH_JOBS_DIR = Path(__file__).resolve().parents[2] / "cache" / "batch-jobs"

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class ImageExistsError(ValueError):
    """The image id is already in the catalog and --force was not given."""


class SimilarImageError(ValueError):
    """The subject is a near-duplicate theme of an existing catalog image."""

    def __init__(self, duplicate_id: str):
        super().__init__(
            f"subject looks similar to existing image '{duplicate_id}' "
            f"(use --allow-similar to generate anyway)"
        )
        self.duplicate_id = duplicate_id


class Item(NamedTuple):
    category: str
    image_id: str
    title: str
    subject: str
    tags: list[str]


def slugify_title(subject: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", subject)
    return " ".join(w.capitalize() for w in words[:4]) or subject


def title_from_id(image_id: str) -> str:
    """Derive a display title from a catalog id, e.g. 'red-fox' -> 'Red Fox'."""
    words = re.findall(r"[A-Za-z0-9]+", image_id.replace("-", " "))
    return " ".join(w.capitalize() for w in words) or image_id


def parse_tags(raw: str) -> list[str]:
    """Split a comma-separated tag string into clean lowercase tags."""
    return [t.strip().lower() for t in raw.split(",") if t.strip()]


def default_tags_from_title(title: str) -> list[str]:
    """Fallback tags: lowercase words from the title longer than 2 characters."""
    return [w.lower() for w in re.findall(r"[A-Za-z0-9]+", title) if len(w) > 2]


def generate_one(backend: str, subject: str, image_id: str) -> str:
    if backend == "banana":
        return banana.generate_svg(
            subject, png_cache_path=CACHE_DIR / f"{image_id}.png"
        )
    if backend == "gemma":
        return gemma.generate_svg(subject)
    raise ValueError(f"unknown backend: {backend}")


def _precheck_item(out_dir: Path, item: Item, cat: dict, force: bool, allow_similar: bool) -> None:
    """Raise if `item` should not be generated: bad id, existing id (no --force),
    or a near-duplicate theme (no --allow-similar).

    Shared by the synchronous path (`write_item`) and the Batch API submission
    path (`submit_batch_items`), so both skip existing/duplicate items BEFORE
    any API money is spent -- generation or vectorization happens strictly
    after this passes.
    """
    if not ID_RE.match(item.image_id):
        raise ValueError(
            f"invalid id '{item.image_id}': use lowercase letters, digits, "
            f"hyphens only, starting with a letter/digit"
        )

    if not force and catalog.find_image(cat, item.image_id) is not None:
        raise ImageExistsError(
            f"image id '{item.image_id}' already exists in catalog.json "
            f"(use --force to overwrite)"
        )

    if not allow_similar:
        duplicate_id = dupes.find_duplicate(item, cat)
        if duplicate_id:
            raise SimilarImageError(duplicate_id)


def _finish_item(out_dir: Path, item: Item, svg_text: str, force: bool) -> Path:
    """Write the generated SVG to disk and upsert the catalog entry.

    Shared tail for every source of `svg_text`: the synchronous backends,
    `--from-png`, and completed `--batch-api` jobs.
    """
    category_dir = out_dir / item.category
    category_dir.mkdir(parents=True, exist_ok=True)
    svg_path = category_dir / f"{item.image_id}.svg"
    svg_path.write_text(svg_text, encoding="utf-8")
    size_kb = len(svg_text.encode("utf-8")) / 1024
    print(f"  wrote {svg_path} ({size_kb:.1f} KB)")

    en_tags = item.tags or default_tags_from_title(item.title)
    tags = translate.tags_object(en_tags, translate.TAG_LANGS)

    cat = catalog.load_catalog(out_dir)  # reload in case of concurrent batch writes
    catalog.ensure_category(cat, item.category)
    catalog.upsert_image(
        cat,
        image_id=item.image_id,
        file=f"{item.category}/{item.image_id}.svg",
        title=item.title,
        category=item.category,
        tags=tags,
        force=force,
    )
    catalog.save_catalog(out_dir, cat)
    return svg_path


def write_item(
    *,
    out_dir: Path,
    backend: str | None,
    item: Item,
    force: bool,
    allow_similar: bool = False,
    from_png: Path | None = None,
) -> Path:
    """Generate (or vectorize) one SVG, write it to disk, upsert the catalog entry.

    Raises on any failure (generation, validation, an existing id without
    --force, or a near-duplicate theme without allow_similar). Returns the
    path written. Both checks run BEFORE the backend/vectorizer is called, so
    no API money is spent on duplicates.

    If `from_png` is given, `backend` is ignored: the PNG at that path is
    read from disk and run through the shared threshold/vectorize/clean
    pipeline (`banana.png_to_svg`) instead of calling out to Gemini/gemma.
    """
    cat = catalog.load_catalog(out_dir)
    _precheck_item(out_dir, item, cat, force, allow_similar)

    if from_png is not None:
        png_bytes = Path(from_png).read_bytes()
        svg_text = banana.png_to_svg(
            png_bytes, png_cache_path=CACHE_DIR / f"{item.image_id}.png"
        )
    else:
        if backend is None:
            raise ValueError("write_item: one of backend or from_png is required")
        svg_text = generate_one(backend, item.subject, item.image_id)

    return _finish_item(out_dir, item, svg_text, force)


def parse_batch_file(path: Path) -> list[Item]:
    """Parse a batch file, skipping blank/comment lines.

    Each line is 'category | id | title | subject' with an optional 5th field
    of comma-separated tags. Without tags, sensible defaults are derived from
    the title. A malformed line is logged as a warning and skipped rather than
    aborting the whole batch.
    """
    items: list[Item] = []
    for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) not in (4, 5):
            print(
                f"warning: {path}:{lineno}: expected 'category | id | title | "
                f"subject [| tags]', skipping line: {raw_line!r}",
                file=sys.stderr,
            )
            continue
        category, image_id, title, subject = parts[:4]
        tags = parse_tags(parts[4]) if len(parts) == 5 else default_tags_from_title(title)
        items.append(
            Item(category=category, image_id=image_id, title=title, subject=subject, tags=tags)
        )
    return items


# --- Batch API job persistence -------------------------------------------
#
# A `--batch-api` job can take a while (up to 24h SLA, though a real 2-item
# test job took ~2 minutes). If the user Ctrl-C's out of the polling loop,
# the job keeps running server-side; a small JSON state file (one per job,
# named after the job id) records everything needed to finish processing
# later with `gen batch-status --job-id <id>`, without re-parsing the batch
# file or re-running the (already-done) dupe check.


def _normalize_job_name(raw: str) -> str:
    """Accept both 'batches/xxx' and bare 'xxx' as --job-id input."""
    raw = raw.strip()
    return raw if raw.startswith("batches/") else f"batches/{raw}"


def _batch_job_state_path(job_name: str) -> Path:
    return BATCH_JOBS_DIR / f"{job_name.replace('/', '_')}.json"


def _save_batch_job_state(job_name: str, *, out_dir: Path, force: bool, items: list[Item]) -> None:
    BATCH_JOBS_DIR.mkdir(parents=True, exist_ok=True)
    state = {
        "job_name": job_name,
        "created_at": time.time(),
        "out": str(out_dir),
        "force": force,
        "items": [item._asdict() for item in items],
    }
    _batch_job_state_path(job_name).write_text(json.dumps(state, indent=2), encoding="utf-8")


def _load_batch_job_state(job_name: str) -> dict | None:
    path = _batch_job_state_path(job_name)
    if not path.exists():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    state["out"] = Path(state["out"])
    state["items"] = [Item(**d) for d in state["items"]]
    return state


def _delete_batch_job_state(job_name: str) -> None:
    _batch_job_state_path(job_name).unlink(missing_ok=True)


def _print_batch_progress(start_time: float):
    def on_tick(job: dict, state: str) -> None:
        stats = batch_api.batch_stats(job)
        elapsed = int(time.time() - start_time)
        print(
            f"  [{elapsed // 60}m{elapsed % 60:02d}s] {state} "
            f"(succeeded={stats.get('successfulRequestCount', 0)} "
            f"failed={stats.get('failedRequestCount', 0)} "
            f"pending={stats.get('pendingRequestCount', 0)} "
            f"of {stats.get('requestCount', '?')})"
        )

    return on_tick


def _process_batch_job_result(job: dict, out_dir: Path, force: bool, items: list[Item]) -> int:
    """Write every successfully-generated item's SVG and upsert the catalog.

    Prints per-item and summary lines in the same style as the synchronous
    batch path. Returns a process exit code.
    """
    state = batch_api.batch_state(job)
    if state != "BATCH_STATE_SUCCEEDED":
        print(f"error: batch job ended in {state}, nothing to process", file=sys.stderr)
        return 1

    try:
        results = batch_api.extract_results(job)
    except batch_api.BatchApiError as e:
        print(f"error: could not read batch job results: {e}", file=sys.stderr)
        return 1

    ok, failed = 0, []
    for i, item in enumerate(items, 1):
        print(f"[{i}/{len(items)}] {item.category}/{item.image_id}")
        result = results.get(item.image_id)
        if result is None:
            print("  FAILED: no result for this id in the batch job", file=sys.stderr)
            failed.append(item.image_id)
            continue
        if isinstance(result, batch_api.BatchApiError):
            print(f"  FAILED: {result}", file=sys.stderr)
            failed.append(item.image_id)
            continue
        try:
            svg_text = banana.png_to_svg(
                result, png_cache_path=CACHE_DIR / f"{item.image_id}.png"
            )
            _finish_item(out_dir, item, svg_text, force)
            ok += 1
        except Exception as e:  # noqa: BLE001 - continue on per-item failure
            print(f"  FAILED: {e}", file=sys.stderr)
            failed.append(item.image_id)

    print(f"\nbatch-api summary: {ok} generated, {len(failed)} failed")
    if failed:
        print(f"failed ids: {', '.join(failed)}")
    return 1 if failed and ok == 0 else 0


def run_batch_api(*, out_dir: Path, items: list[Item], force: bool, allow_similar: bool) -> int:
    """Submit `items` as one Gemini Batch API job, poll it, then process results.

    Pre-checks (bad id / already exists / near-duplicate) run for every item
    BEFORE submission, exactly like the synchronous batch path, so no Batch
    API money is spent on them either. On Ctrl-C, prints how to re-attach and
    returns a non-zero exit code; the job itself keeps running remotely.
    """
    cat = catalog.load_catalog(out_dir)
    to_submit: list[Item] = []
    skipped = 0
    for item in items:
        try:
            _precheck_item(out_dir, item, cat, force, allow_similar)
            to_submit.append(item)
        except ImageExistsError:
            print(f"{item.category}/{item.image_id}: already in catalog, skipped")
            skipped += 1
        except SimilarImageError as e:
            print(f"{item.category}/{item.image_id}: skipped (similar to {e.duplicate_id})")
            skipped += 1
        except ValueError as e:
            print(f"{item.category}/{item.image_id}: FAILED: {e}", file=sys.stderr)

    if not to_submit:
        print(f"\nbatch-api summary: 0 generated, {skipped} skipped, 0 failed")
        return 0

    print(f"\nsubmitting {len(to_submit)} item(s) to the Gemini Batch API...")
    try:
        job_name = batch_api.submit_batch(
            [(item.image_id, item.subject) for item in to_submit]
        )
    except batch_api.BatchApiError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    _save_batch_job_state(job_name, out_dir=out_dir, force=force, items=to_submit)
    print(f"job submitted: {job_name}")
    print(
        "polling every 45s -- safe to Ctrl-C; re-attach later with:\n"
        f"  uv run gen batch-status --job-id {job_name} --out {out_dir}"
    )

    try:
        job = batch_api.poll_until_done(
            job_name, interval=45.0, on_tick=_print_batch_progress(time.time())
        )
    except batch_api.BatchApiError as e:
        print(f"error while polling: {e}", file=sys.stderr)
        print(f"the job may still be running; re-attach with --job-id {job_name}")
        return 1
    except KeyboardInterrupt:
        print(
            f"\ninterrupted -- job {job_name} keeps running remotely. Re-attach with:\n"
            f"  uv run gen batch-status --job-id {job_name} --out {out_dir}"
        )
        return 130

    rc = _process_batch_job_result(job, out_dir, force, to_submit)
    _delete_batch_job_state(job_name)
    if skipped:
        print(f"({skipped} item(s) skipped before submission)")
    return rc


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gen",
        description=(
            "Generate SVG coloring pages (Gemini 'banana' or local 'gemma' "
            "backend) and add them to the Coloriki app catalog."
        ),
        epilog=(
            "Subcommands: 'gen animate --id <id> | --all [--out DIR] [--force]' "
            "generates a second micro-movement animation frame for existing "
            "images; 'gen translate-tags [--out DIR] [--langs ru,de] [--force]' "
            "backfills multilingual search tags; 'gen dupes --batch FILE "
            "[--out DIR]' dry-runs the duplicate-theme check without "
            "generating; 'gen batch-status --job-id <id> [--out DIR]' checks "
            "on (and finishes processing) a --batch-api job you Ctrl-C'd out "
            "of (see '--help' on each). '--from-png PATH' vectorizes a local "
            "line-art PNG instead of generating one (no --backend/--subject "
            "needed, no API call, single image only). '--batch-api' (with "
            "--batch FILE --backend banana) submits the whole pack as ONE "
            "Gemini Batch API job instead of one call per item: ~50% cheaper, "
            "async with up to a 24h SLA (usually much faster) -- use it for "
            "large non-urgent packs, keep the default for small/urgent ones."
        ),
    )
    p.add_argument(
        "--backend",
        choices=["banana", "gemma"],
        help="banana = Gemini 2.5 Flash Image (paid, quality); "
        "gemma = local LocalAI model (free, simple shapes); required unless "
        "--from-png is given",
    )
    p.add_argument(
        "--from-png",
        type=Path,
        help="vectorize this local PNG instead of generating one (threshold -> "
        "vtracer -> scour, no Gemini/gemma call, no --backend needed); "
        "single image only, incompatible with --batch",
    )
    p.add_argument(
        "--subject",
        help="subject description for the image prompt; with --from-png, only "
        "used as the pseudo-subject for the duplicate-theme check (falls back "
        "to --title, which falls back to a title derived from --id)",
    )
    p.add_argument("--id", dest="image_id", help="catalog id / SVG filename stem, e.g. 'dino'")
    p.add_argument("--category", help="catalog category, e.g. 'animals'")
    p.add_argument("--title", help="display title; defaults to a title-cased --subject")
    p.add_argument(
        "--tags",
        help="comma-separated English search keywords, e.g. 'dino,dinosaur,green'; "
        "defaults to words extracted from the title",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"output images root (default: {DEFAULT_OUT})",
    )
    p.add_argument(
        "--batch",
        type=Path,
        help="path to a batch file: one 'category | id | title | subject' per line, "
        "'#' starts a comment",
    )
    p.add_argument(
        "--batch-api",
        action="store_true",
        help="submit --batch as ONE Gemini Batch API job instead of one call per "
        "item: ~50%% cheaper, async (usually fast, SLA up to 24h); requires "
        "--backend banana; prints a job id, safe to Ctrl-C and re-attach with "
        "'gen batch-status --job-id <id>'",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="overwrite an existing catalog id instead of refusing",
    )
    p.add_argument(
        "--allow-similar",
        action="store_true",
        help="skip the duplicate-theme check (by default, subjects that look "
        "like an existing catalog image are not generated)",
    )
    return p


def build_animate_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gen animate",
        description=(
            "Generate a second 'micro-movement' animation frame "
            "(<category>/<id>.f2.svg) for existing catalog images via Gemini "
            "image editing, and record both frames in the catalog entry."
        ),
    )
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--id", dest="image_id", help="catalog id of the image to animate")
    group.add_argument(
        "--all",
        action="store_true",
        help="animate every catalog image that has no second frame yet",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"images root containing catalog.json (default: {DEFAULT_OUT})",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="regenerate the second frame even if <id>.f2.svg already exists",
    )
    return p


def animate_entry(out_dir: Path, entry: dict, force: bool) -> None:
    """Generate frame 2 for one catalog entry and update it in place on disk."""
    image_id = entry["id"]
    category = entry["category"]
    f2_rel = f"{category}/{image_id}.f2.svg"
    f2_path = out_dir / f2_rel
    if f2_path.exists() and not force:
        raise ValueError(f"{f2_path} already exists (use --force to regenerate)")

    svg_path = out_dir / entry["file"]
    svg_text = animate.generate_frame2_svg(image_id, svg_path, CACHE_DIR)

    f2_path.parent.mkdir(parents=True, exist_ok=True)
    f2_path.write_text(svg_text, encoding="utf-8")
    size_kb = len(svg_text.encode("utf-8")) / 1024
    print(f"  wrote {f2_path} ({size_kb:.1f} KB)")

    # Reload before writing so a concurrently-running batch isn't clobbered.
    cat = catalog.load_catalog(out_dir)
    live = catalog.find_image(cat, image_id)
    if live is None:
        raise ValueError(f"image id '{image_id}' vanished from catalog.json")
    live["frames"] = [live["file"], f2_rel]
    catalog.save_catalog(out_dir, cat)


def animate_main(argv: list[str]) -> int:
    args = build_animate_parser().parse_args(argv)
    out_dir: Path = args.out

    cat = catalog.load_catalog(out_dir)
    if args.image_id:
        entry = catalog.find_image(cat, args.image_id)
        if entry is None:
            print(f"error: image id '{args.image_id}' not found in {out_dir}/catalog.json",
                  file=sys.stderr)
            return 1
        entries = [entry]
    else:
        entries = [
            img for img in cat.get("images", [])
            if len(img.get("frames", [])) < 2
        ]
        if not entries:
            print("nothing to do: every catalog image already has a second frame")
            return 0

    print(f"animate: {len(entries)} image(s), out={out_dir}")
    ok, failed = 0, []
    for i, entry in enumerate(entries, 1):
        print(f"[{i}/{len(entries)}] {entry['category']}/{entry['id']}")
        try:
            animate_entry(out_dir, entry, args.force)
            ok += 1
        except Exception as e:  # noqa: BLE001 - continue on per-item failure
            print(f"  FAILED: {e}", file=sys.stderr)
            failed.append(entry["id"])

    print(f"\nanimate summary: {ok} succeeded, {len(failed)} failed")
    if failed:
        print(f"failed ids: {', '.join(failed)}")
    return 1 if failed and ok == 0 else 0


def build_translate_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gen translate-tags",
        description=(
            "Backfill multilingual search tags: convert legacy array tags to "
            "the {en: [...], ru: [...], ...} object form and translate missing "
            "languages via local Gemma."
        ),
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"images root containing catalog.json (default: {DEFAULT_OUT})",
    )
    p.add_argument(
        "--langs",
        default=",".join(translate.TAG_LANGS),
        help=f"comma-separated target languages (default: {','.join(translate.TAG_LANGS)})",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="re-translate even languages that are already present",
    )
    return p


def translate_tags_main(argv: list[str]) -> int:
    args = build_translate_parser().parse_args(argv)
    out_dir: Path = args.out
    langs = [l.strip().lower() for l in args.langs.split(",") if l.strip()]
    if not langs:
        print("error: --langs is empty", file=sys.stderr)
        return 2

    cat = catalog.load_catalog(out_dir)
    images = cat.get("images", [])
    if not images:
        print(f"nothing to do: no images in {out_dir}/catalog.json")
        return 0

    print(f"translate-tags: {len(images)} image(s), langs={langs}, out={out_dir}")
    updates: dict[str, dict[str, list[str]]] = {}
    translated, converted, skipped, failed = 0, 0, 0, []

    for i, entry in enumerate(images, 1):
        image_id = entry["id"]
        old_tags = entry.get("tags")
        tags = translate.normalize_tags(old_tags, entry.get("title", ""))
        en_tags = tags.get("en", [])

        needed = langs if args.force else [l for l in langs if l not in tags]
        if not needed and tags == old_tags:
            skipped += 1
            continue

        label = f"[{i}/{len(images)}] {image_id}"
        if needed and en_tags:
            try:
                tags.update(translate.translate_keywords(en_tags, needed))
                translated += 1
                print(f"{label}: translated {needed}")
            except (translate.TranslateError, gemma.GemmaError) as e:
                failed.append(image_id)
                print(f"{label}: translation FAILED, keeping what we have: {e}",
                      file=sys.stderr)
        else:
            converted += 1
            print(f"{label}: converted to object form (no translation needed)")

        if tags != old_tags:
            updates[image_id] = tags

    if updates:
        # Reload right before saving so concurrent writers aren't clobbered.
        cat = catalog.load_catalog(out_dir)
        applied = 0
        for image_id, tags in updates.items():
            live = catalog.find_image(cat, image_id)
            if live is not None:
                live["tags"] = tags
                applied += 1
        catalog.save_catalog(out_dir, cat)
        print(f"\nsaved {applied} updated entr(y/ies) to {out_dir}/catalog.json")

    print(
        f"translate-tags summary: {translated} translated, {converted} converted, "
        f"{skipped} already complete, {len(failed)} failed"
    )
    if failed:
        print(f"failed ids: {', '.join(failed)}")
    return 1 if failed and not updates else 0


def build_dupes_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gen dupes",
        description=(
            "Dry-run duplicate-theme check: test every batch line against the "
            "existing catalog without generating anything. Free (local Gemma)."
        ),
    )
    p.add_argument(
        "--batch",
        type=Path,
        required=True,
        help="batch file to check (same format as 'gen --batch')",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"images root containing catalog.json (default: {DEFAULT_OUT})",
    )
    return p


def dupes_main(argv: list[str]) -> int:
    args = build_dupes_parser().parse_args(argv)
    try:
        items = parse_batch_file(args.batch)
    except OSError as e:
        print(f"error: could not read batch file {args.batch}: {e}", file=sys.stderr)
        return 2
    if not items:
        print(f"no items in {args.batch}")
        return 0

    cat = catalog.load_catalog(args.out)
    print(f"dupes check: {len(items)} item(s) against {args.out}/catalog.json\n")
    id_width = max(len(f"{it.category}/{it.image_id}") for it in items)
    n_ok, n_dup, n_exists = 0, 0, 0
    for item in items:
        label = f"{item.category}/{item.image_id}".ljust(id_width)
        if catalog.find_image(cat, item.image_id) is not None:
            print(f"  {label}  already in catalog (same id)")
            n_exists += 1
            continue
        duplicate_id = dupes.find_duplicate(item, cat)
        if duplicate_id:
            print(f"  {label}  similar to '{duplicate_id}'")
            n_dup += 1
        else:
            print(f"  {label}  ok")
            n_ok += 1

    print(
        f"\ndupes summary: {n_ok} ok, {n_dup} similar, "
        f"{n_exists} already in catalog (by id)"
    )
    return 0


def build_batch_status_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gen batch-status",
        description=(
            "Check on (and, if done, finish processing) a 'gen --batch-api' job "
            "you previously Ctrl-C'd out of or otherwise left running. Reads "
            "the job's saved state from generator/cache/batch-jobs/ -- no need "
            "to re-supply the batch file."
        ),
    )
    p.add_argument(
        "--job-id",
        required=True,
        help="job id printed by 'gen --batch-api' (with or without the "
        "'batches/' prefix)",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"images root containing catalog.json (default: {DEFAULT_OUT}); "
        "must match the --out used at submission time",
    )
    return p


def batch_status_main(argv: list[str]) -> int:
    args = build_batch_status_parser().parse_args(argv)
    job_name = _normalize_job_name(args.job_id)

    state = _load_batch_job_state(job_name)
    if state is None:
        print(
            f"error: no pending batch job matches '{job_name}' in "
            f"{BATCH_JOBS_DIR} (already finished and processed, or wrong id)",
            file=sys.stderr,
        )
        return 2

    try:
        job = batch_api.get_batch(job_name)
    except batch_api.BatchApiError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    job_state = batch_api.batch_state(job)
    stats = batch_api.batch_stats(job)
    print(f"job {job_name}: {job_state} {stats}")
    if not batch_api.is_done(job_state):
        print("still in progress -- run this command again later")
        return 0

    rc = _process_batch_job_result(job, state["out"], state["force"], state["items"])
    _delete_batch_job_state(job_name)
    return rc


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "animate":
        return animate_main(argv[1:])
    if argv and argv[0] == "translate-tags":
        return translate_tags_main(argv[1:])
    if argv and argv[0] == "dupes":
        return dupes_main(argv[1:])
    if argv and argv[0] == "batch-status":
        return batch_status_main(argv[1:])
    args = build_parser().parse_args(argv)
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.from_png and args.batch:
        print("error: --from-png cannot be combined with --batch (single image only)",
              file=sys.stderr)
        return 2

    if args.batch_api and not args.batch:
        print("error: --batch-api requires --batch FILE", file=sys.stderr)
        return 2

    if args.batch_api and args.backend != "banana":
        print("error: --batch-api requires --backend banana (Gemini only)", file=sys.stderr)
        return 2

    if args.from_png:
        if not args.image_id or not args.category:
            print("error: --id and --category are required with --from-png",
                  file=sys.stderr)
            return 2
        if not args.from_png.is_file():
            print(f"error: --from-png file not found: {args.from_png}", file=sys.stderr)
            return 2

        title = args.title or (
            slugify_title(args.subject) if args.subject else title_from_id(args.image_id)
        )
        subject = args.subject or title
        item = Item(
            category=args.category,
            image_id=args.image_id,
            title=title,
            subject=subject,
            tags=parse_tags(args.tags) if args.tags else default_tags_from_title(title),
        )
        try:
            write_item(
                out_dir=out_dir,
                backend=args.backend,
                item=item,
                force=args.force,
                allow_similar=args.allow_similar,
                from_png=args.from_png,
            )
        except (
            ValueError,
            banana.BananaError,
            gemma.GemmaError,
            svgtools.SvgValidationError,
        ) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        print("done.")
        return 0

    if not args.backend:
        print("error: --backend is required (unless using --from-png)", file=sys.stderr)
        return 2

    if args.batch:
        try:
            items = parse_batch_file(args.batch)
        except OSError as e:
            print(f"error: could not read batch file {args.batch}: {e}", file=sys.stderr)
            return 2

        if args.batch_api:
            print(
                f"batch-api: {len(items)} item(s) from {args.batch}, backend=banana "
                f"(Gemini Batch API, ~50% cheaper, async)"
            )
            return run_batch_api(
                out_dir=out_dir,
                items=items,
                force=args.force,
                allow_similar=args.allow_similar,
            )

        print(f"batch: {len(items)} item(s) from {args.batch}, backend={args.backend}")
        ok, skipped, failed = 0, 0, []
        for i, item in enumerate(items, 1):
            print(f"[{i}/{len(items)}] {item.category}/{item.image_id}: {item.subject!r}")
            try:
                write_item(
                    out_dir=out_dir,
                    backend=args.backend,
                    item=item,
                    force=args.force,
                    allow_similar=args.allow_similar,
                )
                ok += 1
            except ImageExistsError:
                # Re-running a batch file only generates the new lines; existing
                # ids are skipped for free (the check happens before any API call).
                print("  already in catalog, skipped")
                skipped += 1
            except SimilarImageError as e:
                # Near-duplicate theme: also skipped before any API call.
                print(f"  skipped (similar to {e.duplicate_id})")
                skipped += 1
            except Exception as e:  # noqa: BLE001 - continue on per-item failure
                print(f"  FAILED: {e}", file=sys.stderr)
                failed.append(item.image_id)

        print(f"\nbatch summary: {ok} generated, {skipped} skipped, {len(failed)} failed")
        if failed:
            print(f"failed ids: {', '.join(failed)}")
        return 1 if failed and ok == 0 and skipped == 0 else 0

    if not args.subject or not args.image_id or not args.category:
        print(
            "error: --subject, --id and --category are required "
            "(or use --batch)",
            file=sys.stderr,
        )
        return 2

    title = args.title or slugify_title(args.subject)
    item = Item(
        category=args.category,
        image_id=args.image_id,
        title=title,
        subject=args.subject,
        tags=parse_tags(args.tags) if args.tags else default_tags_from_title(title),
    )
    try:
        write_item(
            out_dir=out_dir,
            backend=args.backend,
            item=item,
            force=args.force,
            allow_similar=args.allow_similar,
        )
    except (
        ValueError,
        banana.BananaError,
        gemma.GemmaError,
        svgtools.SvgValidationError,
    ) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

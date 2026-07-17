"""CLI entry point: `uv run gen ...`

Generates a coloring-page SVG with the chosen backend and upserts it into the
app's catalog.json.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import NamedTuple

from dotenv import load_dotenv

from . import animate, banana, catalog, dupes, gemma, svgtools, translate

# generator/.env, loaded regardless of current working directory.
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(_ENV_PATH)

# Default output dir: <repo>/app/public/images, derived from this file's location
# (generator/src/gen/cli.py -> repo root is 3 parents up).
DEFAULT_OUT = Path(__file__).resolve().parents[3] / "app" / "public" / "images"

# Post-threshold black/white PNGs are cached here so `gen animate` can reuse
# them as the image-edit input without re-rasterizing the SVG.
CACHE_DIR = Path(__file__).resolve().parents[2] / "cache" / "pngs"

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


def write_item(
    *,
    out_dir: Path,
    backend: str,
    item: Item,
    force: bool,
    allow_similar: bool = False,
) -> Path:
    """Generate one SVG, write it to disk, and upsert the catalog entry.

    Raises on any failure (generation, validation, an existing id without
    --force, or a near-duplicate theme without allow_similar). Returns the
    path written. Both checks run BEFORE the backend is called, so no API
    money is spent on duplicates.
    """
    if not ID_RE.match(item.image_id):
        raise ValueError(
            f"invalid id '{item.image_id}': use lowercase letters, digits, "
            f"hyphens only, starting with a letter/digit"
        )

    cat = catalog.load_catalog(out_dir)
    if not force and catalog.find_image(cat, item.image_id) is not None:
        raise ImageExistsError(
            f"image id '{item.image_id}' already exists in catalog.json "
            f"(use --force to overwrite)"
        )

    if not allow_similar:
        duplicate_id = dupes.find_duplicate(item, cat)
        if duplicate_id:
            raise SimilarImageError(duplicate_id)

    svg_text = generate_one(backend, item.subject, item.image_id)

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
            "generating (see '--help' on each)."
        ),
    )
    p.add_argument(
        "--backend",
        choices=["banana", "gemma"],
        required=True,
        help="banana = Gemini 2.5 Flash Image (paid, quality); "
        "gemma = local LocalAI model (free, simple shapes)",
    )
    p.add_argument("--subject", help="subject description for the image prompt")
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


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "animate":
        return animate_main(argv[1:])
    if argv and argv[0] == "translate-tags":
        return translate_tags_main(argv[1:])
    if argv and argv[0] == "dupes":
        return dupes_main(argv[1:])
    args = build_parser().parse_args(argv)
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.batch:
        try:
            items = parse_batch_file(args.batch)
        except OSError as e:
            print(f"error: could not read batch file {args.batch}: {e}", file=sys.stderr)
            return 2

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

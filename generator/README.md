# Coloriki generator

Generates SVG coloring pages and adds them to the app's catalog
(`app/public/images/catalog.json`). Python, `uv`-only — no pip/Homebrew.

## Setup

```bash
cd generator
uv sync
```

## Backends

### `banana` — Gemini 2.5 Flash Image (paid, best quality)

Pipeline: prompt → Gemini image generation → Pillow threshold/despeckle →
`vtracer` vectorization → `scour` optimization → SVG.

Needs an API key:

```bash
cp generator/.env.example generator/.env
# edit .env and set GEMINI_API_KEY=... (get one at https://aistudio.google.com/apikey)
```

`.env` is loaded automatically (via `python-dotenv`); the env var also works
if already exported. If the key is missing, `gen` fails immediately with a
clear error message instead of making a request.

**Cost**: roughly $0.04 per image (nano banana pricing) → about **$4 per 100
images**. Use `gemma` below for free experimentation, and reserve `banana`
for images you actually want to ship.

### `gemma` — local LocalAI model (free, simple/absurd shapes only)

Talks to a local LocalAI server at `http://127.0.0.1:1240/v1`
(model `gemma-4-e4b-it-qat-q4_0`), asking it to author the SVG directly (no
image generation/vectorization step). Good for simple, blocky, or
deliberately silly shapes; not as clean as `banana` for detailed subjects.

Requires LocalAI to be running locally with that model loaded. `gen` does a
preflight check against `GET /v1/models` and fails with a clear error if the
server or model isn't available. It also retries up to 3 times if the model
returns something that isn't valid, sufficiently-complete SVG.

## Usage

Single image:

```bash
uv run gen --backend banana --subject "a friendly dinosaur" --id dino --category animals
uv run gen --backend gemma  --subject "a simple house with a triangular roof" --id house --category nature
```

Flags:

- `--backend banana|gemma` (required)
- `--subject "..."` — prompt describing the subject
- `--id my-id` — catalog id / SVG filename (`<category>/<id>.svg`); lowercase
  letters, digits, hyphens
- `--category animals` — catalog category (created automatically with a
  default emoji if new: animals 🐾, nature 🌿, vehicles 🚗, characters 🦸,
  funny 🤪, food 🍎, space 🚀, events 🎉, professions 👩‍🚒, else 🖼️)
- `--title "Dino"` — display title (defaults to a title-cased `--subject`)
- `--tags "dino,dinosaur,green"` — comma-separated English search keywords;
  defaults to lowercase words (longer than 2 chars) extracted from the title.
  Stored on the catalog entry as an object keyed by language,
  `tags: {"en": [...], "ru": [...], "de": [...]}` — the non-English lists are
  translated automatically via local Gemma (free; falls back to English-only
  with a warning if LocalAI is unavailable — generation never fails because
  of translation). The app matches search queries across all languages. The
  legacy plain-array form (`tags: [...]` = English) is still accepted by the
  app but no longer written.
- `--out /path/to/images` — output images root (default:
  `app/public/images`, i.e. the real app catalog — pass a temp `--out` when
  testing!)
- `--force` — overwrite an existing catalog id (refused by default)

Batch mode — generate many images from a text file:

```bash
uv run gen --backend banana --batch prompts/starter.txt
```

Each non-comment, non-blank line is
`category | id | title | subject prompt` with an optional fifth field of
comma-separated tags: `category | id | title | subject | tag1, tag2, tag3`.
Four-field lines still work — tags then default to words extracted from the
title. A `#`-prefixed line is a comment. Malformed lines are skipped with a
warning; generation failures are logged per item and don't stop the batch.
A summary (`N succeeded, M failed`) is printed at the end.

`prompts/starter.txt` ships ~50 ready-to-use prompts across animals, nature,
vehicles, characters (described generically, no franchise names),
funny/absurd subjects, events (birthday, first school day, New Year, weddings,
and more), and professions.

## Animation frames (`gen animate`)

Every coloring page can have a second "micro-movement" line-art frame that
the app cycles over one shared paint layer (blinking eyes, a widening smile,
a slightly shifted tail...). Generate it with:

```bash
uv run gen animate --id dino            # one image
uv run gen animate --all                # every image without a second frame yet
uv run gen animate --id dino --force    # regenerate an existing second frame
```

How it works:

- Frame 1 raster comes from `cache/pngs/<id>.png` (saved automatically during
  normal `banana` generation) or, for older images, from rasterizing the
  existing SVG via macOS `qlmanage` (this pipeline is Mac-only anyway).
- Gemini `gemini-2.5-flash-image` is called in image-edit mode (frame-1 PNG +
  an instruction to change only one small body part), then the result goes
  through the same threshold → vtracer → scour pipeline.
- Output is `<out>/<category>/<id>.f2.svg`, and the catalog entry gains
  `"frames": ["<category>/<id>.svg", "<category>/<id>.f2.svg"]`. `file` keeps
  pointing at frame 1 (thumbnails, older clients).
- Existing `.f2.svg` files are never overwritten without `--force`.
- `--all` continues past per-image failures and prints a summary.

**Cost**: each animation frame is one more nano banana call, about **+$0.04
per image** (so a fully animated 100-image catalog costs ~$8 total: $4 for
the base frames + $4 for the second frames). `animate` always uses Gemini,
regardless of which backend generated the base frame.

## Multilingual tags backfill (`gen translate-tags`)

Older catalog entries may still have legacy array tags (English only) or be
missing some languages. Backfill them with:

```bash
uv run gen translate-tags                 # default langs: ru,de
uv run gen translate-tags --langs ru,de,fr
uv run gen translate-tags --force         # re-translate existing languages too
```

Converts legacy arrays to the object form and translates missing languages
via local Gemma (one call per image, free). Entries that already have all
requested languages are skipped unless `--force`. Per-item failures are
logged and don't stop the run; the catalog is saved once at the end (with a
fresh reload right before saving, so it's safe to run alongside a generation
batch). Target languages for normal generation live in `TAG_LANGS` in
`src/gen/translate.py`.

## Adding images manually

You don't need this pipeline to add an image — just:

1. Drop a coloring-page SVG into `app/public/images/<category>/<id>.svg`.
   Contract: `viewBox="0 0 1024 1024"`, closed regions, `fill="#fff"` +
   `stroke="#000"`, thick outlines (stroke-width 8–14), no gradients/scripts/
   text, ≤ 50 KB after optimization. See `CLAUDE.md` at the repo root for the
   full contract.
2. Add an entry to `app/public/images/catalog.json`:
   ```json
   { "id": "my-id", "file": "<category>/my-id.svg", "title": "My Title", "category": "<category>", "tags": { "en": ["keyword1"], "ru": ["..."], "de": ["..."] } }
   ```
   (and a `categories` entry with an `icon` emoji if it's a new category).
3. Redeploy (Netlify static site — push to the connected branch, or trigger a
   deploy manually).

## Known limitations

- `gemma` output quality is limited to simple shapes (3+ closed regions);
  it's not meant to replace `banana` for detailed subjects.
- `vtracer`'s polygon mode is used (not spline) for reliable, in-bounds
  absolute coordinates; this trades a bit of curve smoothness for
  robustness.
- `gen animate` frame alignment depends on the model: lines usually stay
  put, but small global drift (a few pixels of scale/position) can happen.
  Review the pair and re-run with `--force` if a frame jumps too much.
- `gen animate` requires macOS (`qlmanage`) when no cached PNG exists for
  the image.

## Duplicate-theme detection

Every `gen` run checks the subject against the existing catalog before any paid
API call: stage 1 is cheap word overlap (id + title + English tags, stopwords
dropped), stage 2 is a deterministic local Gemma verdict (temperature 0) on the
top overlap candidates. Duplicates are skipped as `similar to <id>`; if LocalAI
is down, the word-overlap verdict alone decides (with a warning).

- Dry-run a pack without generating: `uv run gen dupes --batch file.txt`
- Bypass intentionally: `--allow-similar`

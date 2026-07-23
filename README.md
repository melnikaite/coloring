# Coloriki 🎨

Offline-first PWA coloring app for kids. Pick a picture, paint it with a finger —
brushes, markers, flood fill, "stay inside the lines" magic mode, pinch zoom,
claymation-style animation of the finished drawing, GIF export. Internet is only
needed to fetch new pictures; coloring and saving work fully offline (installable
PWA, IndexedDB, service worker).

- **App** (`app/`): Vite + TypeScript, no framework, deployed to Netlify as a static site.
- **Generator** (`generator/`): Python (uv) pipeline that turns text prompts into
  SVG coloring pages via Gemini image generation + vectorization.

The UI is icon/emoji-only on purpose — the target audience can't read yet.
Tooltips and search adapt to the browser language (en/ru/de).

---

## Cheat sheet (the stuff you WILL forget)

| I want to… | Do this |
|---|---|
| Run the app locally | `cd app && npm install && npm run dev` → http://localhost:5199 |
| Generate one picture | `cd generator && uv run gen --backend banana --subject "a friendly dragon" --id dragon --category animals` |
| Generate a whole pack | `uv run gen --batch prompts/mypack.txt` |
| Re-roll an ugly picture | same command + `--force` (tweak the `--subject` wording) |
| Add the "alive" second frame | `uv run gen animate --id dragon` (or `--all` for every image that has none) |
| Translate tags for search | `uv run gen translate-tags` (needs LocalAI running) |
| Publish everything | `git add -A && git commit && git push` → Netlify auto-deploys |
| Check what a picture looks like | `qlmanage -t -s 512 -o /tmp app/public/images/animals/dragon.svg` |

All `gen` commands run from `generator/`. Run `uv run gen --help` for every flag.

## API key

Image generation uses Gemini 2.5 Flash Image ("nano banana"). The key lives in
**`generator/.env`** (gitignored — never commit it):

```
GEMINI_API_KEY=...
```

Get a key at https://aistudio.google.com/apikey.

**Cost:** ~$0.04 per image. A 50-image pack ≈ $2; an animation frame is another
$0.04 per image. The free `gemma` backend (local LocalAI on :1240) exists but only
produces abstract blobs — use it for pipeline testing, not real content.

## Generating pictures

### One-off

```bash
cd generator
uv run gen --backend banana \
  --subject "a friendly dragon reading a book under a tree" \
  --id dragon-book --category animals \
  --title "Dragon Bookworm" --tags "dragon,book,tree,reading"
```

- `--subject` is the actual image prompt (English). Describe it kid-simple; the
  pipeline adds the "thick outlines, no shading, coloring page" boilerplate itself.
- `--id` = filename + catalog id (lowercase, digits, hyphens). `--force` overwrites.
- `--category` creates the category automatically with an emoji from the builtin
  map (animals/nature/vehicles/characters/funny/events/professions/food/space);
  unknown categories get 🖼️ — add nicer emoji in `generator/src/gen/catalog.py`.
- `--tags` optional; defaults to words from the title. Tags are auto-translated
  (see Languages below).

### Batches (the normal way)

One line per image in a text file (see `generator/prompts/starter.txt`):

```
category | id | title | subject prompt | tag1, tag2, tag3
```

The tags field is optional; `#` lines are comments. Then:

```bash
uv run gen --batch prompts/mypack.txt
```

Failures don't abort the batch — a summary is printed at the end.

**Batch files are incremental**: ids already in the catalog are skipped for free
(the check happens before any API call), so the normal workflow is to keep ONE
growing pack file, append new lines, and re-run it — only the new lines are
generated and billed. `--force` regenerates everything in the file.

**Duplicate themes are caught too**: before generating, every subject is checked
against the catalog (word overlap + a local Gemma verdict, free) — a re-invented
theme under a new id is reported as `similar to <existing id>` and skipped, no
API spend. Check a brainstormed pack without generating anything:

```bash
uv run gen dupes --batch prompts/newpack.txt
```

`--allow-similar` disables the check when a similar theme is intentional.

### Prompt-writing tips (learned the hard way)

- Franchise characters: describe them generically ("a bald monk boy with an arrow
  on his head"), never by name — the model refuses or draws something off.
- Add "no text, no letters" if the scene contains signs/boxes/labels.
- Add "no frame, no border" if the model keeps drawing a frame (it sometimes does
  anyway — re-roll with `--force`).
- Busy multi-object scenes vectorize worse than one big character. Keep it simple.

### Quality control

Always eyeball a new pack before pushing:

```bash
for f in app/public/images/<category>/*.svg; do qlmanage -t -s 256 -o /tmp/qa "$f"; done
open /tmp/qa
```

Re-roll rejects with `--force`. Expect a ~5% reject rate (frames, text, mush).

## Animation frames

Every picture can have a second line-art frame with one micro-movement (a blink,
a shifted paw). The app cycles the frames over the child's static coloring in the
🎉 celebrate screen and in the exported GIF; pictures without a second frame get a
synthetic "line boil" wobble instead.

```bash
uv run gen animate --id dragon-book   # one picture (+$0.04)
uv run gen animate --all              # every picture that has no second frame yet
```

Frame 2 is written as `<id>.f2.svg` next to frame 1 and recorded in the catalog's
`frames` array. If the movement came out ugly or misaligned, re-roll:
`uv run gen animate --id dragon-book --force`.

Two-frame pictures can also be **colored per frame**: a 1️⃣/2️⃣ switcher appears in
the editor's top bar. The first switch to frame 2 starts from an automatic copy of
frame 1's colors, so the child only touches up the moved part - erase the stain at
the old spot, fill the region at the new one (📋 re-copies frame 1's colors later,
with a confirm). The celebrate animation and GIF then play each frame with its own
coloring; until frame 2 is touched, both frames share frame 1's paint as before.

## Languages

Three places know about languages:

1. **UI strings** (tooltips, search placeholder): `app/src/i18n.ts` — dictionaries
   keyed by 2-letter code, picked via `navigator.language`, fallback `en`.
2. **Search tags** in `app/public/images/catalog.json`:
   `"tags": {"en": [...], "ru": [...], "de": [...]}`. Search matches ALL languages
   at once, so it works no matter which language the parent types in.
3. **Generator translation**: new images get their English tags translated to the
   languages in `TAG_LANGS` (`generator/src/gen/translate.py`) by the local Gemma
   model — free, requires LocalAI running on :1240. If LocalAI is down, images get
   English-only tags; backfill later.

### Adding a new language (e.g. French) to an existing catalog

1. Add `fr` to `TAG_LANGS` in `generator/src/gen/translate.py`.
2. Add an `fr` dictionary to `app/src/i18n.ts`.
3. Backfill every existing picture's tags:
   ```bash
   uv run gen translate-tags --langs ru,de,fr
   ```
   (Skips entries that already have all requested languages; `--force` re-translates.)
4. Commit + push.

## Deploying

The repo is connected to Netlify with git integration: **every push to `main` is a
production deploy** (build config in `netlify.toml`: base `app`, publish `dist`).

- **Batch your pushes.** A production deploy costs 15 Netlify credits; the free
  plan has a hard cap of 300/month. Generate a pack, QA it, push once.
- Pushes to any other branch create free deploy previews — use branches to test.
- If credits run out, the site goes down until the 1st of the month (installed
  PWAs keep working offline). Usage: Netlify dashboard → Billing.

## How the app works (30-second tour)

- The SVG is rasterized at 1600px; dark pixels (luminance < 140) become the line
  layer + a "barrier map". Flood fill and the 🧲 inside-lines mode compute region
  masks from that map (cached, LRU-capped); strokes are clipped to the region where
  the stroke started. Paint lives on a separate canvas under the lines.
- Saving: autosaved per picture to IndexedDB (paint layer PNG + thumbnail), listed
  under 🎨 "My works". Export: PNG (📤) and animated GIF (🎬, gifenc).
- Offline: service worker — app shell + the hashed JS/CSS bundle are both precached
  on install (a build-time manifest tells the SW every hashed filename, so a single
  online visit is enough — no more "needs two loads" gap), images cache-first
  (catalog.json network-first so new packs show up!), per-category ⬇️ download
  buttons in the gallery fetch whole categories into the cache. Network requests
  time out after 3s and fall back to cache, so a "connected but broken" network
  (captive wifi, weak signal) doesn't hang the app.
- Install: since Chrome doesn't reliably prompt on its own, a 📲 button appears in
  the gallery topbar (via `beforeinstallprompt`, `app/src/installPrompt.ts`) whenever
  the browser is willing to install the PWA.
- SVG contract for any hand-made pictures: `viewBox` (any size), closed regions,
  white fill + black outlines ≥8px thick, no text/gradients/scripts, ≤60 KB.
  Drop the file into `app/public/images/<category>/` and add a catalog entry.

## Project conventions

- Web: npm + Vite, dev port **5199**. Python: **uv only** (no pip/brew/docker).
- Everything in the repo (code, comments, docs, UI) is English; catalog tags are
  multilingual data, not code.
- Git: personal repo `github.com/melnikaite/coloring` over SSH. Commit signing via
  1Password — if commits fail with "agent returned an error", unlock 1Password.
- `CLAUDE.md` files carry the working conventions for AI-assisted sessions.

# Coloriki — offline-first PWA coloring app for kids

Kids pick a coloring page from a gallery and paint it with brushes or flood fill.
Internet is needed only to fetch new images; coloring and saving work fully offline.
Deployed to Netlify as a static site. Everything (code, comments, docs, UI) is in English;
the UI is icon/emoji-driven with almost no text (kids can't read).

## Structure

- `app/` — the PWA: Vite + TypeScript, no framework. Canvas-based coloring engine.
- `app/public/images/` — coloring pages (optimized SVGs) + `catalog.json` (categories + image list).
- `generator/` — Python (uv-only) pipeline that generates new SVG coloring pages:
  - backend `banana`: Gemini 2.5 Flash Image (`GEMINI_API_KEY`) → PNG → threshold → vtracer → scour → SVG
  - backend `gemma`: local Gemma via LocalAI `http://127.0.0.1:1240/v1` (free, simple shapes only;
    always `reasoning_effort: "none"`, fall back to `reasoning_content`, strip markdown fences)

## SVG coloring page contract

- `viewBox="0 0 1024 1024"`, closed regions, `fill="#fff"` (or white-ish) + `stroke="#000"`,
  thick outlines (stroke-width 8–14), no gradients/scripts/text, target ≤ 50 KB after scour.
- The app rasterizes the SVG, extracts dark pixels as the line layer, and flood-fills regions,
  so every paintable area must be fully enclosed by dark lines.
- New images: drop SVGs into `app/public/images/<category>/` and add entries to `catalog.json`,
  then redeploy.

## Conventions

- Web app: npm + Vite (Node 24). Python: strictly uv, no Homebrew/apt/Docker.
- Dev server port: 5199 (many common ports are taken by OrbStack/LocalAI — see
  `~/.claude/new-project-conventions.md`).
- Git: personal repo (github.com/melnikaite) over SSH; gh CLI has NO access to personal repos.
  Commit signing via 1Password — if it fails with "agent returned an error", ask to unlock.

## Delegation

The main session is the orchestrator: it plans, reviews, and answers questions.
Delegate implementation to the `worker` agent using these rules:

- **Do it yourself (no delegation):** editing 1–2 files in a precisely known
  location, answering a question, reading a single file. Spawning an agent
  here is pure overhead.
- **Send a follow-up task to a live worker (SendMessage):** the next task
  touches the same code the worker just worked on, and no more than a couple
  of minutes have passed.
- **Spawn a new worker:** the topic/subsystem changed, the previous agent
  already completed a large task (its context is bloated), or the tasks are
  independent — in that case spawn several new workers in parallel.

After delegating, always review the resulting diff yourself.

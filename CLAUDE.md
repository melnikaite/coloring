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

## Live-testing after a code change (app/)

No automated tests exist for `app/` — every check is manual, live-browser testing.
Before trusting ANY test result against `npm run preview`/`npm run dev`, after rebuilding:

- **The service worker caches the JS bundle and does NOT auto-update.** `sw.js`'s own
  bytes rarely change between rebuilds, so the browser never detects "a new SW is
  available" and keeps running the OLD registered worker, which keeps serving the OLD
  hashed `/assets/*.js` from cache even though `dist/` now has a new hash. A plain
  reload, or even closing/reopening the tab, is NOT enough to pick up the new build.
- **Changing only the URL hash (`#/...`) is a same-document navigation** — the browser
  never re-fetches the JS bundle at all, so repeatedly "navigating" to test a fix can
  silently keep running code from the very first page load of the session.
- Before trusting a test: confirm the right bundle is actually loaded, e.g.
  `document.querySelector('script[type="module"]').src` and compare its hash to
  the one `npm run build` just printed. If it doesn't match: unregister the SW
  and clear caches (`(await navigator.serviceWorker.getRegistrations()).forEach(r=>r.unregister())`;
  `(await caches.keys()).forEach(k=>caches.delete(k))`), then do a real full navigation
  (a different path/query, not just a different hash) before re-testing.
- Symptom this produces if missed: a real fix looks like it "didn't work" (old buggy
  behavior persists) even though the source and build are correct — cost real time
  chasing a phantom bug once already.

## Delegation

The main session is the orchestrator: it plans, reviews, and answers questions.
Delegate implementation to the `worker` agent using these rules:

- **Confirm scope before implementing anything.** If it's ambiguous whether
  the user wants analysis/a plan or actual code changes — or they explicitly
  asked to "look into," "analyze," "think about," or "plan" something —
  default to analysis-only: present findings/a plan and stop. Never let "this
  looks easy" justify skipping that check; easy-looking tasks are exactly the
  ones that slip through unnoticed and burn tokens on unrequested work.
- **Do it yourself (no delegation) only if BOTH hold:** the edit touches 1–2
  files in a precisely known location, AND you're confident the current
  session's model is not pricier than the worker's fixed model. Don't just
  assume this — the system prompt states which model is running the
  session, but its price relative to the worker's fixed model may not be
  reliably known to you (pricing changes, model lineups change); when that
  comparison is uncertain, delegate rather than guess. If the orchestrator
  IS running on a more expensive tier than the worker, delegate even a
  small edit — the worker's fixed (cheaper) model doing the work costs less
  than the pricier orchestrator doing it directly, so "pure overhead" no
  longer holds. This matters most right when the user has deliberately
  switched the main session to a cheap/fast model for cost control — doing
  the work in-session instead of delegating defeats that choice.
- **Send a follow-up task to a live worker (SendMessage):** the next task
  touches the same code the worker just worked on, and no more than a couple
  of minutes have passed.
- **Spawn a new worker:** the topic/subsystem changed, the previous agent
  already completed a large task (its context is bloated), or the tasks are
  independent — in that case spawn several new workers in parallel.

After delegating, always review the resulting diff yourself.

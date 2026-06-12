# Screenshot pipeline

Regenerates every image under [`docs/`](../../docs) that the root README embeds —
from a fixed, **invented** dataset, so the screenshots show the whole UI without
ever exposing a real repo, path, commit, or person.

```bash
# one-time: a headless browser for the capture
npx playwright install chromium

npm run screenshots          # → writes docs/*.png
# or: node scripts/screenshots/capture.mjs
```

## How it works

The renderer is a plain React app that talks to the main process only through
`window.api` (see the architecture section of the root README). The pipeline
exploits that seam:

1. **`capture.mjs`** builds the real renderer bundle with Vite, serves it over
   `http://localhost`, and drives **headless Chromium** (`playwright-core`).
2. Before any page script runs, it injects a **mock `window.api`** whose every
   method returns canned data. No `git`, `gh`, Claude, `lsof`, or AppleScript is
   ever touched, so nothing personal can leak into a frame.
3. It loads each surface — the main window, the docked `#feed` and `#terminals`
   windows, and the modal dialogs — and screenshots it. A small capture-only
   stylesheet swaps the live macOS vibrancy for a solid backdrop and lets the
   scrollable panels flow to full height.

Because it renders the **real** components and CSS, the output is pixel-faithful
to the shipped app — it is only the *data* that is fake.

## Files

| File | What it is |
|---|---|
| `capture.mjs` | The harness: build → serve → inject → screenshot. Holds the `SHOTS` list. |
| `mock-data.mjs` | The fake dataset (`buildData()`). **Edit this when a panel's data shape changes.** |

## When you add or change a feature

1. **New/changed data on an existing panel** → update `mock-data.mjs` so the
   panel has something realistic to render. Keep it invented: repos live under
   `/Users/dev/...` in a fictional `northwind` GitHub org, with made-up commit
   messages and contributor names. Never paste in real data.
2. **A brand-new surface** (panel, dialog, docked window) → add an entry to the
   `SHOTS` array in `capture.mjs` (set `hash` for a docked window, `element` to
   clip to a node, `clipTo` to clip from the top down to a node, or `prep` to
   click something open first), then embed the new PNG in the root README.
3. Run `npm run screenshots` and eyeball the result.

## Notes

- `playwright-core` is a **devDependency only** — it never ships in the app.
- The Vite build lands in `out/.shots/` (gitignored); only the PNGs in `docs/`
  are committed.
- Dynamic timestamps mean the heatmap, "time ago" labels, and the next-event
  chip differ slightly run to run; that is expected.

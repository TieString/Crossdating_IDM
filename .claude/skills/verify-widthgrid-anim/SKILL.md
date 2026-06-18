---
name: verify-widthgrid-anim
description: Run/verify/screenshot the WidthGrid (WidthContainer) insert/shift animations headlessly. Use when changing the grid insert/delete/move animation, the cross-row/stationary classification in WidthContainer.tsx, or to confirm the first-width-column slide and the absence of ghost overlap after editing getVisualShiftTargets / getReoccupiedGhostTargetYears.
---

# Verify WidthGrid insert animation

`WidthContainer` is the tree-ring grid. Its insert animation reflows the whole
series when the first row is a full decade (start year offset 0): a new partial
row appears on top, every decade row drops one line, and the cells slide left.
The subtle bugs all live there (cells mis-flying, the first width column not
moving, a fading "source-exit ghost" overlapping the settled value at col0).

The real Tauri window can't be driven here (it loads `.rwl` via the native file
dialog, and WebView2 can't be scripted). But the edit logic
(`insertMissingYearAtSide`, `moveSeriesTailByOffset`) is pure, so we mount
`WidthContainer` in a tiny Vite harness with hardcoded offset-0 data and drive it
with Playwright + system Chrome. All paths below are relative to the repo root.

## Prerequisites (one-time)

- System Chrome (used via `channel: "chrome"` — no Playwright browser download).
- Playwright in the npx cache. Populate it once if missing:
  ```bash
  npx playwright@1.61 --version
  ```
  The driver finds it there automatically; it does not need to be in `node_modules`.

## Run (agent path)

One command. It auto-starts the Vite dev server (port **1420**) if it isn't already
running, copies the harness into the repo root so Vite serves it, performs an
insert-on-the-right at year 1805, captures a slowed (10×) screenshot burst, prints
PASS/FAIL, then removes the copied harness files.

```bash
node .claude/skills/verify-widthgrid-anim/assets/drive.cjs
```

- Screenshots + frames land in `.tmp-widthgrid-shots/` (gitignored). **Look at
  `00-before.png`, a mid frame (`f04_1400ms.png`), and `99-after.png`** — a blank
  or error frame means the harness didn't mount.
- Exit code is informational; the **`PASS`/`FAIL` line is the verdict**. (Node may
  report exit 0 even on FAIL — read the line, not `$?`.)
- Flags: `--year=1805` (where to insert), `--insert=slide-shift` (insert style:
  `slide-shift`|`pulse-shift`|`side-pop-shift`|`flight-shift`), `--start=1780`
  (`1780`=offset-0 full first row → reflow; `1785`=partial first row → no reflow),
  `--action=undo` (insert, let it settle, then exercise the **undo** animation —
  the history path whose ghost positions are reconstructed from the post-undo
  layout), `--speed=0.3`, `--keep` (leave the harness files in root for manual
  poking at `http://localhost:1420/harness.html`).
- Insert, delete, **double-click restore**, and **undo/redo** all share one
  `buildShiftPlan`/`buildHistoryShiftPlan` core (same cross-row classification +
  col0 fade-ghost). The driver directly drives live-insert and `--action=undo`;
  restore/redo follow the same code path (verify those by eye in the real app).

### What it checks (and why those are the regressions)

- **CHECK1 — first-column motion:** the col0 cell of each non-first, shifted row
  must slide (its `translateX` travels >20px toward 0). Expect `1780,1790,1800` to
  move; `1779` is the first-row anchor and `1810` is past the insert point, so they
  correctly stay. <2 movers ⇒ FAIL (regression of the "first width column doesn't
  move" complaint).
- **CHECK2 — left fade-out:** the leaving value at col0 is shown as a source-exit
  ghost (a `position:absolute` number span) that drifts in the shift direction and
  fades out, so col0 is never blank. The check asserts it (a) **exists** (`present`),
  (b) **fully fades** — no ghost still >0.15 opacity after the animation settles
  (`stuck@end=0`), and (c) never crosses left over the year-label column while still
  visibly opaque (`year-overlap(opaque)=0`).

## Tweak the scenario

The harness reads query params (the driver loads `/harness.html` with defaults):

- `?start=1785` — partial first row (offset 5) instead of the offset-0 full decade.
- `?speed=0.3` — less slow-mo (default `0.1` = 10× slow, best for frame capture).
- `?insert=flight-shift` — switch insert style (`slide-shift` default,
  `pulse-shift`, `side-pop-shift`, `flight-shift`).

The harness also wires `onMoveSeriesTailByOffset`, so move/drag can be driven by
extending the driver; only the insert flow is automated today.

## Gotchas

- **Vite runs on 1420, not 5173** — set in `vite.config.ts`.
- **The harness must live at repo root**, not inside the skill dir: Vite serves
  HTML from the project root, and `.claude/...` is dot-prefixed (not served). The
  driver copies `assets/harness.html` → `./harness.html` and
  `assets/insert-anim.tsx` → `./harness/insert-anim.tsx`, then deletes them on exit.
  The `@/` alias resolves regardless of the tsx's location.
- **`WidthContainer` renders with no scroll wiring** because it falls back to an
  800px viewport when no `scrollElement`/`scrollContainerRef` is passed
  (`effectiveHeight = viewport.height || 800`). No scroll container needed.
- **At `speed:0.1` the cross-row source-exit ghost lingers ~13s** — that's why the
  overlap is glaring in slow-mo screenshots and only briefly visible at speed 1.
- **`callChangeYearWidth` (double-click edit) goes through module-level Tauri code**
  — don't drive double-click editing in the harness; only the `+` insert button is
  pure-prop driven.

## Troubleshooting

- `playwright not found` → run `npx playwright@1.61 --version` once to populate the
  npx cache, then re-run the driver.
- `Vite dev server did not come up on :1420` → run `npm run dev` manually and watch
  for a port conflict or a compile error, then re-run the driver.
- Driver prints `PAGEERROR:` → the harness failed to mount (check the imported
  symbol names against `src/features/settings/settings.ts` /
  `src/features/rwl/edit.ts`; they may have been renamed).

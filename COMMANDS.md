# Commands

Everything runnable in this repo. See `README.md` for how the simulator works
and `COMMENTS.md` for what is unresolved.

## Setup

```bash
npm install
npx playwright install chromium    # only if you plan to use the CLI
```

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on http://localhost:3000 |
| `npm run build` | Production build |
| `npm start` | Serve the production build (needs `build` first) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

The app needs **WebGL2** and `EXT_color_buffer_float`. It reports a clear error
rather than rendering nothing if either is missing.

## Rendering from the command line

The simulation is WebGL2 end to end, so it cannot run in Node. The CLI drives
the real app in headless Chromium on the real GPU — what it renders is exactly
what a browser renders, rather than a second implementation that could drift.

**The dev server must already be running** in another terminal.

```bash
npm run render -- maze -o maze.png
npm run render -- ./patterns/mine.thr --detail 4096
npm run render -- Spiral6 --table 700 --ball 10 --backfill 0.5
```

The pattern argument is either a path or the name of one bundled in
`public/patterns` (with or without the `.thr`).

| Flag | Default | Meaning |
| --- | --- | --- |
| `-o`, `--out` | `<pattern>.png` | Output PNG |
| `--url` | `http://localhost:3000` | Where the app is served |
| `--detail` | `2048` | Heightfield resolution: `1024`, `2048` or `4096` |
| `--table` | panel default | Table diameter, mm |
| `--ball` | panel default | Ball diameter, mm |
| `--depth` | panel default | Groove depth, mm |
| `--ridge-width` | panel default | Ridge width, mm |
| `--ridge-buildup` | panel default | Share of displaced material in the ridge |
| `--backfill` | panel default | Bow-wave backfill; `0` means nothing ever erases |
| `--repose` | panel default | Angle of repose |

Parameters are injected by seeding the same `localStorage` blob the panel
writes, so the CLI cannot silently disagree with what the UI would produce.
Anything not passed falls back to the app's defaults, not to the settings you
happen to have saved.

`npm run render -- --help` prints the same reference.

## Checks

```bash
npm run check                    # exits non-zero if anything fails
npm run check -- --detail 1024   # faster
npm run check -- --backfill 0    # must FAIL — see below
```

Two checks, both driving the real app:

- **Batch invariance** — skip-to-end and played-through must be *pixel
  identical*, not close. The chunk decomposition is part of the physics, so this
  catches almost any accidental order- or batch-dependence. It has found more
  real bugs than anything else here.
- **Erasure** — a clear pattern run over a maze must resemble the clear pattern
  alone far more than it resembles the maze.

On failure the checker writes `check-erasure-expected.png` and
`check-erasure-actual.png` with the differences highlighted in red, so a red
result tells you *what* changed.

`npm run check -- --backfill 0` disables erasure entirely and **must fail**.
Run it whenever you touch the check itself — a test nobody has watched fail is
not yet a test.

## Test patterns

```bash
npm run test-patterns
```

Writes three synthetic `.thr` files to `public/patterns/test/` (gitignored, so
regenerate after a fresh clone). Load them like any other pattern. Each isolates
geometry that has broken the simulation:

| Pattern | Exercises |
| --- | --- |
| `straight.thr` | One uniform channel — any periodic structure along it is a batching artefact |
| `zigzag.thr` | 180° reversals, the turn geometry a per-chunk slab test gets wrong |
| `duplicate.thr` | Duplicated coordinates → zero-length segments with no direction |

Every bundled pattern is well-behaved, and more than one bug hid behind exactly
that. `duplicate.thr` reproduces the dropped-chunk bug instantly; no bundled
pattern does.

## Diagnosing an artefact

Two moves before theorising:

1. **Is it periodic?** Halve `MAX_SEGMENTS` in `src/sim/shaders.ts` and
   re-render. If the spacing halves, it is a batching artefact — no amount of
   tuning the sand model or blaming the pattern data will remove it.
2. **Is it in the data?** Tick **Show ball path** in the panel, which draws the
   resampled path as a bare polyline with no physics. If the feature is in the
   pink line, it is in the `.thr`.

## After changing the physics

```bash
npm run typecheck && npm run lint && npm run check
```

`npm run check` is the one that matters; typecheck and lint will not notice a
shader that produces the wrong sand.

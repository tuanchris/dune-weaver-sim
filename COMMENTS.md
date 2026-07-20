# Comments

Standing notes on this repo: what is unresolved, what is deliberately not done,
and where the bodies are buried. The README describes how the thing works; this
describes what I am not confident about.

## Known artefacts, unresolved

**A faint periodic spike survives on tightly-spaced patterns.** Visible on
`clear_sideway.thr` at high zoom as small light/dark slivers on the ridge, at
regular intervals along each groove. It is a batching artefact — halving
`MAX_SEGMENTS` halves its spacing — and it comes from the berm term reading
sand that a neighbouring chunk has already carved.

Confining each chunk's carve to its own slab removes it completely. That was
tried and reverted, because the slab's bounding planes fan apart wherever the
path turns and the outside of every turn ends up claimed by no chunk at all,
punching holes in the groove. See the README section on end caps. Any future
attempt needs to fix the berm's *temporal* dependence without restricting where
the carve may act.

At normal viewing distance this is invisible. It has not been chased further
because the cure has so far been worse than the disease.

**Moiré rosette at the table centre.** Where every stroke converges through
rho ≈ 0, the grooves interfere into a visible rosette. Probably genuine
undersampling — the strokes really do all pass through one point — but it has
not been investigated, and it may partly be a rendering artefact of the normal
estimate at high curvature.

**Faint stipple along overlapping grooves.** Noticed early, never diagnosed.
Distinct from the periodic spike above; shows up where two grooves cross at a
shallow angle.

## Deliberately not modelled

- **Feedrate.** The sand result depends on path geometry, not on how fast it was
  traced. Speed is a playback control only.
- **The machine's theta↔rho axis coupling.** The firmware compensates for it, so
  commanded (theta, rho) is the ball's true polar position. It affects motor
  motion, not where the sand ends up.
- **Volume conservation in backfill.** Backfill adds material that has to come
  from a bow wave the sim does not track. It is a tunable, not a measurement,
  and it will not survive contact with anyone expecting sand to be conserved.

## Defaults are a look, not a measurement

Nothing in the firmware or host repos records a real table radius or ball
diameter — everything there is normalised or in motor space. The shipped
defaults (700 mm table, 10 mm ball, and the sand parameters alongside them) were
tuned by eye to match how a real table looks. They are a starting point for the
table you care about, not hardware specs. Do not cite them as such.

## Testing

`npm run check` is the regression suite. Two checks, both driving the real app
in headless Chromium on the real GPU:

- **Batch invariance** — skip-to-end and played-through must be *pixel
  identical*, not close. The chunk decomposition is part of the physics, so this
  is sensitive to almost any accidental order- or batch-dependence. It has
  caught more real bugs than anything else here.
- **Erasure** — a clear pattern run over a maze must resemble the clear pattern
  alone far more than it resembles the maze.

The erasure check is deliberately *relative*. The obvious form ("must match the
clear alone within 2%") fails on correct output, because the ridges keep a faint
memory of what was underneath and with a narrow ridge that speckle alone is ~8%
of pixels. A threshold loosened until it passes would mean nothing; the ratio
moves hard when backfill actually regresses. Verify the check still bites with
`npm run check -- --backfill 0`, which disables erasure entirely and must fail.

**What is not covered.** There are no unit tests, nothing checks `thr.ts`
parsing directly, and nothing guards the UI. Everything that matters here is
visual, and the checks above are sampled renders — they will not catch a
regression that happens to miss those two patterns.

## Diagnosing artefacts

Two things worth reaching for before theorising:

1. **Is it periodic?** Halve `MAX_SEGMENTS` and re-render. If the spacing
   halves, it is a batching artefact, and no amount of tuning the sand model or
   blaming the pattern data will remove it. This identified every chunk bug
   found so far.
2. **Is it in the data?** Tick **Show ball path**, which draws the resampled
   path as a bare polyline with no physics. If the feature is in the pink line,
   it is in the `.thr`.

`node scripts/make-test-patterns.mjs` writes three synthetic patterns that each
isolate geometry which has broken the sim: a straight stroke, a zigzag of 180°
reversals, and a dense spiral with duplicated coordinates. Every bundled pattern
is well-behaved, and more than one bug hid behind exactly that.

## Sharp edges

- **Duplicate coordinates are common** in dense, image-derived patterns — one
  216k-coordinate file was almost entirely made of them. They produce
  zero-length segments with no direction. Any new geometry code that derives a
  direction from a segment must handle this; getting it wrong silently dropped
  whole chunks and left grooves stopping dead in open sand.
- **Berm deposition is additive and therefore not idempotent.** Carving is a
  `min` and can safely run twice; the berm cannot. Anything new that *adds* to
  the heightfield needs the same one-chunk-per-pixel guarantee.
- **Changing detail loses stacked sand.** Sand underneath the current pattern
  only exists as texels in the old GL context at the old resolution. Documented
  in the panel; fixable by reading back and resampling if it ever matters.
- **History is not persisted.** A single `.thr` runs to tens of thousands of
  lines and dropped files exist only as text in memory, so saving history means
  megabytes in a ~5 MB store. The safe version stores bundled samples by
  filename and dropped files only under a size budget.
- **Turbopack warns about the workspace root.** The parent directory is itself a
  git repo with its own lockfile. Harmless for dev; pin `turbopack.root` in
  `next.config.ts` if it ever resolves the wrong way.

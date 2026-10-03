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

**Sand is not conserved where the ball works a small closed area.** Found by
photographing a DW Pro (README, "Calibrated against a photo of a DW Pro"). The
carve removes sand, and the ridge and backfill add it back by rule, not by
volume. On the table, an eye traced inward heaped a mound in its middle and a
0.6-ball zigzag in a tooth-sized box heaped a raised block with a slot. The
simulator showed a spiral and chevrons. Backfill also adds sand on every
repeated pass, so a dense spiral renders paler than the bare floor it leaves on
the table. Judge small dense fills on the table.

Two fixes were tried and reverted. A conserving carve, which heaped the removed
cross-section half on each side as a ridge at the angle of repose, striated
long grooves and left blobs. Making the ridge continuous along the path did not
remove the pinches below. The calibrated ridge (2.5 mm at gain 2.6)
approximates the volume well enough away from closed areas.

**Chord pinches with a wide ridge.** With the calibrated 2.5 mm ridge, long
smooth curves (the rings of a clear pattern) show faint periodic pinches at the
path's vertices, about 22–25 mm apart. They are the polyline's chords: a 0.26 mm
sagitta is enough to move a wide ridge. The default 0.5 mm ridge hides them.

**The plow model (`model: 1`) is fitted, not derived.** Its rules (bow wave,
spill, dump at reversals, the wake and the slump) are a heightfield stand-in
for granular flow. Their settings were fitted to 3D granular physics (MPM) on
five small patches, checked on two more held out, and checked against one photo
of one table. These are its known gaps:

- **The references are imperfect.** The physics runs at 0.5 mm cells, so a
  quarter-ball spiral's 2.5 mm rings are only five cells apart; it shows the
  rings as thin ridges, while the photo shows broad ridges and thin slits.
  The physics also leaves about 1.5 mm of sand inside a side-to-side tooth
  fill that reads as a dark slot on the table. Where the two disagree, the
  photo is the arbiter, and it has the last word on fine pitch.
- **One setting serves opposite cases.** Spilling to the side already cut
  (`plowEven`) makes the strands between hair strokes and the rings of a
  spiral. The physics instead moves a spiral's sand outward, leaving its
  interior lower than the model does.
- **The reversal window is a compromise.** A side-to-side fill turns back
  through two right angles a quarter ball apart, so the detector compares
  headings half a ball apart. A spiral's first turn, under about 3 mm radius,
  also passes for a reversal and drops a small pile at its centre.
- **The look was limited by the shader.** With conserved sand the floor shows
  through less often than with the carve model. The ring render's fixed
  ambient fill kept shadowed sand from going as dark as the photo's slits, and
  plow renders had about half the photo's local contrast. `ambient` (0.04 in
  `dwpro-v4`) now reaches the photo's brightness range.
- **No GPU port.** The plan was to move it to fragment passes. At 2048 cells
  the CPU runs a 110 m pattern in about 9 s (32 s with the 4 sub-steps that
  remove the step zipper), so it stayed on the CPU, step for step, where the
  rules are easy to read and change.
- **Soft next to the photo.** With sub-steps the step seams are gone, but the
  renders are still softer than a photo of the table: they show no grain at the
  scale the photo does, and slumped slopes are smooth planes at repose. A finer grid does not help (4096 looks the same as 2048).
- **Flat tops between lines.** On the table every ridge in a drawing is a
  rounded hump between narrow slits. Two things made the simulator's look flat,
  and neither was the sand's physics. Fitting to plain RMSE chose a wide (5.5 mm)
  berm band, which spreads the moved sand into flat-topped bands; a fit that
  lets each tile shift a millimetre picks 2 mm. And the toned ring render
  clipped every lit slope to the same white and banded every trough dark (sand
  colour above 1, a 2 mm floor cover), where the heights themselves were
  rounded humps. What remains is light: the table photos are lit from one side
  (room light, the camera), and the simulated ring lights evenly.
- **Spirals hold only in the full fit.** Fitted on five patches with the
  outlined tooth and the spiral held out, the mound piles improve the held-out
  tooth (0.60 against 0.66 mm) but not the spiral (0.59 against 0.53 mm).
  `dwpro-v4` is fitted on all seven.

- **Only the turn piles bury.** With `plowHeap` the pile at a reversal fills
  what lies under it, as the physics does. The ridges shed along a stroke
  (`plowShed`, the berm band) are still laid on top, so a later line's berm
  over older grooves leaves them as dips; no physics patch tests that yet. The
  heap also fills the older slit a little more than the physics on the turn's
  axis (`bury`: floor -0.66 mm against -1.43), and on the beaver v17 photo the
  caps at hair tips are fuller lobes than the heap's crescents.

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
table you care about, not hardware specs. Do not cite them as such. The DW Pro
set in the README was measured, but against a single photo of one table.

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

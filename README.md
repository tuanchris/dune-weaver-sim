# Dune Weaver — sand simulator

Takes a `.thr` (theta-rho) pattern and renders what the sand will actually look
like on the table after playing it. The ball plows a groove, pushes displaced
sand into ridges along the edges, and later passes cut through and erase what
came before.

```bash
npm install
npm run dev      # http://localhost:3000
```

Needs a browser with **WebGL2** and `EXT_color_buffer_float`. The app reports a
clear error rather than rendering nothing if either is missing.

Simulating a full pattern takes ~75 ms (4.7k segments) to ~350 ms (39k segments)
on an M4 Max, measured with a forced GPU sync. "Skip to end" is effectively
instant, and playback is limited by the chosen duration rather than by the
simulation. Live parameter dragging re-runs the whole pattern, so on the largest
patterns it updates at roughly 3 fps rather than continuously.

## Using it

- Pick a bundled pattern, or drop any `.thr` file onto the table.
- **Play / Skip to end** — watch it draw, or jump straight to the final state.
  Once it finishes, the button becomes **Replay**, which rewinds to the sand as
  it was before this pattern started and runs it again.
- **Table / ball diameter** in mm. Every sand control re-runs the simulation
  live as you drag it.
- **Keep existing sand** — load the next pattern *without* clearing, so you see
  it partially erase the previous one. This is what a playlist without a clear
  pattern between entries actually looks like.
- **History** — every pattern you load is kept in a list, newest first, and
  clicking one re-runs it. The file's *text* is kept rather than its name, so a
  dropped file replays exactly like a bundled sample does; loading something
  already in the list moves it to the top instead of adding a duplicate.
- **Clear table** — levels the sand by hand. Distinct from the `clear_*.thr`
  patterns, which are real ball paths that sweep the sand flat and leave their
  own tracks behind. This leaves nothing.
- **Export PNG** — saves the current frame.
- **Show ball path** — overlays the resampled path as a bare polyline, with no
  physics and no shading. The fastest way to tell a simulation artefact from a
  feature that is simply present in the pattern data: if it shows up in the pink
  line, no amount of tuning the sand model will remove it.

## Dimensions, live editing and replay

Table and ball are specified in **millimetres**. Internally both are divided by
the table radius to give the normalised units the shaders work in, so only their
*ratio* affects the result — a 5 mm ball on a 200 mm table renders identically
to a 10 mm ball on a 400 mm one. The panel shows the derived ratio so that is
visible rather than surprising. Groove depth is clamped to the ball radius,
since a ball cannot sit deeper than that without its widest point going under
the sand, which the spherical-cap profile doesn't model.

Lighting controls only change how the existing heightfield is shaded, so they
just trigger a redraw. The sand controls change what the heightfield *is*, so
they re-run the pattern from its starting sand, which is fast enough to feel
live on most patterns (see the timings above). Re-simulations are coalesced to one per animation
frame, so dragging a slider doesn't queue a full run per input event.

Both replay and live editing rely on a third `base` texture holding the sand as
it stood when the current pattern was loaded. That is what makes re-running
non-destructive when a pattern was drawn over an earlier one: the sim rewinds to
the previous pattern's result, not to flat sand.

## Detail, and why it is nearly free

The sand bed is a floating-point heightfield (`R32F`) held in GPU textures, at
1024², 2048² or 4096² — **Draft / Fine / Max**, defaulting to Fine.

The intuitive expectation is that each step up costs 4× the time, since it is 4×
the pixels. Measured, it costs almost nothing: Spiral 6 runs in 346 / 354 /
351 ms across the three levels, flat within noise. A carve pass shades only the
few hundred texels its chunk's bounding box covers, so resolution barely touches
the fill cost, and a run is dominated by per-chunk overhead instead — about
4,800 passes for a 39k-segment pattern, each with its own uniform uploads, draw
and blit. The only pass that genuinely scales with area is the full-field
relaxation, and it runs once per 512 segments. What detail *does* cost is
memory: three full-field targets are live at once, so 12 / 50 / 201 MB.

Path resampling is tied to resolution, so a finer heightfield isn't just
rendering a smoother picture of a path that is still faceted. In practice this
changes almost nothing — Spiral 6 gains 0 segments between Draft and Max and
Hubcap gains 13 — which is itself the useful result: **the paths were already
well inside tolerance, and resolution was the thing limiting fidelity.**

Two things had to be pinned to table space rather than texels, or raising detail
would have changed the look instead of just sharpening it: the ambient-occlusion
sampling radius (in texels it would shrink as resolution rose, quietly flattening
every groove's shading) and the flat-sand grain rate (hard-coded, it was noisier
than the grid at 1024 and smoother than it at 4096).

Resolution can't be changed in place — the heightfield textures are immutable
storage — so it rebuilds the sim and re-runs the current pattern, restoring the
playback position it was at. Sand *underneath* the current pattern cannot come
across, since it only exists as texels in the old context at the old resolution.
Stacking patterns and then changing detail loses the stack.

World space and clip space are the same thing — the table is the unit disc — so
a carve pass only shades the region its segments touch.

## How the simulation works

**Carve pass** (`src/sim/shaders.ts`, `CARVE_FRAG`). A fixed batch of
consecutive path segments is rasterised at once, and each pixel takes the distance to the
nearest segment treated as a *capsule*. Using capsules rather than per-point
stamps means a fast-moving ball still cuts one continuous groove instead of a
dotted line.

Inside the ball footprint the surface is pushed down to the ball's spherical
underside. Just outside it, material is deposited as a ridge, and the amount
deposited is proportional to how much was actually displaced nearby, sampled
back out of the height texture. That coupling is what keeps ridges honest:
plowing virgin sand throws up a tall ridge, while re-tracing an existing groove
barely disturbs it.

**Backfill.** Carving alone is not enough to erase anything. If the pass is a
pure `min`, a new groove crossing an *older, deeper* one leaves it untouched
forever, so a clear pattern can never actually clear — verified directly: with
carve-only, running `clear_from_out.thr` over `maze.thr` left the maze plainly
readable even though the clear pattern's footprint covers 100% of the disc. In
reality the ball pushes a bow wave of loose sand ahead of it, and that material
drops into depressions it crosses. So where the existing surface is already
below the ball, the height is lerped *up* toward the ball floor by the
**Backfill** amount. This is the single parameter that controls whether patterns
erase each other; at 0 nothing is ever erased.

Backfill deliberately does not conserve volume — it adds material that has to
come from the bow wave the sim doesn't track. It is a tunable, not a
measurement.

### End caps are a batching artefact — but only partly

A chunk's capsule has rounded caps at each end, and the *plane* through each cap
is fiction: the real ball never stops and lifts there. The non-idempotent terms
(backfill, berm) are therefore tested against the chunk's entry and exit planes,
so each pixel is acted on by exactly one chunk. The carve is not, and the
distinction is the whole point of this section.

Getting it right took three attempts, and all three are worth recording because
each looked correct and each left a *periodic* stipple along every groove:

1. **Backfill past a cap.** Behind a chunk's start cap the sand is the groove
   the previous chunk just cut, already at full depth and therefore below the
   cap's spherical surface. Backfill reads that as an older, deeper groove and
   lifts the floor, stamping a ball-sized plug at every boundary.
2. **Berm past a cap.** Berm deposition is `h + …`, so unlike the carve it is
   *not* idempotent, and every pixel must be claimed by exactly one chunk. A
   pixel near a boundary is within berm range of both the outgoing chunk's last
   segment and the incoming chunk's first, so it got a double dose; the rounded
   cap also sprayed a berm arc across the groove just cut.
3. **Carve past a cap — tried, and reverted.** Confining the carve to the slab
   as well removed the last of the periodic spikes, and was wrong. The cap
   *plane* is a batching artefact, but the cap *disc* is not: the ball really is
   centred on that point at that instant, so the disc lies inside the true swept
   region and carving it is always correct. Because a chunk's slab is bounded by
   two planes that fan apart wherever the path turns, confining the carve leaves
   the outside of every turn claimed by no chunk at all, and the groove develops
   holes. Carving is a `min` over a region that is always a subset of the true
   swept path, so it never needs a guard; only the non-idempotent terms
   (backfill, berm) do.

**Degenerate segments.** A repeated coordinate gives a zero-length segment with
no direction, and dense image-derived patterns repeat coordinates freely — one
216k-coordinate pattern was almost entirely made of them. Two separate bugs live
here. Deriving a plane from a zero direction lets `dot(anything, vec2(0.0)) == 0.0`
answer the past-the-cap question, which under a non-strict comparison is true for
every pixel on the table and silently drops the whole chunk: grooves stop dead in
open sand. But merely *disabling* the plane isn't enough either — the chunk then
deposits berm past its boundary and double-doses with its neighbour, blipping at
exactly the duplicated points. The plane has to come from the nearest segment
that does have a direction, searched backwards from the boundary (bounded, so a
long run of duplicates can't make it quadratic).

The planes also have to be shared. Each is defined by the segment *entering* its
boundary point, so two chunks meeting at a boundary derive the identical plane
and their slabs tile the path with no gap and no overlap. Deriving the start
plane from a chunk's own first segment instead — the obvious way to write it —
gives the two chunks different normals wherever the path curves, leaving a wedge
neither claims on the outside of a turn and one both claim on the inside.

**Diagnosing this class of bug:** the signature is periodicity. If a defect
repeats at a fixed interval along a groove, halve `MAX_SEGMENTS` and re-render.
If the spacing halves, it is a batching artefact and nothing about the pattern
data or the sand parameters will remove it. That test is much faster than
reasoning about the shader, and it is what identified these in the first place.

A faint periodic spike does survive on the tightest patterns. Removing it is
what item 3 above was trying to do, and the cure was worse than the disease.

**Test patterns.** `node scripts/make-test-patterns.mjs` writes three synthetic
`.thr` files to `public/patterns/test/`, each isolating geometry that broke the
sim at some point: a single straight stroke, a zigzag of 180° reversals, and a
dense spiral with every eighth coordinate duplicated. Drop one on the table like
any other pattern. They exist because every bundled pattern is well-behaved, and
each of these bugs hid behind that.

### Front-authoritative targets

`front` is authoritative at all times and `back` is pure scratch: a pass draws
into `back`, then only the rectangle it actually touched is blitted back into
`front`. The quad is snapped to whole texels so the drawn set and the
copied-back set are exactly the same pixels — rounding the copy rectangle
outward "for safety" instead hands `front` a one-texel border the draw never
wrote, i.e. whatever an earlier unrelated chunk left in the scratch texture.
That leak was worth ~0.2% of pixels, as thin wrong-height lines tracing every
chunk's bounding box. True ping-ponging would be wrong here, because a carve pass draws just
the quad its segments touch and so does not write every pixel — after a swap,
everything outside that quad would still hold state from two swaps ago,
silently resurrecting old sand and discarding roughly half the carve work.
Seeding the destination with a full-field copy before every pass fixes that but
costs a whole-field blit per chunk; folding back only the touched rectangle
gets the same correctness for a fraction of the bandwidth.

### Chunking is part of the physics

Segments are carved in fixed batches of `MAX_SEGMENTS`, always aligned to the
same multiples, no matter whether a frame asks for two segments or `runToEnd`
asks for thousands. That alignment is not tidiness — it is required for
correctness. The carve reads the height texture, so every segment within one
chunk sees the same starting state while a later chunk sees the earlier one's
result. The chunk decomposition therefore *is* part of the simulation, and
letting it vary with playback speed made a pattern look materially different
depending on whether it was played through or skipped to the end. `advance`
carries a fractional segment budget so callers can ask for any amount without
changing the decomposition.

The angle-of-repose pass had to be keyed to path length rather than pass count
for the same reason (`RELAX_EVERY_SEGMENTS`); scheduled per pass, it ran ~32×
more often during slow playback than during a skip.

Playing a pattern through and skipping to the end are now **bit-identical** —
verified by comparing rendered pixels across playback speeds, 0 differing
pixels. That equality is the regression test worth keeping: it is sensitive to
almost any accidental order- or batch-dependence in the physics.

**Relaxation pass** (`RELAX_FRAG`). Sand can't hold an arbitrarily steep face, so
where the slope between adjacent cells exceeds the angle of repose, material
flows downhill. Written in gather form (each cell computes its own net change
from its neighbours) so it is symmetric and conserves volume instead of drifting
over many iterations.

**Render pass** (`RENDER_FRAG`). The look is almost entirely a low grazing key
light — at a shallow elevation a groove a fraction of a millimetre deep casts a
long soft shadow, which is why real sand tables photograph so well. On top of
that: wrapped diffuse (sand scatters, so terminators are soft), ambient
occlusion from height relative to a wider neighbourhood, and a fine grain
applied as a *normal* perturbation rather than a colour speckle, so it catches
the light like real grains instead of looking like film noise.

The table is drawn rotated 180° from heightfield space to match the orientation
the physical table is viewed in. The surface normal is rotated along with it —
without that the geometry turns but the shading doesn't, which lights every
groove from the wrong side and makes the pattern read as embossed rather than
engraved.

## Matching the real table

Path geometry follows the firmware and host software so the sim traces the same
path the machine would (`src/lib/thr.ts`):

- **theta is cumulative and unwrapped** — a 5-revolution spiral ends near 31.4,
  not wrapped into `[0, 2π)`. Leading whole revolutions are stripped so the
  first coordinate lands in `[0, 2π)`, matching `ThrTranslator.cpp` and
  `pattern_manager.py`. A leading `0 0` "move to center" preamble is skipped
  when picking the theta reference, or patterns starting at center would have
  their rotation zeroed.
- Python's `%` returns a non-negative result for a positive modulus and
  JavaScript's does not. The offset calculation replicates the Python behaviour
  explicitly — using native `%` would mis-rotate every pattern with negative
  theta, which is most of them.
- **Motion between coordinates is linear in (theta, rho), not in x/y.** In
  Cartesian that traces an Archimedean spiral arc, so the path is subdivided in
  polar space before projecting. Interpolating straight in x/y would visibly cut
  corners on long moves.
- rho is clamped to `[0, 1]` as the firmware does, so a stray value can't throw
  the ball outside the table.
- **rho = 1 is the ball centre at its outermost, not the table edge.** The ball
  is touching the wall at that point, so its centre reaches only one ball radius
  short of the wall, and path coordinates are scaled by `1 - ballRadius`
  accordingly. This matters more than it sounds: every turn in a sideways clear
  happens at rho > 0.99, so getting it wrong parks all of them on the rim where
  the edge treatment hides them.

The machine's theta↔rho axis coupling is deliberately *not* modelled: the
firmware compensates for it, so commanded (theta, rho) is the ball's true polar
position. It affects motor motion, not where the sand ends up.

### Not modelled

Physical table and ball dimensions aren't recorded anywhere in the firmware or
host repos — everything there is normalised or in motor space. The defaults
(400 mm table, 11 mm ball) are placeholders to be set for the table you care
about, not measurements taken from the hardware.

Feedrate is ignored: the sand result depends on path geometry, not on how fast
it was traced.

## Layout

| Path | What |
| --- | --- |
| `src/lib/thr.ts` | `.thr` parsing, theta normalisation, polar resampling |
| `src/sim/shaders.ts` | GLSL: carve, relax, reset, render |
| `src/sim/SandSim.ts` | WebGL2 heightfield, front/scratch/base targets, transport |
| `src/components/SandTable.tsx` | UI, playback loop, parameter controls |
| `public/patterns/` | Sample patterns copied from the `dune-weaver` repo |
| `public/patterns/test/` | Generated diagnostics — gitignored, run the script |
| `scripts/make-test-patterns.mjs` | Generates the synthetic test patterns |

`playwright` is a devDependency used to drive the app in a real GPU browser and
screenshot renders for verification. There is no automated test suite; the
checks that matter here are visual, and the two worth re-running after any change
to the physics are:

- **Batch invariance.** Render a pattern with "Skip to end", then again played
  through at each speed, and compare the canvases pixel for pixel. They must be
  *identical* — 0 differing pixels, not "close". This is sensitive to almost any
  accidental order- or batch-dependence in the physics, and it has caught more
  real bugs than anything else here.
- **Erasure.** Load `maze.thr`, tick **Keep existing sand**, then run
  `clear_from_out.thr`. The maze must be completely gone.

/**
 * Generates the synthetic .thr patterns used to test the simulation.
 *
 * These exist because the bundled patterns are all well-behaved, and every
 * batching bug found so far hid behind that. Each one isolates a single piece
 * of geometry that broke the sim at some point:
 *
 *   straight   — one radial stroke, constant theta. Should be a single uniform
 *                channel, so ANY periodic structure along it is an artefact of
 *                how the path was batched.
 *   zigzag     — 180° reversals at both ends of each spoke. Exercises the turn
 *                geometry that a per-chunk slab test gets wrong: planes fan
 *                apart at a turn and can leave the outside of it claimed by no
 *                chunk, punching holes in the groove.
 *   duplicate  — a dense spiral with every 8th coordinate repeated, giving
 *                zero-length segments with no direction. Dense image-derived
 *                patterns are full of these. Reproduces the dropped-chunk bug
 *                (grooves that stop dead in open sand) instantly; no bundled
 *                pattern does.
 *
 * Output is deterministic — no randomness, no timestamps — so a render of one
 * of these can be compared against a previous render pixel for pixel.
 *
 *   node scripts/make-test-patterns.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'patterns', 'test');

/** One straight radial stroke at constant theta. */
function straight() {
  const lines = [];
  for (let k = 0; k <= 400; k++) lines.push(`0.00000 ${(0.05 + 0.9 * (k / 400)).toFixed(5)}`);
  return lines;
}

/** Radial spokes joined by hard 180° reversals at the rim and near the centre. */
function zigzag() {
  const lines = [];
  let theta = 0;
  for (let i = 0; i < 60; i++) {
    const [lo, hi] = i % 2 === 0 ? [0.15, 0.95] : [0.95, 0.15];
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      lines.push(`${(theta + 0.1 * t).toFixed(5)} ${(lo + (hi - lo) * t).toFixed(5)}`);
    }
    theta += 0.1;
  }
  return lines;
}

/** Dense spiral, every 8th coordinate repeated to create degenerate segments. */
function duplicate() {
  const lines = [];
  const n = 6000;
  for (let i = 0; i < n; i++) {
    const line = `${(i * 0.02).toFixed(5)} ${(0.12 + (0.85 * i) / n).toFixed(5)}`;
    lines.push(line);
    if (i % 8 === 7) lines.push(line);
  }
  return lines;
}

mkdirSync(OUT, { recursive: true });
for (const [name, gen] of Object.entries({ straight, zigzag, duplicate })) {
  const lines = gen();
  writeFileSync(join(OUT, `${name}.thr`), `${lines.join('\n')}\n`);
  console.log(`${name}.thr — ${lines.length} coords`);
}

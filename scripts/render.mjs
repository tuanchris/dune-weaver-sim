/**
 * Headless renderer and regression checker for the sand simulator.
 *
 * The simulation is WebGL2 end to end — SandSim takes a canvas and every pass
 * is a GPU draw into float textures — so there is no way to run it in Node
 * without a GL context. This drives the real app in headless Chromium instead,
 * on the real GPU, which means what it renders is exactly what a browser
 * renders rather than a second implementation that could drift.
 *
 *   node scripts/render.mjs maze.thr -o maze.png
 *   node scripts/render.mjs ./mine.thr --detail 4096 --table 700 --ball 10
 *   node scripts/render.mjs --check
 *
 * Parameters are injected by seeding the same localStorage blob the panel
 * writes, rather than by driving sliders through the DOM: one code path, and it
 * cannot silently disagree with what the UI would have produced.
 *
 * Requires a dev server (npm run dev). Exits non-zero if a check fails.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const STORAGE_KEY = 'dune-weaver-sim:settings:v1';
const BUNDLED = join(process.cwd(), 'public', 'patterns');

// --- argument parsing ------------------------------------------------------

const FLAGS = {
  '--out': 'out', '-o': 'out',
  '--url': 'url',
  '--detail': 'detail',
  '--table': 'tableDiameterMm',
  '--ball': 'ballDiameterMm',
  '--depth': 'depthMm',
  '--ridge-width': 'bermWidthMm',
  '--ridge-buildup': 'bermGain',
  '--backfill': 'fill',
  '--repose': 'reposeSlope',
};

function parseArgs(argv) {
  const opts = { sand: {}, check: false, url: 'http://localhost:3000', detail: 2048 };
  let pattern = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    const key = FLAGS[a];
    if (key) {
      const raw = argv[++i];
      if (raw === undefined) throw new Error(`${a} needs a value`);
      if (key === 'out' || key === 'url') opts[key] = raw;
      else if (key === 'detail') opts.detail = Number(raw);
      else {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${a} needs a number, got "${raw}"`);
        opts.sand[key] = n;
      }
      continue;
    }
    if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    pattern = a;
  }
  opts.pattern = pattern;
  return opts;
}

const USAGE = `
Usage
  node scripts/render.mjs <pattern.thr> [options]
  node scripts/render.mjs --check

Renders a .thr the way the browser does and writes a PNG. The pattern may be a
path, or the name of one bundled in public/patterns.

Options
  -o, --out <file>     output PNG (default: <pattern>.png)
      --url <url>      app URL (default: http://localhost:3000)
      --detail <n>     heightfield resolution: 1024, 2048 or 4096 (default 2048)
      --table <mm>     table diameter          --ball <mm>          ball diameter
      --depth <mm>     groove depth            --ridge-width <mm>   ridge width
      --ridge-buildup <n>                      --backfill <n>
      --repose <n>     angle of repose
      --check          run the regression checks instead of rendering

Checks
  batch invariance   skip-to-end and played-through must be pixel-identical
  erasure            a clear pattern over a maze must resemble the clear far
                     more than the maze (falsify it with --backfill 0)
`.trim();

// --- page helpers ----------------------------------------------------------

/** Resolve a pattern argument to an absolute path. */
function resolvePattern(name) {
  for (const candidate of [resolve(name), join(BUNDLED, name), join(BUNDLED, `${name}.thr`)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no such pattern: ${name}`);
}

async function openApp(url, { detail, sand }) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  page.on('pageerror', (e) => { throw new Error(`page error: ${e.message}`); });

  await page.goto(url, { waitUntil: 'networkidle' });
  // Seed the panel's own storage, then reload so the app restores from it.
  // Partial sand is fine: the app merges over its defaults key by key.
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, JSON.stringify(value)),
    [STORAGE_KEY, { sand, resolution: detail }],
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(800); // GL init
  return { browser, page };
}

async function loadPattern(page, file) {
  const input = page.locator('input[type=file]');
  // Clear first: re-selecting the same path is not a change, so the app would
  // never see an event and would sit on the previous pattern's finished state.
  await input.setInputFiles([]);
  await input.setInputFiles(file);
  // "Play" appears only once progress has reset, which is the real signal that
  // this pattern — not the last one — is loaded and unstarted.
  await page.getByRole('button', { name: 'Play', exact: true })
    .waitFor({ state: 'visible', timeout: 30_000 });
}

/** Run to completion, either instantly or by playing at a given speed. */
async function simulate(page, { play = null } = {}) {
  if (play) {
    await page.getByRole('button', { name: play, exact: true }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Skip to end' }).click();
  }
  // The transport reads "Replay" only once the pattern has finished.
  await page.getByRole('button', { name: 'Replay', exact: true })
    .waitFor({ state: 'visible', timeout: 120_000 });
}

/**
 * Stash the current canvas in the page under a name.
 *
 * Kept in the page on purpose: a 4096² frame is 67 M samples, which is far too
 * much to serialise over the CDP bridge just to diff it.
 */
const stash = (page, name) => page.evaluate((key) => {
  const c = document.querySelector('canvas');
  const o = document.createElement('canvas');
  o.width = c.width; o.height = c.height;
  o.getContext('2d').drawImage(c, 0, 0);
  window.__frames ??= {};
  window.__frames[key] = o.getContext('2d').getImageData(0, 0, c.width, c.height).data;
}, name);

/** Compare two stashed frames. `tolerance` is per channel, 0 = exact. */
const compare = (page, a, b, tolerance = 0) => page.evaluate(([ka, kb, tol]) => {
  const x = window.__frames[ka], y = window.__frames[kb];
  let differing = 0, max = 0;
  for (let i = 0; i < x.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(x[i + c] - y[i + c]));
    if (d > max) max = d;
    if (d > tol) differing++;
  }
  return { pct: (differing / (x.length / 4)) * 100, max };
}, [a, b, tolerance]);

const savePng = async (page, out) => {
  const url = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
};

/**
 * Write a stashed frame, or a red-highlighted diff of two, to a PNG.
 *
 * A failing check that only prints a percentage tells you something changed but
 * not what, which is the difference between a five-minute diagnosis and an hour.
 */
const saveStash = async (page, keys, out) => {
  const url = await page.evaluate(([ka, kb]) => {
    const src = window.__frames[ka];
    const other = kb ? window.__frames[kb] : null;
    const n = Math.sqrt(src.length / 4);
    const o = document.createElement('canvas');
    o.width = n; o.height = n;
    const img = new ImageData(new Uint8ClampedArray(src), n, n);
    if (other) {
      for (let i = 0; i < src.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(src[i + c] - other[i + c]));
        if (d > 8) { img.data[i] = 255; img.data[i + 1] = 40; img.data[i + 2] = 90; }
      }
    }
    o.getContext('2d').putImageData(img, 0, 0);
    return o.toDataURL('image/png');
  }, keys);
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
};

// --- commands --------------------------------------------------------------

async function render(opts) {
  const file = resolvePattern(opts.pattern);
  const out = opts.out ?? `${basename(file).replace(/\.thr$/i, '')}.png`;
  const { browser, page } = await openApp(opts.url, opts);
  try {
    await loadPattern(page, file);
    const started = Date.now();
    await simulate(page);
    await savePng(page, out);
    const status = (await page.locator('p.font-mono').first().textContent())?.trim();
    console.log(`${status}\n${out} — ${opts.detail}², ${Date.now() - started} ms`);
  } finally {
    await browser.close();
  }
}

/** Backfill the erasure check pins, regardless of what the defaults are. */
const ERASURE_FILL = 0.7;

async function check(opts) {
  // openApp overwrites the stored settings, so the checks are isolated from
  // whatever the person running them last left in the panel.
  //
  // Backfill is pinned rather than inherited: the shipped default is
  // deliberately low, so patterns only partly erase each other and a
  // full-erasure assertion would fail by design. What is being tested here is
  // that the backfill mechanism still works at all — at 0 nothing is ever
  // erased, and that is the regression worth catching.
  const { browser, page } = await openApp(opts.url, {
    ...opts,
    // An explicit --backfill still wins, so the check can be falsified on
    // demand: `--check --backfill 0` disables erasure entirely and must fail.
    sand: { fill: ERASURE_FILL, ...opts.sand },
  });
  const results = [];
  try {
    // 1. Batch invariance. The chunk decomposition is part of the physics, so
    //    skipping to the end and playing through must agree EXACTLY. This is
    //    sensitive to almost any accidental order- or batch-dependence.
    for (const pattern of ['clear_sideway.thr', 'maze.thr']) {
      const file = resolvePattern(pattern);
      await loadPattern(page, file);
      await simulate(page);
      await stash(page, 'skip');

      for (const speed of ['1s', '5s']) {
        await loadPattern(page, file);
        await simulate(page, { play: speed });
        await stash(page, 'played');
        const { pct, max } = await compare(page, 'skip', 'played');
        results.push({
          name: `batch invariance · ${pattern} · skip vs ${speed}`,
          ok: pct === 0 && max === 0,
          detail: `${pct.toFixed(3)}% of pixels differ, max channel diff ${max}`,
        });
      }
    }

    // 2. Erasure. A clear pattern run over a maze must leave the same table as
    //    the clear pattern run on flat sand. If backfill regresses, the maze
    //    survives underneath and this diverges.
    await loadPattern(page, resolvePattern('clear_from_out.thr'));
    await simulate(page);
    await stash(page, 'clearAlone');

    await loadPattern(page, resolvePattern('maze.thr'));
    await simulate(page);
    await stash(page, 'mazeAlone');
    await page.getByRole('checkbox').first().check(); // Keep existing sand
    await loadPattern(page, resolvePattern('clear_from_out.thr'));
    await simulate(page);
    await stash(page, 'clearOverMaze');

    // Relative, not absolute. Erasure is a physical process: the ridges keep a
    // faint memory of what was underneath, and with a narrow ridge that speckle
    // alone runs to ~8% of pixels — so "must match the clear alone within 2%"
    // fails on correct output, and loosening it until it passes would leave a
    // number that means nothing.
    //
    // What actually matters is that the result looks like the clear pattern and
    // NOT like the maze. If backfill regresses to 0 the maze survives intact,
    // toMaze collapses and toClear jumps, so the ratio moves hard in a way a
    // single threshold cannot fake.
    const toClear = await compare(page, 'clearOverMaze', 'clearAlone', 8);
    const toMaze = await compare(page, 'clearOverMaze', 'mazeAlone', 8);
    const ok = toClear.pct * 4 < toMaze.pct;
    if (!ok) {
      await saveStash(page, ['clearAlone', null], 'check-erasure-expected.png');
      await saveStash(page, ['clearOverMaze', 'clearAlone'], 'check-erasure-actual.png');
    }
    results.push({
      name: `erasure · clear over maze (backfill ${opts.sand.fill ?? ERASURE_FILL})`,
      ok,
      detail: `${toClear.pct.toFixed(1)}% unlike the clear vs `
        + `${toMaze.pct.toFixed(1)}% unlike the maze — needs a 4× margin`
        + (ok ? '' : ' — see check-erasure-*.png, differences in red'),
    });
  } finally {
    await browser.close();
  }

  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}\n      ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
}

// --- entry -----------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (opts.help || (!opts.check && !opts.pattern)) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}
if (![1024, 2048, 4096].includes(opts.detail)) {
  console.error(`--detail must be 1024, 2048 or 4096 (got ${opts.detail})`);
  process.exit(1);
}

try {
  const res = await fetch(opts.url).catch(() => null);
  if (!res?.ok) {
    console.error(`Cannot reach ${opts.url} — start the app first with: npm run dev`);
    process.exit(1);
  }
  await (opts.check ? check(opts) : render(opts));
} catch (e) {
  console.error(`${e.message}`);
  process.exit(1);
}

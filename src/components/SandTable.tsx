'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { parseThr, resamplePath } from '@/lib/thr';
import {
  DEFAULT_RENDER,
  DEFAULT_SAND,
  SandSim,
  type RenderParams,
  type SandParams,
} from '@/sim/SandSim';

const SAMPLES = [
  { label: 'Hubcap', file: '0-1-hubcap.thr' },
  { label: 'Maze', file: 'maze.thr' },
  { label: 'Spiral 6', file: 'Spiral6.thr' },
  { label: 'Starry Night', file: 'StarryNight.thr' },
  { label: 'Clear — from in', file: 'clear_from_in.thr' },
  { label: 'Clear — from out', file: 'clear_from_out.thr' },
  { label: 'Clear — sideways', file: 'clear_sideway.thr' },
];

/**
 * Playback speed as a target wall-clock duration rather than segments per
 * frame. Patterns range from ~4.7k to ~36k segments, so a fixed per-frame
 * budget makes short patterns flash past and long ones crawl.
 */
const SPEEDS = [
  { label: '60s', seconds: 60 },
  { label: '20s', seconds: 20 },
  { label: '5s', seconds: 5 },
  { label: '1s', seconds: 1 },
];

/**
 * Heightfield resolution.
 *
 * Each step up is 4× the texture memory — three full-field R32F targets are
 * live at once, so 12 MB / 50 MB / 201 MB. It is *not* 4× the time, which is
 * the intuitive guess and is wrong: a carve pass shades only the few hundred
 * texels its chunk touches, so resolution barely moves the fill cost, and the
 * run is dominated by per-chunk overhead (~4,800 passes on a 39k-segment
 * pattern) instead. Measured on an M4 Max, Spiral 6 takes 346 / 354 / 351 ms at
 * the three levels — flat within noise. Only the periodic full-field relax pass
 * actually scales, and it runs once per 512 segments.
 */
const RESOLUTIONS = [
  { label: 'Draft', size: 1024 },
  { label: 'Fine', size: 2048 },
  { label: 'Max', size: 4096 },
];

/**
 * Path resampling is tied to resolution: the tolerance was tuned as ~0.8 of a
 * texel on the 1024² field, and holding it fixed while the field got finer
 * would mean rendering a smoother heightfield of a path that was still faceted.
 */
const resampleOptions = (resolution: number) => ({
  maxSagitta: 0.0015 * (1024 / resolution),
});

interface Status {
  name: string;
  points: number;
  segments: number;
  skipped: number;
}

/**
 * A pattern that has been loaded, kept so it can be re-run without refetching.
 * The text is held rather than a filename because dropped files have no URL to
 * go back to — history has to work the same for those as for the samples.
 */
interface HistoryEntry {
  id: number;
  label: string;
  text: string;
}

const HISTORY_LIMIT = 12;

/**
 * Versioned, so a future change to the parameter set can be told apart from
 * a stale blob rather than silently half-applied.
 */
const STORAGE_KEY = 'dune-weaver-sim:settings:v1';

interface StoredSettings {
  sand?: unknown;
  render?: unknown;
  resolution?: unknown;
  speedIdx?: unknown;
}

/**
 * Copy stored values over defaults, keeping only keys the defaults declare and
 * only values of the right shape.
 *
 * Merging rather than replacing matters for forward compatibility: a blob
 * written before a parameter existed would otherwise leave that parameter
 * `undefined`, which reaches the shader as NaN and blanks the table. Validating
 * matters because localStorage is user-editable and shared with anything else
 * on the origin — a hand-edited string in a numeric field would do the same.
 */
function mergeStored<T extends object>(defaults: T, stored: unknown): T {
  if (!stored || typeof stored !== 'object') return defaults;
  const src = stored as Record<string, unknown>;
  const out = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const fallback = defaults[key];
    const value = src[key];
    const isNumber = typeof value === 'number' && Number.isFinite(value);
    if (typeof fallback === 'number' && isNumber) {
      out[key] = value as T[keyof T & string];
    } else if (
      Array.isArray(fallback) &&
      Array.isArray(value) &&
      value.length === fallback.length &&
      value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      out[key] = value as T[keyof T & string];
    }
  }
  return out;
}

function readSettings(): StoredSettings | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSettings) : null;
  } catch {
    // Private browsing, a disabled store, or a corrupt blob. Defaults are a
    // perfectly good outcome; failing to start is not.
    return null;
  }
}

interface LoopContext {
  simRef: RefObject<SandSim | null>;
  rafRef: RefObject<number | null>;
  playingRef: RefObject<boolean>;
  /** Target seconds to play the whole pattern. */
  durationRef: RefObject<number>;
  setProgress: (v: number) => void;
  setPlaying: (v: boolean) => void;
}

/**
 * One animation frame of playback. Lives at module scope so it can schedule
 * itself without a component-level self-reference; all mutable state reaches it
 * through refs.
 */
function frame(ctx: LoopContext) {
  const sim = ctx.simRef.current;
  if (!sim) return;

  // Spread the pattern across the target duration at ~60fps, so playback takes
  // about as long regardless of how many segments the pattern has.
  const perFrame = Math.max(1, Math.ceil(sim.totalSegments / (ctx.durationRef.current * 60)));
  sim.advance(perFrame);
  sim.draw();
  ctx.setProgress(sim.progress);

  if (sim.done) {
    // Let the last ridges settle before the final frame.
    sim.relax(2);
    sim.draw();
    ctx.playingRef.current = false;
    ctx.setPlaying(false);
    ctx.rafRef.current = null;
    return;
  }
  ctx.rafRef.current = requestAnimationFrame(() => frame(ctx));
}

export default function SandTable() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<SandSim | null>(null);
  const rafRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const durationRef = useRef(SPEEDS[1].seconds);
  const resimRef = useRef<number | null>(null);
  const pathRef = useRef<Float32Array>(new Float32Array(0));
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** Text + name of the loaded pattern, so it survives a sim rebuild. */
  const currentRef = useRef<{ text: string; name: string } | null>(null);
  /** Progress to restore to after a rebuild, as a fraction. */
  const resumeRef = useRef(0);
  const sandRef = useRef<SandParams>(DEFAULT_SAND);
  const renderRef = useRef<RenderParams>(DEFAULT_RENDER);
  /** Guards the one-time restore from localStorage across sim rebuilds. */
  const restoredRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [keepSand, setKeepSand] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [showPath, setShowPath] = useState(false);
  const [sand, setSand] = useState<SandParams>(DEFAULT_SAND);
  const [render, setRender] = useState<RenderParams>(DEFAULT_RENDER);
  const [resolution, setResolution] = useState(RESOLUTIONS[1].size);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  /** Bumped whenever a new SandSim is built, to drive the restore effect. */
  const [simEpoch, setSimEpoch] = useState(0);

  // --- lifecycle -----------------------------------------------------------

  // Created in a callback ref rather than an effect: GL context setup is a
  // mount-time side effect on the node itself, and this keeps the success /
  // failure state out of an effect body.
  const attachCanvas = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    if (!node) return;

    // Restore saved settings on the first attach only.
    //
    // This happens here rather than in a lazy useState initializer because the
    // panel is server-prerendered: reading localStorage during render would
    // produce markup that disagrees with the server's and trip a hydration
    // mismatch. A callback ref runs on the client after hydration, so it is
    // safe. The cost is that a stored resolution arrives one render late and
    // rebuilds the sim once on load, which is cheap and happens before any
    // pattern is loaded.
    if (!restoredRef.current) {
      restoredRef.current = true;
      const stored = readSettings();
      if (stored) {
        const s = mergeStored(DEFAULT_SAND, stored.sand);
        const r = mergeStored(DEFAULT_RENDER, stored.render);
        sandRef.current = s;
        renderRef.current = r;
        setSand(s);
        setRender(r);
        const res = RESOLUTIONS.find((x) => x.size === stored.resolution);
        if (res) setResolution(res.size);
        const idx = stored.speedIdx;
        if (typeof idx === 'number' && SPEEDS[idx]) {
          setSpeedIdx(idx);
          durationRef.current = SPEEDS[idx].seconds;
        }
      }
    }

    let sim: SandSim;
    try {
      sim = new SandSim(node, resolution);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    simRef.current = sim;
    // A rebuild starts from defaults, so re-apply whatever the panel is showing
    // before anything is drawn — otherwise changing detail silently reverts
    // every slider.
    sim.sand = sandRef.current;
    sim.render = renderRef.current;
    sim.draw();
    setReady(true);
    setSimEpoch((n) => n + 1);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      // Remember how far through the pattern we were, so the rebuilt sim can be
      // brought back to the same frame rather than snapping to the start.
      resumeRef.current = sim.progress;
      sim.dispose();
      simRef.current = null;
      canvasRef.current = null;
    };
  }, [resolution]);

  // Rebuild restore. A GL context cannot be resized in place (the heightfield
  // textures are immutable storage), so changing detail means a new sim and a
  // re-run of the current pattern.
  //
  // The sand *underneath* the current pattern cannot come across — it only
  // exists as texels in the old context, at the old resolution — so this
  // re-runs on a flat bed. Stacking patterns and then changing detail loses the
  // stack; that is a real limitation, not an oversight.
  useEffect(() => {
    const sim = simRef.current;
    const cur = currentRef.current;
    if (!sim || !cur) return;

    const path = resamplePath(parseThr(cur.text).coords, resampleOptions(sim.resolution));
    pathRef.current = path;
    sim.loadPath(path, { clearSand: true });
    const target = Math.round(resumeRef.current * sim.totalSegments);
    if (target > 0) sim.advance(target);
    sim.draw();
  }, [simEpoch]);

  // Lighting only changes how the existing heightfield is shaded, so a redraw
  // is enough.
  useEffect(() => {
    renderRef.current = render;
    const sim = simRef.current;
    if (!sim) return;
    sim.render = render;
    if (!playingRef.current) sim.draw();
  }, [render]);

  // Sand parameters feed the carve itself — ball size and groove depth change
  // what the heightfield *is*, not just how it looks — so the pattern has to be
  // re-run. Coalesced to one re-simulation per frame, so dragging a slider does
  // not queue a full run per input event.
  useEffect(() => {
    sandRef.current = sand;
    const sim = simRef.current;
    if (!sim) return;
    sim.sand = sand;

    if (resimRef.current !== null) cancelAnimationFrame(resimRef.current);
    resimRef.current = requestAnimationFrame(() => {
      resimRef.current = null;
      sim.resimulate();
      sim.draw();
    });

    return () => {
      if (resimRef.current !== null) {
        cancelAnimationFrame(resimRef.current);
        resimRef.current = null;
      }
    };
  }, [sand]);

  // Persist the panel. Deliberately not the pattern history: a single .thr can
  // be tens of thousands of lines, and a dropped file only exists as text we
  // hold, so persisting history means putting megabytes into a ~5 MB store that
  // is shared with everything else on the origin.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sand, render, resolution, speedIdx }),
      );
    } catch {
      // Full or unavailable store. Losing the setting is survivable; throwing
      // out of an effect on every slider drag is not.
    }
  }, [sand, render, resolution, speedIdx]);

  // Diagnostic: draw the resampled path as a bare polyline, with no physics and
  // no shading. If a feature shows up here it is in the pattern data, and no
  // amount of tuning the sand model will remove it.
  useEffect(() => {
    const canvas = overlayRef.current;
    const sim = simRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const path = pathRef.current;
    if (!showPath || !sim || path.length < 4) return;

    const R = canvas.width / 2;
    const s = sim.coordinateScale;
    // Match the render: the table is shown rotated 180°, and canvas y runs down
    // while world y runs up.
    const sx = (x: number) => R - x * s * R;
    const sy = (y: number) => R + y * s * R;

    ctx.strokeStyle = 'rgba(255, 96, 160, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx(path[0]), sy(path[1]));
    for (let i = 2; i < path.length; i += 2) ctx.lineTo(sx(path[i]), sy(path[i + 1]));
    ctx.stroke();
  }, [showPath, sand, status]);

  // The playback loop lives outside the component (see `frame` below) so it can
  // schedule itself recursively without a self-referencing hook. It reads
  // everything it needs from refs, so this context object being rebuilt each
  // render is harmless.
  const loop: LoopContext = {
    simRef,
    rafRef,
    playingRef,
    durationRef,
    setProgress,
    setPlaying,
  };

  const play = () => {
    const sim = simRef.current;
    if (!sim || sim.done) return;
    playingRef.current = true;
    setPlaying(true);
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => frame(loop));
    }
  };

  const pause = () => {
    playingRef.current = false;
    setPlaying(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const skipToEnd = () => {
    const sim = simRef.current;
    if (!sim) return;
    pause();
    sim.runToEnd();
    sim.draw();
    setProgress(1);
  };

  /** Rewind to the sand as it was before this pattern, then play it again. */
  const replay = () => {
    const sim = simRef.current;
    if (!sim) return;
    pause();
    sim.replay();
    sim.draw();
    setProgress(0);
    play();
  };

  // --- loading -------------------------------------------------------------

  const loadText = (text: string, name: string) => {
    const sim = simRef.current;
    if (!sim) return;
    pause();

    const parsed = parseThr(text);
    if (parsed.coords.length < 2) {
      setError(`${name} contains no usable coordinates.`);
      return;
    }
    const path = resamplePath(parsed.coords, resampleOptions(sim.resolution));
    pathRef.current = path;
    currentRef.current = { text, name };
    resumeRef.current = 0;
    sim.loadPath(path, { clearSand: !keepSand });
    sim.draw();

    setError(null);
    setProgress(0);
    setStatus({
      name,
      points: parsed.coords.length,
      segments: path.length / 2 - 1,
      skipped: parsed.skipped,
    });

    // Most recent first, no duplicates. Re-loading a pattern moves it back to
    // the top rather than adding a second row for it.
    setHistory((prev) => [
      { id: (prev[0]?.id ?? 0) + 1, label: name, text },
      ...prev.filter((h) => h.text !== text),
    ].slice(0, HISTORY_LIMIT));
  };

  const loadSample = async (file: string, label: string) => {
    try {
      const res = await fetch(`/patterns/${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      loadText(await res.text(), label);
    } catch (e) {
      setError(`Could not load ${file}: ${e instanceof Error ? e.message : e}`);
    }
  };

  const onFile = async (file: File) => {
    loadText(await file.text(), file.name);
  };

  /** Level the sand by hand — no ball, no tracks. */
  const clearTable = () => {
    const sim = simRef.current;
    if (!sim) return;
    pause();
    sim.clearSand();
    sim.draw();
    pathRef.current = new Float32Array(0);
    currentRef.current = null;
    resumeRef.current = 0;
    setProgress(0);
    setStatus(null);
  };

  const exportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Redraw first: the canvas may hold a stale frame if parameters changed
    // while paused.
    simRef.current?.draw();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${status?.name.replace(/\.thr$/i, '') ?? 'sand'}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  // --- render --------------------------------------------------------------

  if (error && !ready) {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-red-900/50 bg-red-950/30 p-6 text-sm text-red-200">
        <p className="font-medium">The simulator could not start.</p>
        <p className="mt-2 text-red-300/80">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* Table */}
      <div className="flex-1">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void onFile(file);
          }}
          className="relative aspect-square w-full overflow-hidden rounded-full bg-black shadow-2xl ring-1 ring-white/10"
        >
          <canvas
            ref={attachCanvas}
            width={resolution}
            height={resolution}
            className="h-full w-full"
          />
          <canvas
            ref={overlayRef}
            width={resolution}
            height={resolution}
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        </div>

        {/* Transport */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={playing ? pause : progress >= 1 ? replay : play}
            disabled={!status}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-black transition hover:bg-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {playing ? 'Pause' : progress >= 1 ? 'Replay' : 'Play'}
          </button>
          <button
            onClick={skipToEnd}
            disabled={!status || progress >= 1}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-neutral-200 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Skip to end
          </button>
          <button
            onClick={clearTable}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-neutral-200 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            Clear table
          </button>
          <button
            onClick={exportPng}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-neutral-200 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            Export PNG
          </button>

          <div className="ml-auto flex items-center gap-1">
            {SPEEDS.map((s, i) => (
              <button
                key={s.label}
                onClick={() => {
                  setSpeedIdx(i);
                  durationRef.current = s.seconds;
                }}
                className={`rounded px-2.5 py-1.5 text-xs font-mono transition ${
                  speedIdx === i
                    ? 'bg-white/15 text-white'
                    : 'text-neutral-400 hover:bg-white/5'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-amber-500 transition-[width] duration-75"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        {status && (
          <p className="mt-2 font-mono text-xs text-neutral-500">
            {status.name} — {status.points.toLocaleString()} coords →{' '}
            {status.segments.toLocaleString()} segments
            {status.skipped > 0 && ` · ${status.skipped} unparseable lines skipped`}
          </p>
        )}
        {error && ready && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      {/* Controls */}
      <aside className="w-full shrink-0 space-y-6 lg:w-80">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Pattern
          </h2>
          <div className="grid grid-cols-2 gap-1.5">
            {SAMPLES.map((s) => (
              <button
                key={s.file}
                onClick={() => void loadSample(s.file, s.label)}
                className="rounded border border-white/10 px-2 py-2 text-left text-xs text-neutral-300 transition hover:border-amber-500/50 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
              >
                {s.label}
              </button>
            ))}
          </div>

          <label className="mt-2 block cursor-pointer rounded border border-dashed border-white/15 px-3 py-3 text-center text-xs text-neutral-400 transition hover:border-amber-500/50 hover:text-neutral-200">
            Drop a .thr file here, or click to browse
            <input
              type="file"
              accept=".thr,text/plain"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>

          <label className="mt-3 flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={keepSand}
              onChange={(e) => setKeepSand(e.target.checked)}
              className="accent-amber-500"
            />
            Keep existing sand (draw over the last pattern)
          </label>

          <label className="mt-2 flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={showPath}
              onChange={(e) => setShowPath(e.target.checked)}
              className="accent-amber-500"
            />
            Show ball path (raw data, no physics)
          </label>
        </section>

        {history.length > 0 && (
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                History
              </h2>
              <button
                onClick={() => setHistory([])}
                className="text-[11px] text-neutral-500 underline-offset-4 transition hover:text-neutral-300 hover:underline"
              >
                Forget
              </button>
            </div>
            <ol className="space-y-1">
              {history.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => loadText(h.text, h.label)}
                    title={h.label}
                    className={`w-full truncate rounded px-2 py-1.5 text-left text-xs transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 ${
                      status?.name === h.label
                        ? 'bg-white/10 text-amber-300'
                        : 'text-neutral-400'
                    }`}
                  >
                    {h.label}
                  </button>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] leading-snug text-neutral-500">
              Re-runs the pattern from the sand currently on the table, so it
              obeys <span className="text-neutral-400">Keep existing sand</span>{' '}
              just like a fresh load does.
            </p>
          </section>
        )}

        <Group title="Detail">
          <div className="flex gap-1">
            {RESOLUTIONS.map((r) => (
              <button
                key={r.size}
                onClick={() => setResolution(r.size)}
                className={`flex-1 rounded px-2 py-1.5 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 ${
                  resolution === r.size
                    ? 'bg-white/15 text-white'
                    : 'text-neutral-400 hover:bg-white/5'
                }`}
              >
                {r.label}
                <span className="ml-1 font-mono text-[10px] text-neutral-500">
                  {r.size}
                </span>
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-neutral-500">
            Costs memory (12 / 50 / 201 MB) but almost no extra time — the
            simulation is bound by the number of strokes, not the grid.
            Changing it rebuilds the sim and re-runs the current pattern on flat
            sand, so any sand stacked underneath is lost.
          </p>
        </Group>

        <Group title="Table">
          <Slider
            label="Table diameter"
            value={sand.tableDiameterMm}
            min={150}
            max={900}
            step={5}
            unit="mm"
            decimals={0}
            onChange={(v) => setSand({ ...sand, tableDiameterMm: v })}
          />
          <Slider
            label="Ball diameter"
            value={sand.ballDiameterMm}
            min={3}
            max={40}
            step={0.5}
            unit="mm"
            decimals={1}
            onChange={(v) => setSand({ ...sand, ballDiameterMm: v })}
          />
          <p className="text-[11px] leading-snug text-neutral-500">
            Only the ratio matters: the groove is{' '}
            <span className="font-mono text-neutral-400">
              {((sand.ballDiameterMm / sand.tableDiameterMm) * 100).toFixed(1)}%
            </span>{' '}
            of the table diameter wide.
          </p>
        </Group>

        <Group title="Sand">
          <Slider
            label="Groove depth"
            value={sand.depthMm}
            min={0.2}
            max={15}
            step={0.1}
            unit="mm"
            decimals={1}
            onChange={(v) => setSand({ ...sand, depthMm: v })}
          />
          <Slider
            label="Ridge width"
            value={sand.bermWidthMm}
            min={0.5}
            max={20}
            step={0.1}
            unit="mm"
            decimals={1}
            onChange={(v) => setSand({ ...sand, bermWidthMm: v })}
          />
          <Slider
            label="Ridge buildup"
            value={sand.bermGain}
            min={0}
            max={1.5}
            step={0.02}
            onChange={(v) => setSand({ ...sand, bermGain: v })}
          />
          <Slider
            label="Backfill (bow wave)"
            value={sand.fill}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setSand({ ...sand, fill: v })}
          />
          <Slider
            label="Angle of repose"
            value={sand.reposeSlope}
            min={0.05}
            max={2}
            step={0.05}
            onChange={(v) => setSand({ ...sand, reposeSlope: v })}
          />
        </Group>

        <Group title="Light">
          <Slider
            label="Azimuth"
            value={render.lightAzimuth}
            min={0}
            max={6.283}
            step={0.02}
            onChange={(v) => setRender({ ...render, lightAzimuth: v })}
          />
          <Slider
            label="Elevation"
            value={render.lightElevation}
            min={0.05}
            max={1.4}
            step={0.01}
            onChange={(v) => setRender({ ...render, lightElevation: v })}
          />
          <Slider
            label="Relief"
            value={render.relief}
            min={0.5}
            max={10}
            step={0.1}
            onChange={(v) => setRender({ ...render, relief: v })}
          />
          <Slider
            label="Occlusion"
            value={render.aoStrength}
            min={0}
            max={80}
            step={1}
            onChange={(v) => setRender({ ...render, aoStrength: v })}
          />
        </Group>

        <button
          onClick={() => {
            setSand(DEFAULT_SAND);
            setRender(DEFAULT_RENDER);
          }}
          className="text-xs text-neutral-500 underline-offset-4 transition hover:text-neutral-300 hover:underline"
        >
          Reset parameters
        </button>
      </aside>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
        {title}
      </h2>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  onChange: (v: number) => void;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  decimals = 3,
  onChange,
}: SliderProps) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-neutral-400">{label}</span>
        <span className="font-mono text-[11px] text-neutral-500">
          {value.toFixed(decimals)}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-amber-500"
      />
    </label>
  );
}

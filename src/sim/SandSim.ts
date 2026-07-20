/**
 * WebGL2 sand-table simulator.
 *
 * The sand bed is a floating-point heightfield held in a ping-pong pair of
 * R32F textures. World space and clip space are the same thing here — the
 * table is the unit disc — which lets a carve pass draw a small quad covering
 * only the segments it touches instead of shading the whole field every step.
 */

import {
  CARVE_FRAG,
  MAX_SEGMENTS,
  QUAD_VERT,
  RELAX_FRAG,
  RENDER_FRAG,
  RESET_FRAG,
} from './shaders';

/**
 * Physical dimensions are in millimetres. Nothing in the firmware or host repos
 * records a real table radius or ball diameter — everything there is normalised
 * or in motor space — so these are the user's to supply. Internally they are
 * divided by the table radius to give the normalised world units the shaders
 * work in, which means only the *ratio* of ball to table actually affects the
 * result.
 */
export interface SandParams {
  /** Table diameter, mm. */
  tableDiameterMm: number;
  /** Ball diameter, mm. */
  ballDiameterMm: number;
  /** How deep the ball rides below the nominal sand surface, mm. */
  depthMm: number;
  /** Width of the ridge thrown up alongside the groove, mm. */
  bermWidthMm: number;
  /** Share of displaced material that ends up in the ridge. */
  bermGain: number;
  /**
   * How much of an older, deeper groove the ball backfills as it crosses it,
   * per pass. 0 means grooves are permanent and nothing can ever be erased.
   */
  fill: number;
  /** Max neighbour-to-neighbour slope the sand can hold. */
  reposeSlope: number;
  /** Surface grain amplitude. */
  grain: number;
}

export interface RenderParams {
  relief: number;
  lightAzimuth: number;
  lightElevation: number;
  sandColor: [number, number, number];
  aoStrength: number;
}

/**
 * Tuned by eye against photographs of a real table rather than derived: a
 * narrow, sharply defined ridge with a lot of material thrown up, and low
 * backfill so a pattern drawn over another only partly erases it.
 */
export const DEFAULT_SAND: SandParams = {
  tableDiameterMm: 700,
  ballDiameterMm: 10,
  depthMm: 3.2,
  bermWidthMm: 0.5,
  bermGain: 1.06,
  fill: 0.21,
  reposeSlope: 0.7,
  grain: 0.0012,
};

export const DEFAULT_RENDER: RenderParams = {
  relief: 2.6,
  lightAzimuth: 2.5,
  lightElevation: 0.34,
  sandColor: [0.88, 0.79, 0.63],
  aoStrength: 16,
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram failed');
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link failed: ${log}`);
  }
  return prog;
}

/**
 * How many path segments to carve between angle-of-repose passes. Keyed to
 * segments, not carve passes, so the result is independent of how the work was
 * batched — playing a pattern through and skipping to the end must agree.
 */
const RELAX_EVERY_SEGMENTS = 512;

/**
 * Ambient-occlusion sampling radius, in uv units (1.0 = the table diameter).
 *
 * Fixed in table space rather than texels so the shading is identical at every
 * heightfield resolution — the value is the 7-texel radius the look was tuned
 * at, expressed against the 1024² field it was tuned on.
 */
const AO_RADIUS_UV = 7 / 1024;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class SandSim {
  private gl: WebGL2RenderingContext;
  private size: number;
  private front: Target;
  private back: Target;
  /** Sand as it stood before the current pattern began. */
  private base: Target;
  private vao: WebGLVertexArrayObject;
  private progCarve: WebGLProgram;
  private progRelax: WebGLProgram;
  private progReset: WebGLProgram;
  private progRender: WebGLProgram;
  private segBuf = new Float32Array(MAX_SEGMENTS * 4);

  /** Dense path in table space, as flat x,y pairs. */
  private path: Float32Array = new Float32Array(0);
  /** Index of the next path *point* to consume. */
  private cursor = 0;
  /**
   * How many whole relaxation intervals have been run.
   *
   * Scheduled against segments consumed rather than carve passes issued: a
   * frame during slow playback may carve only a couple of segments while
   * `runToEnd` carves 64 at a time, so counting passes would relax a played-out
   * pattern far more than a skipped one and give two different results for the
   * same pattern.
   */
  private relaxedIntervals = 0;
  /**
   * Segment budget carried over between `advance` calls.
   *
   * Carving always happens in whole chunks aligned to fixed multiples of
   * MAX_SEGMENTS. The carve reads the height texture, so every segment in a
   * chunk sees the same starting state while a later chunk sees the earlier
   * one's result — meaning the chunk decomposition is part of the physics.
   * Holding a fractional budget here keeps that decomposition identical whether
   * a frame asks for two segments or `runToEnd` asks for thousands.
   */
  private pending = 0;
  /** Texel rectangle written by the pass in flight, folded back in endPass. */
  private passRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /**
   * Uniform locations, cached per program. `getUniformLocation` does a string
   * lookup into the linked program; at roughly a dozen uniforms per carve pass
   * and thousands of passes per pattern, resolving them every time costs more
   * than the drawing does.
   */
  private uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  sand: SandParams = { ...DEFAULT_SAND };
  render: RenderParams = { ...DEFAULT_RENDER };

  constructor(canvas: HTMLCanvasElement, size = 1024) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');

    // Rendering *into* a float texture is an extension even in WebGL2.
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float is unavailable; cannot run the sand sim.');
    }
    gl.getExtension('OES_texture_float_linear');

    this.gl = gl;
    this.size = size;

    this.front = this.makeTarget();
    this.back = this.makeTarget();
    this.base = this.makeTarget();

    this.progCarve = link(gl, QUAD_VERT, CARVE_FRAG);
    this.progRelax = link(gl, QUAD_VERT, RELAX_FRAG);
    this.progReset = link(gl, QUAD_VERT, RESET_FRAG);
    this.progRender = link(gl, QUAD_VERT, RENDER_FRAG);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.reset();
    // Seed the base snapshot so a re-simulate before any pattern loads restores
    // flat sand rather than the undefined contents of a fresh texture.
    this.blit(this.front, this.base);
  }

  private loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let byName = this.uniformCache.get(prog);
    if (!byName) {
      byName = new Map();
      this.uniformCache.set(prog, byName);
    }
    if (!byName.has(name)) byName.set(name, this.gl.getUniformLocation(prog, name));
    return byName.get(name) ?? null;
  }

  private makeTarget(): Target {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, this.size, this.size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('createFramebuffer failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Heightfield framebuffer incomplete (0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  /**
   * World-space bounds → texel rectangle, rounded outward and clamped.
   *
   * The quad is then snapped to exactly this rectangle, so the pixels the draw
   * covers and the pixels copied back are the same set. They must not diverge:
   * copying a pixel the draw did not write hands the authoritative texture
   * whatever the scratch texture happened to hold from an earlier, unrelated
   * chunk.
   */
  private boundsToRect(b: [number, number, number, number]) {
    const toPx = (v: number) => (v * 0.5 + 0.5) * this.size;
    const x0 = Math.max(0, Math.floor(toPx(b[0])));
    const y0 = Math.max(0, Math.floor(toPx(b[1])));
    const x1 = Math.min(this.size, Math.ceil(toPx(b[2])));
    const y1 = Math.min(this.size, Math.ceil(toPx(b[3])));
    return { x0, y0, x1, y1 };
  }

  /** Texel rectangle → the world-space quad that covers exactly those texels. */
  private rectToBounds(r: {
    x0: number; y0: number; x1: number; y1: number;
  }): [number, number, number, number] {
    const toWorld = (px: number) => (px / this.size) * 2 - 1;
    return [toWorld(r.x0), toWorld(r.y0), toWorld(r.x1), toWorld(r.y1)];
  }

  // --- unit conversion -----------------------------------------------------
  // World units: the table is the unit disc, so 1.0 = the table radius.

  /** World units per millimetre. */
  private get worldPerMm(): number {
    return 2 / Math.max(this.sand.tableDiameterMm, 1e-6);
  }

  private get ballRadiusWorld(): number {
    return (this.sand.ballDiameterMm / 2) * this.worldPerMm;
  }

  /**
   * A ball cannot sit deeper than its own radius without its widest point
   * going under the sand, which the spherical-cap profile doesn't model, so
   * clamp rather than produce a surface that turns inside out.
   */
  private get depthWorld(): number {
    return Math.min(this.sand.depthMm * this.worldPerMm, this.ballRadiusWorld);
  }

  /**
   * Scale applied to path coordinates.
   *
   * rho = 1 puts the ball at its outermost position, which is where it touches
   * the table wall — so the ball *centre* reaches only one ball radius short of
   * the wall, not the wall itself. Without this the outermost passes (and every
   * turn in a sideways clear, which all happen at rho > 0.99) would sit exactly
   * on the rim and be lost under the edge treatment.
   */
  /** Public view of the path scaling, for drawing diagnostics in table space. */
  get coordinateScale(): number {
    return this.pathScale;
  }

  private get pathScale(): number {
    return 1 - this.ballRadiusWorld;
  }

  private get bermWidthWorld(): number {
    return this.sand.bermWidthMm * this.worldPerMm;
  }

  private blit(src: Target, dst: Target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    gl.blitFramebuffer(
      0, 0, this.size, this.size,
      0, 0, this.size, this.size,
      gl.COLOR_BUFFER_BIT, gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** Bind `back` as scratch draw target, reading from the authoritative `front`. */
  private beginPass(prog: WebGLProgram, bounds: [number, number, number, number]) {
    const gl = this.gl;
    // Snap the quad to whole texels so the drawn set and the copied-back set
    // are identical.
    this.passRect = this.boundsToRect(bounds);
    const snapped = this.rectToBounds(this.passRect);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.back.fbo);
    gl.viewport(0, 0, this.size, this.size);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.front.tex);
    gl.uniform1i(this.loc(prog, 'uHeight'), 0);
    gl.uniform4f(this.loc(prog, 'uBounds'), ...snapped);
  }

  /**
   * Draw the pass, then fold just the affected rectangle back into `front`.
   *
   * `front` stays authoritative at all times and `back` is pure scratch, so a
   * pass that touches a small area costs a small copy instead of a whole-field
   * one. Ping-ponging instead would mean seeding the destination with the
   * entire field before every pass — otherwise pixels outside the drawn quad
   * would still hold state from two swaps ago and silently resurrect old sand.
   */
  private endPass() {
    const gl = this.gl;
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const { x0, y0, x1, y1 } = this.passRect;
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.back.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.front.fbo);
    gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** Flat sand. Clears any pattern progress. */
  reset() {
    const gl = this.gl;
    this.cursor = 0;
    this.relaxedIntervals = 0;
    this.pending = 0;
    this.beginPass(this.progReset, [-1, -1, 1, 1]);
    gl.uniform1f(this.loc(this.progReset, 'uGrain'), this.sand.grain);
    gl.uniform1f(this.loc(this.progReset, 'uSize'), this.size);
    this.endPass();
  }

  /**
   * Flatten the table and forget the loaded pattern.
   *
   * Distinct from the `clear_*.thr` patterns, which are real ball paths that
   * sweep the sand flat and leave their own tracks behind. This is the sand bed
   * being levelled by hand: no path, no tracks.
   *
   * `reset` alone would leave `base` holding the old sand, so the next Replay or
   * parameter drag — both of which rewind to `base` — would quietly bring back
   * what was just cleared.
   */
  clearSand() {
    this.reset();
    this.path = new Float32Array(0);
    this.blit(this.front, this.base);
  }

  /** Heightfield resolution this sim was built at. */
  get resolution(): number {
    return this.size;
  }

  /**
   * Load a pattern. By default the existing sand is kept, so a pattern drawn
   * over a previous one partially erases it — which is what the real table
   * does when you queue a playlist without a clear pattern between entries.
   */
  loadPath(path: Float32Array, { clearSand = false } = {}) {
    if (clearSand) this.reset();
    this.path = path;
    this.cursor = 0;
    this.relaxedIntervals = 0;
    this.pending = 0;
    // Remember the sand as it stood before this pattern ran, so the pattern can
    // be replayed or re-simulated without losing whatever was underneath it.
    this.blit(this.front, this.base);
  }

  /** Rewind to the sand as it was before the current pattern started. */
  replay() {
    this.blit(this.base, this.front);
    this.cursor = 0;
    this.relaxedIntervals = 0;
    this.pending = 0;
  }

  /**
   * Re-run the current pattern from its starting sand up to wherever playback
   * had reached. Used when a sand parameter changes: ball size and groove depth
   * feed the carve itself, so unlike the lighting controls they cannot be
   * applied by simply redrawing.
   */
  resimulate() {
    const target = this.cursor;
    this.replay();
    if (target > 0) this.advance(target);
  }

  get totalSegments(): number {
    return Math.max(0, this.path.length / 2 - 1);
  }

  get progress(): number {
    const total = this.totalSegments;
    return total === 0 ? 1 : Math.min(1, this.cursor / total);
  }

  get done(): boolean {
    return this.cursor >= this.totalSegments;
  }

  /** Current ball position in table space, or null before the first step. */
  get ballPosition(): [number, number] | null {
    if (this.path.length < 2) return null;
    const i = Math.min(this.cursor, this.path.length / 2 - 1) * 2;
    return [this.path[i] * this.pathScale, this.path[i + 1] * this.pathScale];
  }

  /**
   * Advance the simulation by up to `segments` path segments.
   * Returns the number actually consumed.
   */
  advance(segments: number): number {
    const gl = this.gl;
    const total = this.totalSegments;
    if (this.cursor >= total) return 0;

    this.pending += segments;
    let consumed = 0;

    while (this.cursor < total) {
      // Whole chunks only, always aligned to the same multiples of
      // MAX_SEGMENTS, so the decomposition never depends on the caller.
      const count = Math.min(MAX_SEGMENTS, total - this.cursor);
      if (this.pending < count) break;
      const start = this.cursor;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      const scale = this.pathScale;
      for (let i = 0; i < count; i++) {
        const p = (start + i) * 2;
        const ax = this.path[p] * scale;
        const ay = this.path[p + 1] * scale;
        const bx = this.path[p + 2] * scale;
        const by = this.path[p + 3] * scale;
        this.segBuf[i * 4] = ax;
        this.segBuf[i * 4 + 1] = ay;
        this.segBuf[i * 4 + 2] = bx;
        this.segBuf[i * 4 + 3] = by;
        minX = Math.min(minX, ax, bx);
        minY = Math.min(minY, ay, by);
        maxX = Math.max(maxX, ax, bx);
        maxY = Math.max(maxY, ay, by);
      }

      // Where this chunk's capsule begins and ends, and the directions it
      // enters and leaves by, so the shader can tell its rounded end caps
      // apart from the real swept groove.
      const dir = (fromIdx: number, toIdx: number): [number, number] => {
        const dx = (this.path[toIdx * 2] - this.path[fromIdx * 2]) * scale;
        const dy = (this.path[toIdx * 2 + 1] - this.path[fromIdx * 2 + 1]) * scale;
        const len = Math.hypot(dx, dy);
        return len < 1e-9 ? [0, 0] : [dx / len, dy / len];
      };

      /**
       * Direction of the path arriving at point `k`, skipping degenerate
       * segments.
       *
       * Dense image-derived patterns repeat coordinates freely, and a repeated
       * pair gives a zero-length segment with no direction. Treating that as
       * "no plane" is not good enough: the chunk then deposits its berm past
       * the boundary and double-doses with its neighbour, leaving a blip at
       * exactly the duplicated points. Walking to the nearest segment that does
       * have a direction keeps a real plane at every boundary.
       *
       * The search is bounded so a long run of duplicates can't make this
       * quadratic; past that, it gives up and disables the plane.
       */
      const dirEntering = (k: number): [number, number] => {
        const LIMIT = 64;
        for (let j = k; j > 0 && k - j < LIMIT; j--) {
          const d = dir(j - 1, j);
          if (d[0] !== 0 || d[1] !== 0) return d;
        }
        for (let j = k; j < total && j - k < LIMIT; j++) {
          const d = dir(j, j + 1);
          if (d[0] !== 0 || d[1] !== 0) return d;
        }
        return [0, 0];
      };

      // Both planes are defined by the direction *entering* their boundary
      // point, so a boundary shared by two chunks gets the same plane from each
      // and the partition is exact. Deriving the start plane from this chunk's
      // own first segment instead would give the two chunks different normals
      // wherever the path curves, leaving a wedge neither claims on the outside
      // of the turn and one both claim on the inside — a periodic spike at
      // every boundary.
      const last = start + count;
      const [sdx, sdy] = dirEntering(start);
      const [edx, edy] = dirEntering(last);

      // Only shade the region this chunk can affect, plus a texel of slack.
      const pad = this.ballRadiusWorld + this.bermWidthWorld + 4 / this.size;
      const bounds: [number, number, number, number] = [
        Math.max(-1, minX - pad),
        Math.max(-1, minY - pad),
        Math.min(1, maxX + pad),
        Math.min(1, maxY + pad),
      ];

      const prog = this.progCarve;
      this.beginPass(prog, bounds);
      gl.uniform4fv(this.loc(prog, 'uSegs'), this.segBuf);
      gl.uniform1i(this.loc(prog, 'uSegCount'), count);
      gl.uniform1f(this.loc(prog, 'uBallR'), this.ballRadiusWorld);
      gl.uniform1f(this.loc(prog, 'uDepth'), this.depthWorld);
      gl.uniform1f(this.loc(prog, 'uBermW'), this.bermWidthWorld);
      gl.uniform1f(this.loc(prog, 'uBermGain'), this.sand.bermGain);
      gl.uniform1f(this.loc(prog, 'uFill'), this.sand.fill);
      gl.uniform2f(
        this.loc(prog, 'uCapStart'),
        this.path[start * 2] * scale, this.path[start * 2 + 1] * scale,
      );
      gl.uniform2f(this.loc(prog, 'uCapStartDir'), sdx, sdy);
      gl.uniform2f(
        this.loc(prog, 'uCapEnd'),
        this.path[last * 2] * scale, this.path[last * 2 + 1] * scale,
      );
      gl.uniform2f(this.loc(prog, 'uCapEndDir'), edx, edy);
      this.endPass();

      this.cursor += count;
      this.pending -= count;
      consumed += count;

      // Let ridges slump periodically rather than after every chunk — the
      // visual difference is negligible and it is a full-field pass.
      const intervals = Math.floor(this.cursor / RELAX_EVERY_SEGMENTS);
      if (intervals > this.relaxedIntervals) {
        this.relaxedIntervals = intervals;
        this.relax(1);
      }
    }

    return consumed;
  }

  /** Run the angle-of-repose pass. */
  relax(iterations = 1) {
    const gl = this.gl;
    const prog = this.progRelax;
    const texel = 1 / this.size;
    // Height difference two adjacent cells can sustain at the repose angle.
    const maxDrop = this.sand.reposeSlope * (2 / this.size);

    for (let i = 0; i < iterations; i++) {
      this.beginPass(prog, [-1, -1, 1, 1]);
      gl.uniform2f(this.loc(prog, 'uTexel'), texel, texel);
      gl.uniform1f(this.loc(prog, 'uMaxDrop'), maxDrop);
      gl.uniform1f(this.loc(prog, 'uRate'), 0.5);
      this.endPass();
    }
  }

  /** Run the whole pattern in one go, yielding nothing. */
  runToEnd() {
    while (!this.done) this.advance(4096);
    this.relax(2);
  }

  /** Shade the heightfield to the canvas. */
  draw() {
    const gl = this.gl;
    const prog = this.progRender;
    const canvas = gl.canvas as HTMLCanvasElement;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.front.tex);

    const texel = 1 / this.size;
    gl.uniform1i(this.loc(prog, 'uHeight'), 0);
    gl.uniform4f(this.loc(prog, 'uBounds'), -1, -1, 1, 1);
    gl.uniform2f(this.loc(prog, 'uTexel'), texel, texel);
    gl.uniform1f(this.loc(prog, 'uRelief'), this.render.relief);
    gl.uniform1f(this.loc(prog, 'uLightAz'), this.render.lightAzimuth);
    gl.uniform1f(this.loc(prog, 'uLightEl'), this.render.lightElevation);
    gl.uniform3fv(this.loc(prog, 'uSandColor'), this.render.sandColor);
    gl.uniform1f(this.loc(prog, 'uGrain'), this.sand.grain);
    gl.uniform1f(this.loc(prog, 'uAoStrength'), this.render.aoStrength);
    gl.uniform1f(this.loc(prog, 'uAoRadius'), AO_RADIUS_UV);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Snapshot the sand bed, for seeding a later run. */
  captureHeight(): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(this.size * this.size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.front.fbo);
    gl.readPixels(0, 0, this.size, this.size, gl.RED, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Restore a snapshot taken by `captureHeight`. */
  seedHeight(data: Float32Array) {
    const gl = this.gl;
    if (data.length !== this.size * this.size) {
      throw new Error(
        `Height snapshot is ${data.length} samples; expected ${this.size * this.size}.`,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, this.front.tex);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, this.size, this.size, gl.RED, gl.FLOAT, data,
    );
    this.cursor = 0;
    this.relaxedIntervals = 0;
    this.pending = 0;
  }

  dispose() {
    const gl = this.gl;
    for (const t of [this.front, this.back, this.base]) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    gl.deleteVertexArray(this.vao);
    for (const p of [this.progCarve, this.progRelax, this.progReset, this.progRender]) {
      gl.deleteProgram(p);
    }
  }
}

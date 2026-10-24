// Smooth page mapping mm → image px for paper that isn't flat.
//
// A homography handles position, rotation and perspective. Whatever the
// marker centres still disagree with (waves, bulges, a sagging corner) is
// modelled by a thin-plate spline through the leftovers.
//
// Stiffness is picked per scan: the stiffest spline that still hits every
// marker to within the measurement noise. Flat paper → plain homography,
// wavy paper → soft spline. The noise level comes from the markers
// themselves (how well each marker's own 4 corners fit a square).
//
// Version 3 sheets have lines instead of markers. A point on a line only
// says where the line is across it, not along it, so fitLineField takes
// one-dimensional observations: "the image of this mm point lies on that
// line". Each one adds a kernel along its own normal.

import { apply, type Mat3, type Pt } from './geom.ts';

export interface WarpField {
  map(x: number, y: number): Pt;
  /** chosen smoothing, Infinity = plain homography */
  smoothing: number;
}

export interface ControlPoint {
  /** marker centre in mm */
  mm: Pt;
  /** marker centre in image px */
  px: Pt;
}

const UNIT = 100; // mm per kernel unit, keeps the system well conditioned
const STIFF_TO_SOFT = [100, 10, 1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5];

function kernel(r2: number): number {
  return r2 === 0 ? 0 : 0.5 * r2 * Math.log(r2); // r² log r, written with r²
}

export function homographyField(h: Mat3): WarpField {
  return { map: (x, y) => apply(h, x, y), smoothing: Infinity };
}

/**
 * @param noisePx expected error of a marker centre in px
 * @param smoothing force a stiffness instead of choosing one
 */
export function fitWarpField(h: Mat3, pts: ControlPoint[], opts: { noisePx: number; smoothing?: number }): WarpField {
  const n = pts.length;
  if (n < 6) return homographyField(h);
  const m = n + 3;
  const xs = pts.map((p) => p.mm[0] / UNIT);
  const ys = pts.map((p) => p.mm[1] / UNIT);
  const v = pts.map((p) => {
    const q = apply(h, p.mm[0], p.mm[1]);
    return [p.px[0] - q[0], p.px[1] - q[1]];
  });
  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) K[i * n + j] = kernel((xs[i] - xs[j]) ** 2 + (ys[i] - ys[j]) ** 2);

  // plain homography already good enough?
  const rmsH = Math.sqrt(v.reduce((s, [a, b]) => s + a * a + b * b, 0) / n);
  if (opts.smoothing === undefined && rmsH <= opts.noisePx) return homographyField(h);

  let chosen: { coef: Float64Array; lambda: number } | null = null;
  for (const lambda of opts.smoothing !== undefined ? [opts.smoothing] : STIFF_TO_SOFT) {
    const coef = solveTps(K, xs, ys, v, lambda);
    if (!coef) continue;
    chosen = { coef, lambda };
    // residual at the data points of a smoothing spline is λ·w
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (lambda * coef[i * 2]) ** 2 + (lambda * coef[i * 2 + 1]) ** 2;
    if (Math.sqrt(ss / n) <= opts.noisePx) break;
  }
  if (!chosen) return homographyField(h);

  const { coef, lambda } = chosen;
  return {
    smoothing: lambda,
    map(x, y) {
      const base = apply(h, x, y);
      const u = x / UNIT;
      const w = y / UNIT;
      let dx = coef[n * 2] + coef[(n + 1) * 2] * u + coef[(n + 2) * 2] * w;
      let dy = coef[n * 2 + 1] + coef[(n + 1) * 2 + 1] * u + coef[(n + 2) * 2 + 1] * w;
      for (let i = 0; i < n; i++) {
        const k = kernel((u - xs[i]) ** 2 + (w - ys[i]) ** 2);
        dx += coef[i * 2] * k;
        dy += coef[i * 2 + 1] * k;
      }
      return [base[0] + dx, base[1] + dy];
    },
  };

  function solveTps(K: Float64Array, xs: number[], ys: number[], v: number[][], lambda: number): Float64Array | null {
    // [K + λI  P] [w]   [v]
    // [P^T     0] [a] = [0]
    const A = new Float64Array(m * m);
    const B = new Float64Array(m * 2);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i * m + j] = K[i * n + j];
      A[i * m + i] += lambda;
      A[i * m + n] = A[n * m + i] = 1;
      A[i * m + n + 1] = A[(n + 1) * m + i] = xs[i];
      A[i * m + n + 2] = A[(n + 2) * m + i] = ys[i];
      B[i * 2] = v[i][0];
      B[i * 2 + 1] = v[i][1];
    }
    return solve(A, B, m) ? B : null;
  }
}

export interface LineObs {
  /** a point on a printed line, mm */
  mm: Pt;
  /** unit normal of the line in the image */
  n: Pt;
  /** n · (where the line is in the image), px */
  value: number;
}

/** A 2D point as two line observations. */
export function pointObs(mm: Pt, px: Pt): LineObs[] {
  return [
    { mm, n: [1, 0], value: px[0] },
    { mm, n: [0, 1], value: px[1] },
  ];
}

/**
 * Smoothing thin-plate spline on top of a homography, fitted to 1D
 * observations. Picks the stiffness like fitWarpField. `residuals` are
 * n · F(mm) − value per observation, px.
 */
export function fitLineField(
  h: Mat3,
  obs: LineObs[],
  opts: { noisePx: number; smoothing?: number },
): WarpField & { residuals: number[] } {
  const n = obs.length;
  const d = obs.map((o) => {
    const q = apply(h, o.mm[0], o.mm[1]);
    return o.value - (o.n[0] * q[0] + o.n[1] * q[1]);
  });
  const plain = () => Object.assign(homographyField(h), { residuals: d.map((x) => -x) });
  if (n < 12) return plain();
  const rmsH = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / n);
  if (opts.smoothing === undefined && rmsH <= opts.noisePx) return plain();

  const m = n + 6;
  const us = obs.map((o) => o.mm[0] / UNIT);
  const ws = obs.map((o) => o.mm[1] / UNIT);
  const G = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      const v = (obs[i].n[0] * obs[j].n[0] + obs[i].n[1] * obs[j].n[1]) * kernel((us[i] - us[j]) ** 2 + (ws[i] - ws[j]) ** 2);
      G[i * n + j] = G[j * n + i] = v;
    }
  const P = (i: number) => {
    const [nx, ny] = obs[i].n;
    return [nx, nx * us[i], nx * ws[i], ny, ny * us[i], ny * ws[i]];
  };

  const fitWith = (lambda: number) => {
    // [G + λI  P] [α]   [d]
    // [P^T     0] [β] = [0]
    const A = new Float64Array(m * m);
    const B = new Float64Array(m * 2);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i * m + j] = G[i * n + j];
      A[i * m + i] += lambda;
      const p = P(i);
      for (let k = 0; k < 6; k++) A[i * m + n + k] = A[(n + k) * m + i] = p[k];
      B[i * 2] = d[i];
    }
    if (!solve(A, B, m)) return null;
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (lambda * B[i * 2]) ** 2;
    return { coef: B, lambda, rms: Math.sqrt(ss / n) };
  };

  // the residual grows with stiffness, so the stiffest one within the noise is found by halving
  let chosen: { coef: Float64Array; lambda: number } | null = null;
  if (opts.smoothing !== undefined) chosen = fitWith(opts.smoothing);
  else {
    let lo = 0;
    let hi = STIFF_TO_SOFT.length - 1;
    chosen = fitWith(STIFF_TO_SOFT[hi]);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const f = fitWith(STIFF_TO_SOFT[mid]);
      if (f && f.rms <= opts.noisePx) {
        chosen = f;
        hi = mid;
      } else lo = mid + 1;
    }
  }
  if (!chosen) return plain();

  const { coef, lambda } = chosen;
  const a = Float64Array.from({ length: n }, (_, i) => coef[i * 2]);
  const b = Float64Array.from({ length: 6 }, (_, k) => coef[(n + k) * 2]);
  const map = (x: number, y: number): Pt => {
    const base = apply(h, x, y);
    const u = x / UNIT;
    const w = y / UNIT;
    let dx = b[0] + b[1] * u + b[2] * w;
    let dy = b[3] + b[4] * u + b[5] * w;
    for (let i = 0; i < n; i++) {
      const k = a[i] * kernel((u - us[i]) ** 2 + (w - ws[i]) ** 2);
      dx += k * obs[i].n[0];
      dy += k * obs[i].n[1];
    }
    return [base[0] + dx, base[1] + dy];
  };
  return { smoothing: lambda, map, residuals: Array.from(a, (x) => -lambda * x) };
}

/** Gaussian elimination with partial pivoting; solves A X = B in place (B has 2 columns). */
function solve(A: Float64Array, B: Float64Array, m: number): boolean {
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r * m + col]) > Math.abs(A[piv * m + col])) piv = r;
    if (Math.abs(A[piv * m + col]) < 1e-14) return false;
    if (piv !== col) {
      for (let c = col; c < m; c++) [A[col * m + c], A[piv * m + c]] = [A[piv * m + c], A[col * m + c]];
      [B[col * 2], B[piv * 2]] = [B[piv * 2], B[col * 2]];
      [B[col * 2 + 1], B[piv * 2 + 1]] = [B[piv * 2 + 1], B[col * 2 + 1]];
    }
    const d = A[col * m + col];
    for (let r = col + 1; r < m; r++) {
      const f = A[r * m + col] / d;
      if (f === 0) continue;
      for (let c = col; c < m; c++) A[r * m + c] -= f * A[col * m + c];
      B[r * 2] -= f * B[col * 2];
      B[r * 2 + 1] -= f * B[col * 2 + 1];
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    let sx = B[r * 2];
    let sy = B[r * 2 + 1];
    for (let c = r + 1; c < m; c++) {
      sx -= A[r * m + c] * B[c * 2];
      sy -= A[r * m + c] * B[c * 2 + 1];
    }
    B[r * 2] = sx / A[r * m + r];
    B[r * 2 + 1] = sy / A[r * m + r];
  }
  return true;
}

/**
 * How far a marker's 4 detected corners are from a perfect square under an
 * affine fit (RMS, px). Tells the corner noise; a half painted-over marker
 * stands out by a large value.
 */
export function squareResidual(mm: Pt[], px: Pt[]): number {
  // least squares for px = M · [x y 1], separately for u and v (3 unknowns each)
  const AtA = new Float64Array(9);
  const Atu = new Float64Array(3);
  const Atv = new Float64Array(3);
  for (let i = 0; i < mm.length; i++) {
    const r = [mm[i][0], mm[i][1], 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) AtA[a * 3 + b] += r[a] * r[b];
      Atu[a] += r[a] * px[i][0];
      Atv[a] += r[a] * px[i][1];
    }
  }
  const mu = solve3(AtA, Atu);
  const mv = solve3(AtA, Atv);
  if (!mu || !mv) return Infinity;
  let ss = 0;
  for (let i = 0; i < mm.length; i++) {
    const eu = mu[0] * mm[i][0] + mu[1] * mm[i][1] + mu[2] - px[i][0];
    const ev = mv[0] * mm[i][0] + mv[1] * mm[i][1] + mv[2] - px[i][1];
    ss += eu * eu + ev * ev;
  }
  return Math.sqrt(ss / mm.length);
}

function solve3(A: Float64Array, b: Float64Array): number[] | null {
  const det = (m: number[]) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const a = Array.from(A);
  const d = det(a);
  if (Math.abs(d) < 1e-12) return null;
  return [0, 1, 2].map((k) => {
    const mk = [...a];
    for (let r = 0; r < 3; r++) mk[r * 3 + k] = b[r];
    return det(mk) / d;
  });
}

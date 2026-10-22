// Turns a clean page raster into a believable scan / phone photo:
// paint strokes, wavy paper, perspective, rotation, lighting, blur, noise.
// Also returns the exact ground-truth mapping mm → scan px, so tests can
// measure how far off the detector is.

import type { CV } from '../src/core/cv.ts';
import { apply, type Mat3, type Pt } from '../src/core/geom.ts';
import type { RGBAImage } from '../src/core/image.ts';
import type { Rect } from '../src/core/layout.ts';

export interface Scenario {
  name: string;
  outW: number;
  outH: number;
  /** where the page corners (TL, TR, BR, BL) land in the output, px */
  quad: Pt[];
  /** wavy paper: in-plane displacement amplitude and wavelength, mm */
  bendMm?: number;
  waveMm?: number;
  /** paint strokes over the frames; some will hit gutters and markers */
  strokes?: number;
  /** how far strokes may spill over the frame edge, as a fraction of the frame (default 0.25) */
  spill?: number;
  blur?: number;
  noise?: number;
  /** brightness at left/right edge and top/bottom edge, e.g. [0.7, 1.05] */
  lightX?: [number, number];
  lightY?: [number, number];
  background?: [number, number, number];
  seed?: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function fakeScan(
  cv: CV,
  page: RGBAImage,
  dpi: number,
  sc: Scenario,
  paintAreas: Rect[],
): { image: RGBAImage; mmToPx: (x: number, y: number) => Pt } {
  const rand = rng(sc.seed ?? 1);
  const pxmm = dpi / 25.4;

  // --- paint on the paper ---
  const paper = new cv.Mat(page.height, page.width, cv.CV_8UC4);
  paper.data.set(page.data);
  for (let i = 0; i < (sc.strokes ?? 0); i++) {
    const a = paintAreas[Math.floor(rand() * paintAreas.length)];
    // mostly inside the frame, but allowed to spill over the edge
    const sp = sc.spill ?? 0.25;
    const pt = () =>
      new cv.Point(
        Math.round((a.x - a.w * sp + rand() * a.w * (1 + 2 * sp)) * pxmm),
        Math.round((a.y - a.h * sp + rand() * a.h * (1 + 2 * sp)) * pxmm),
      );
    const color = new cv.Scalar(rand() * 255, rand() * 255, rand() * 255, 255);
    const thick = Math.round((1 + rand() * 6) * pxmm);
    let p0 = pt();
    for (let j = 0; j < 3; j++) {
      const p1 = pt();
      cv.line(paper, p0, p1, color, thick, cv.LINE_AA);
      p0 = p1;
    }
  }

  // --- geometry: perspective + wavy paper ---
  const W = page.width;
  const H = page.height;
  const srcQ = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const dstQ = cv.matFromArray(4, 1, cv.CV_32FC2, sc.quad.flat());
  const hm = cv.getPerspectiveTransform(srcQ, dstQ);
  const Hf: Mat3 = Array.from(hm.data64F as Float64Array);
  const hiM = new cv.Mat();
  cv.invert(hm, hiM);
  const Hi: Mat3 = Array.from(hiM.data64F as Float64Array);
  [srcQ, dstQ, hm, hiM].forEach((m) => m.delete());

  const amp = (sc.bendMm ?? 0) * pxmm;
  const lam = (sc.waveMm ?? 100) * pxmm;
  const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const d = (x: number, y: number): Pt =>
    amp === 0
      ? [0, 0]
      : [
          amp * (0.6 * Math.sin((2 * Math.PI * y) / lam + ph[0]) + 0.4 * Math.sin((2 * Math.PI * x) / (1.7 * lam) + ph[2])),
          amp * Math.sin((2 * Math.PI * x) / lam + ph[1]),
        ];

  const mapx = new cv.Mat(sc.outH, sc.outW, cv.CV_32FC1);
  const mapy = new cv.Mat(sc.outH, sc.outW, cv.CV_32FC1);
  const mx = mapx.data32F as Float32Array;
  const my = mapy.data32F as Float32Array;
  for (let v = 0; v < sc.outH; v++)
    for (let u = 0; u < sc.outW; u++) {
      const q = apply(Hi, u + 0.5, v + 0.5);
      const dq = d(q[0], q[1]);
      mx[v * sc.outW + u] = q[0] + dq[0] - 0.5;
      my[v * sc.outW + u] = q[1] + dq[1] - 0.5;
    }
  const bg = sc.background ?? [235, 235, 232];
  const warped = new cv.Mat();
  cv.remap(paper, warped, mapx, mapy, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(bg[0], bg[1], bg[2], 255));
  [paper, mapx, mapy].forEach((m) => m.delete());

  if (sc.blur) {
    const k = Math.max(3, Math.ceil(sc.blur * 3) * 2 + 1);
    cv.GaussianBlur(warped, warped, new cv.Size(k, k), sc.blur, sc.blur);
  }

  // --- light + noise ---
  const out = new Uint8ClampedArray(warped.data);
  warped.delete();
  const [lx0, lx1] = sc.lightX ?? [1, 1];
  const [ly0, ly1] = sc.lightY ?? [1, 1];
  const noise = sc.noise ?? 0;
  for (let v = 0; v < sc.outH; v++) {
    const fy = ly0 + ((ly1 - ly0) * v) / sc.outH;
    for (let u = 0; u < sc.outW; u++) {
      const f = fy * (lx0 + ((lx1 - lx0) * u) / sc.outW);
      const n = noise ? (rand() + rand() + rand() - 1.5) * 2 * noise : 0;
      const o = (v * sc.outW + u) * 4;
      out[o] = out[o] * f + n;
      out[o + 1] = out[o + 1] * f + n;
      out[o + 2] = out[o + 2] * f * 0.97 + n; // slightly warm, like most lamps
    }
  }

  // ground truth: page mm → flat-page px (undo the wave) → output px (OpenCV coords)
  const mmToPx = (x: number, y: number): Pt => {
    const s: Pt = [x * pxmm, y * pxmm];
    let q: Pt = [...s];
    for (let i = 0; i < 20; i++) {
      const dq = d(q[0], q[1]);
      q = [s[0] - dq[0], s[1] - dq[1]];
    }
    const u = apply(Hf, q[0], q[1]);
    return [u[0] - 0.5, u[1] - 0.5];
  };

  return { image: { width: sc.outW, height: sc.outH, data: out }, mmToPx };
}

/** Page corners placed on an output canvas: rotation (deg), scale, offset, perspective squeeze. */
export function placePage(
  pageW: number,
  pageH: number,
  o: { outW: number; outH: number; rot: number; scale: number; dx?: number; dy?: number; squeezeTop?: number; squeezeLeft?: number },
): Pt[] {
  const w = pageW * o.scale;
  const h = pageH * o.scale;
  const st = o.squeezeTop ?? 0;
  const sl = o.squeezeLeft ?? 0;
  // corners around the centre, with perspective-ish squeeze of the top / left edge
  const local: Pt[] = [
    [-w / 2 + w * st, -h / 2 + h * sl],
    [w / 2 - w * st, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2 - h * sl],
  ];
  const a = (o.rot * Math.PI) / 180;
  const cx = o.outW / 2 + (o.dx ?? 0);
  const cy = o.outH / 2 + (o.dy ?? 0);
  return local.map(([x, y]) => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]);
}

// Scan or photo of one sheet → the frames printed on it.
//
//  1. find all ArUco markers
//  2. corner anchors tell paper format + orientation → rough page fit
//  3. read the QR code from the rectified page → project, page, grid
//  4. fit the whole page (RANSAC, drops misread markers)
//  5. smooth warp field through all markers, so bent / wavy paper lines up
//  6. cut each frame out at a fixed size

import jsQRModule from 'jsqr';
import { loadCv, type CV } from './cv.ts';
import { apply, dist, median, mul, type Mat3, type Pt } from './geom.ts';
import type { RGBAImage } from './image.ts';
import {
  computeLayout,
  markerCorners,
  pageSize,
  parseAnchorId,
  qrRect,
  type Layout,
  type MarkerPlace,
  type PaperId,
  type Rect,
} from './layout.ts';
import { decodePayload, firstFrameOfPage, type SheetPayload } from './payload.ts';
import { fitWarpField, squareResidual, type ControlPoint, type WarpField } from './warpfield.ts';

const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ?? jsQRModule) as typeof jsQRModule;

export interface DetectedMarker {
  id: number;
  /** image px, ArUco order TL TR BR BL */
  corners: Pt[];
}

export interface ExtractedFrame {
  /** 0-based index in the animation */
  index: number;
  image: RGBAImage;
  /** how many of the 4 markers around this frame were usable */
  cornerMarkers: number;
  /** image px outline TL TR BR BL */
  quad: Pt[];
}

export interface PageResult {
  payload: SheetPayload | null;
  /** true if the QR code could not be read and opts.fallbackPayload was used */
  usedFallback: boolean;
  markers: DetectedMarker[];
  /** markers that agreed with the page fit */
  inlierIds: number[];
  frames: ExtractedFrame[];
  /** page mm → image px */
  field: WarpField | null;
  pxPerMm: number;
  pageQuad: Pt[] | null;
  warnings: string[];
  timings: Record<string, number>;
}

export interface DetectOptions {
  /** output frame width in px (height follows the aspect). Default: scan resolution, max 1920 */
  frameWidth?: number;
  /** alternative to frameWidth: size of the longer frame side in px */
  frameLongSide?: number;
  /** used when the QR code can't be read (e.g. layout from another page of the same project) */
  fallbackPayload?: SheetPayload;
  /** warp field smoothing; higher = stiffer paper */
  smoothing?: number;
}

export async function detectPage(img: RGBAImage, opts: DetectOptions = {}): Promise<PageResult> {
  const cv = await loadCv();
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - t);
    t = now;
  };
  const warnings: string[] = [];
  const result: PageResult = {
    payload: null,
    usedFallback: false,
    markers: [],
    inlierIds: [],
    frames: [],
    field: null,
    pxPerMm: NaN,
    pageQuad: null,
    warnings,
    timings,
  };

  const src = new cv.Mat(img.height, img.width, cv.CV_8UC4);
  const gray = new cv.Mat();
  try {
    src.data.set(img.data);
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    lap('prep');

    const markers = findMarkers(cv, gray);
    result.markers = markers;
    lap('markers');
    if (!markers.length) {
      warnings.push('no markers found');
      return result;
    }

    // --- format from anchors, rough page fit, QR ---
    const anchors = markers
      .map((m) => ({ m, a: parseAnchorId(m.id) }))
      .filter((x): x is { m: DetectedMarker; a: NonNullable<ReturnType<typeof parseAnchorId>> } => !!x.a);
    const format = voteFormat(anchors.map((x) => x.a));

    let payload: SheetPayload | null = null;
    if (format) {
      const fmtAnchors = anchors.filter((x) => x.a.paper === format.paper && x.a.landscape === format.landscape);
      const places = anchorPlaces(format.paper, format.landscape);
      const corr = (xs: typeof fmtAnchors) => xs.map((x) => ({ mm: markerCorners(places[x.a.corner]), px: x.m.corners }));
      // whole page first; on wavy paper the anchor right next to the code follows it better
      const fits = [fitHomography(cv, corr(fmtAnchors), 0), fitHomography(cv, corr(fmtAnchors.filter((x) => x.a.corner === 2)), 0)];
      const qrArea = qrRect(format.paper, format.landscape);
      for (const fit of fits) {
        if (fit) payload = readQrRectified(cv, gray, fit, qrArea);
        if (payload) break;
      }
    }
    if (!payload) payload = readQrAnywhere(img);
    lap('qr');
    if (!payload) {
      if (!opts.fallbackPayload) {
        warnings.push('QR code not readable');
        return result;
      }
      payload = opts.fallbackPayload;
      result.usedFallback = true;
      warnings.push('QR code not readable, used fallback layout');
    }
    result.payload = payload;
    if (format && (format.paper !== payload.spec.paper || format.landscape !== payload.spec.landscape))
      warnings.push('corner markers and QR code disagree on the paper format');

    // --- full page fit ---
    const layout = computeLayout(payload.spec);
    const known = matchToLayout(markers, layout);
    if (!known.length) {
      warnings.push('no markers of this sheet found');
      return result;
    }
    result.pxPerMm = estimatePxPerMm(known);
    const thr = 6 * result.pxPerMm; // loose: bent paper is allowed, misreads are not
    const global = fitHomography(
      cv,
      known.map((k) => ({ mm: markerCorners(k.place), px: k.marker.corners })),
      thr,
    );
    if (!global) {
      warnings.push('could not fit the page');
      return result;
    }
    // markers whose own corners don't form a clean square are half covered or misread
    const squareErr = known.map((k) => squareResidual(markerCorners(k.place), k.marker.corners));
    const noise = median(squareErr);
    const clean = known.filter((_, i) => squareErr[i] <= Math.max(1, 5 * noise));
    const inliers = pickInliers(clean, global, thr);
    result.inlierIds = inliers.map((k) => k.place.id);
    if (inliers.length < known.length)
      warnings.push(`${known.length - inliers.length} marker(s) ignored (painted over or misread)`);
    // corners also carry the local tilt of the paper; with very many markers
    // use centres to keep the spline solve fast
    const useCorners = inliers.length * 4 <= 400;
    const controls: ControlPoint[] = useCorners
      ? inliers.flatMap((k) => markerCorners(k.place).map((mm, i) => ({ mm, px: k.marker.corners[i] })))
      : inliers.map((k) => ({
          mm: [k.place.x + k.place.size / 2, k.place.y + k.place.size / 2],
          px: [avg(k.marker.corners.map((c) => c[0])), avg(k.marker.corners.map((c) => c[1]))],
        }));
    // square residual is ~σ/√2 per corner; a correct fit leaves ~√2·σ per corner, ~σ/2 per centre
    const noisePx = useCorners ? Math.max(0.2, 2.2 * noise) : Math.max(0.15, 1.5 * noise);
    const field = fitWarpField(global, controls, { noisePx, smoothing: opts.smoothing });
    result.field = field;
    result.pageQuad = pageCorners(layout).map(([x, y]) => field.map(x, y));
    lap('fit');

    // --- frames ---
    const first = firstFrameOfPage(payload);
    const aspect = payload.spec.aspect;
    const fw = even(
      opts.frameWidth ??
        (opts.frameLongSide ? (aspect >= 1 ? opts.frameLongSide : opts.frameLongSide * aspect) : undefined) ??
        Math.min(1920, layout.cellW * result.pxPerMm),
    );
    const fh = even(fw / payload.spec.aspect);
    const cols = payload.spec.cols;
    const found = new Set(result.inlierIds);

    layout.cells.forEach((cell, k) => {
      const index = first + k;
      if (index >= payload.frameCount) return;
      const r = Math.floor(k / cols);
      const c = k % cols;
      const ring = [r * (cols + 1) + c, r * (cols + 1) + c + 1, (r + 1) * (cols + 1) + c, (r + 1) * (cols + 1) + c + 1];
      const image = warpCell(cv, src, field, cell, fw, fh);
      const quad = rectCorners(cell).map(([x, y]) => field.map(x, y));
      result.frames.push({ index, image, cornerMarkers: ring.filter((id) => found.has(id)).length, quad });
    });
    lap('frames');
    return result;
  } finally {
    src.delete();
    gray.delete();
  }
}

// ---------------------------------------------------------------------------

function findMarkers(cv: CV, gray: CV): DetectedMarker[] {
  const dict = cv.getPredefinedDictionary(cv.DICT_4X4_250);
  const params = new cv.aruco_DetectorParameters();
  params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX ?? 1;
  params.minMarkerPerimeterRate = 0.01;
  const refine = new cv.aruco_RefineParameters(10, 3, true);
  const det = new cv.aruco_ArucoDetector(dict, params, refine);
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  try {
    det.detectMarkers(gray, corners, ids, rejected);
    const out: DetectedMarker[] = [];
    for (let i = 0; i < corners.size(); i++) {
      const c = corners.get(i);
      const d = c.data32F;
      out.push({ id: ids.data32S[i], corners: [0, 1, 2, 3].map((j) => [d[j * 2], d[j * 2 + 1]] as Pt) });
      c.delete();
    }
    return out;
  } finally {
    det.delete();
    refine.delete?.();
    params.delete();
    dict.delete?.();
    corners.delete();
    ids.delete();
    rejected.delete();
  }
}

function estimatePxPerMm(known: Known[]): number {
  return median(
    known.map(({ marker: m, place }) => {
      const c = m.corners;
      const side = (dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3]) + dist(c[3], c[0])) / 4;
      return side / place.size;
    }),
  );
}

function voteFormat(as: { paper: PaperId; landscape: boolean }[]): { paper: PaperId; landscape: boolean } | null {
  const votes = new Map<string, number>();
  for (const a of as) votes.set(`${a.paper}:${a.landscape}`, (votes.get(`${a.paper}:${a.landscape}`) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, v] of votes) if (!best || v > votes.get(best)!) best = k;
  if (!best) return null;
  const [paper, landscape] = best.split(':');
  return { paper: paper as PaperId, landscape: landscape === 'true' };
}

/** Anchor positions don't depend on the grid, so any valid grid gives them. */
function anchorPlaces(paper: PaperId, landscape: boolean): MarkerPlace[] {
  return computeLayout({ paper, landscape, cols: 1, rows: 1, aspect: 1, frameW: 30, gap: 8 }).anchors;
}

interface Corr {
  mm: Pt[];
  px: Pt[];
}

/** mm → px homography. thr > 0: RANSAC with that px threshold, else least squares. */
function fitHomography(cv: CV, corrs: Corr[], thr: number): Mat3 | null {
  const mm = corrs.flatMap((c) => c.mm.flat());
  const px = corrs.flatMap((c) => c.px.flat());
  const n = mm.length / 2;
  if (n < 4) return null;
  const a = cv.matFromArray(n, 1, cv.CV_32FC2, mm);
  const b = cv.matFromArray(n, 1, cv.CV_32FC2, px);
  const mask = new cv.Mat();
  try {
    const h = thr > 0 ? cv.findHomography(a, b, cv.RANSAC, thr, mask) : cv.findHomography(a, b, 0);
    const out = h.empty() ? null : Array.from(h.data64F as Float64Array);
    h.delete();
    return out && out.every(Number.isFinite) ? out : null;
  } finally {
    a.delete();
    b.delete();
    mask.delete();
  }
}

interface Known {
  marker: DetectedMarker;
  place: MarkerPlace;
}

function matchToLayout(markers: DetectedMarker[], layout: Layout): Known[] {
  const places = new Map<number, MarkerPlace>();
  for (const p of layout.gridMarkers) places.set(p.id, p);
  for (const p of layout.anchors) places.set(p.id, p);
  return markers.flatMap((m) => {
    const place = places.get(m.id);
    return place ? [{ marker: m, place }] : [];
  });
}

function reprojError(k: Known, h: Mat3): number {
  const mm = markerCorners(k.place);
  return Math.max(...mm.map(([x, y], i) => dist(apply(h, x, y), k.marker.corners[i])));
}

/** Drops markers that don't fit the page and resolves duplicate IDs. */
function pickInliers(known: Known[], h: Mat3, thr: number): Known[] {
  const best = new Map<number, { k: Known; err: number }>();
  for (const k of known) {
    const err = reprojError(k, h);
    if (err > thr) continue;
    const prev = best.get(k.place.id);
    if (!prev || err < prev.err) best.set(k.place.id, { k, err });
  }
  return [...best.values()].map((v) => v.k);
}

/** Matrix mapping output px (pixel centres) → mm inside rect r. */
function outToMm(r: Rect, w: number, h: number): Mat3 {
  return [r.w / w, 0, r.x + (0.5 * r.w) / w, 0, r.h / h, r.y + (0.5 * r.h) / h, 0, 0, 1];
}

/** Cuts one frame out through the warp field (evaluated on a coarse grid, bilinear in between). */
function warpCell(cv: CV, src: CV, field: WarpField, cell: Rect, w: number, h: number): RGBAImage {
  const step = w > 800 ? 16 : 8;
  const gw = Math.ceil(w / step) + 1;
  const gh = Math.ceil(h / step) + 1;
  const gx = new Float64Array(gw * gh);
  const gy = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const [px, py] = field.map(cell.x + ((i * step + 0.5) * cell.w) / w, cell.y + ((j * step + 0.5) * cell.h) / h);
      gx[j * gw + i] = px;
      gy[j * gw + i] = py;
    }
  const mapx = new cv.Mat(h, w, cv.CV_32FC1);
  const mapy = new cv.Mat(h, w, cv.CV_32FC1);
  const mx = mapx.data32F as Float32Array;
  const my = mapy.data32F as Float32Array;
  for (let v = 0; v < h; v++) {
    const j = Math.min(Math.floor(v / step), gh - 2);
    const tj = v / step - j;
    for (let u = 0; u < w; u++) {
      const i = Math.min(Math.floor(u / step), gw - 2);
      const ti = u / step - i;
      const a = j * gw + i;
      const b = a + gw;
      mx[v * w + u] = (gx[a] * (1 - ti) + gx[a + 1] * ti) * (1 - tj) + (gx[b] * (1 - ti) + gx[b + 1] * ti) * tj;
      my[v * w + u] = (gy[a] * (1 - ti) + gy[a + 1] * ti) * (1 - tj) + (gy[b] * (1 - ti) + gy[b + 1] * ti) * tj;
    }
  }
  const dst = new cv.Mat();
  try {
    cv.remap(src, dst, mapx, mapy, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return { width: w, height: h, data: new Uint8ClampedArray(dst.data) };
  } finally {
    mapx.delete();
    mapy.delete();
    dst.delete();
  }
}

function readQrRectified(cv: CV, gray: CV, mmToPx: Mat3, qr: Rect): SheetPayload | null {
  // The rough fit can be a few mm off on bent paper, so look at a generous
  // region. White-out first only removes the far surroundings, then also the
  // anchor 3 mm to the right of the code (it can confuse the decoder).
  const quiet = 6;
  const scale = 12; // px per mm
  const region: Rect = { x: qr.x - quiet, y: qr.y - quiet, w: qr.w + 2 * quiet, h: qr.h + 2 * quiet };
  const w = Math.round(region.w * scale);
  const h = Math.round(region.h * scale);
  const m = cv.matFromArray(3, 3, cv.CV_64F, mul(mmToPx, outToMm(region, w, h)));
  const dst = new cv.Mat();
  try {
    cv.warpPerspective(gray, dst, m, new cv.Size(w, h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
    for (const padMm of [2.5, 6, 1]) {
      const x0 = (quiet - padMm) * scale;
      const x1 = (quiet + qr.w + padMm) * scale;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const inside = x >= x0 && x < x1 && y >= x0 && y < x1;
          const v = inside ? dst.data[y * w + x] : 255;
          const o = (y * w + x) * 4;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
          rgba[o + 3] = 255;
        }
      const code = jsQR(rgba, w, h, { inversionAttempts: 'dontInvert' });
      const payload = code ? decodePayload(code.data) : null;
      if (payload) return payload;
    }
    return null;
  } finally {
    m.delete();
    dst.delete();
  }
}

function readQrAnywhere(img: RGBAImage): SheetPayload | null {
  const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
  const code = jsQR(data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return code ? decodePayload(code.data) : null;
}

function rectCorners(r: Rect): Pt[] {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ];
}

function pageCorners(layout: Layout): Pt[] {
  const { w, h } = pageSize(layout.spec.paper, layout.spec.landscape);
  return rectCorners({ x: 0, y: 0, w, h });
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

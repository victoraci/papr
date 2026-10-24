// Version 3 page fit: follow the edges of the printed pictures.
//
// Nothing but the pictures is printed between the corner squares, and every
// picture ends in a sharp edge against the white paper around it. The
// corner anchors give a rough page fit; then, all along every picture edge,
// the detector looks across the edge for the step from picture to clean
// paper and measures it to a fraction of a pixel. Hundreds of these small
// measurements go into a thin-plate spline (fitLineField) for the page.
//
//  pass 1  wide search (the paper may be bent by a few mm); per edge the
//          most consistent run of candidates wins (dynamic programming), so
//          things in the picture can't pull the edge away
//  pass 2+ narrow search around the fitted field
//
// Every pass drops measurements that don't agree with their neighbours on
// the same edge: paper bends smoothly, paint spilling over an edge doesn't.
// Printed pictures come out a little bigger than drawn (ink spreads, the
// scan blurs); neighbouring pictures tell by how much (edgeSpread).
// Inside each frame the field is blended from its four edges (blendInside).
//
// Photo sheets (layout 4) also have the grid markers of layout 2: their fit
// is the starting point, and their corners stay in the spline next to the
// edges.

import type { CV } from './cv.ts';
import { estimatePxPerMm, fitByMarkers, fitHomography, matchToLayout, type DetectedMarker, type DetectOptions, type PageFit } from './detect.ts';
import { apply, median, type Mat3, type Pt } from './geom.ts';
import type { RGBAImage } from './image.ts';
import { markerCorners, type Layout, type Rect } from './layout.ts';
import { fitLineField, homographyField, pointObs, type LineObs, type WarpField } from './warpfield.ts';

const STEP = 1; // mm between measurements along an edge
const NEAR_CORNER = 1; // mm; the other edge of the corner gets into the profile there
const WINDOW = 0.6; // mm of picture / paper looked at on each side of an edge
const MAX_OBS = 520; // keeps the spline solve quick
const MAX_SLOPE = 0.25; // how fast an edge may drift off the rough fit, mm per mm (wavy paper)

/** One side of a printed picture. */
interface Edge {
  cell: number;
  /** true: runs along x at y = at; false: along y at x = at */
  horizontal: boolean;
  at: number;
  from: number;
  to: number;
  /** +1: the paper is on the side of larger y (or x) */
  out: 1 | -1;
}

interface Site {
  edge: number;
  /** position along the edge, mm */
  s: number;
  mm: Pt;
}

interface Candidate {
  /** offset along the outward normal from the predicted position, px */
  off: number;
  /** contrast of the step against the paper, 0–1 */
  score: number;
}

interface Measure {
  site: Site;
  /** predicted image position and outward unit normal there */
  q: Pt;
  n: Pt;
  /** px per mm across the edge */
  scale: number;
  cands: Candidate[];
}

/** Where an edge was found, along direction `dir`, and how far off the rough fit that is. */
interface Found {
  site: Site;
  dir: Pt;
  /** dir · image position, px */
  value: number;
  /** distance from where the anchor fit puts it, mm; bends slowly along an edge */
  off: number;
  /** px per mm across the edge */
  scale: number;
  /** the found point, image px */
  px: Pt;
}

type Img = { data: Uint8Array; w: number; h: number };

export function fitByEdges(
  cv: CV,
  image: RGBAImage,
  markers: DetectedMarker[],
  layout: Layout,
  frames: number,
  opts: DetectOptions,
): PageFit {
  const warnings: string[] = [];
  const out: PageFit = { field: null, pxPerMm: NaN, inlierIds: [], warnings, seenAround: () => 0 };
  let H: Mat3 | null;
  let fixed: LineObs[];
  // where the edges are expected to be, and what they are checked against
  let ref: WarpField;
  if (layout.gridMarkers.length) {
    const base = fitByMarkers(cv, markers, layout, opts);
    warnings.push(...base.warnings);
    if (!base.field || !base.homography) return out;
    Object.assign(out, { pxPerMm: base.pxPerMm, inlierIds: base.inlierIds, field: base.field });
    H = base.homography;
    ref = base.field;
    fixed = (base.controls ?? []).flatMap((c) => pointObs(c.mm, c.px));
  } else {
    const anchors = matchToLayout(markers, layout);
    if (!anchors.length) {
      warnings.push('no corner squares of this sheet found');
      return out;
    }
    out.pxPerMm = estimatePxPerMm(anchors);
    H = fitHomography(
      cv,
      anchors.map((k) => ({ mm: markerCorners(k.place), px: k.marker.corners })),
      0,
    );
    if (!H) {
      warnings.push('could not fit the page');
      return out;
    }
    out.inlierIds = anchors.map((k) => k.place.id);
    out.field = ref = homographyField(H);
    fixed = anchors.flatMap((k) => markerCorners(k.place).flatMap((mm, i) => pointObs(mm, k.marker.corners[i])));
  }
  if (opts.edges === false) return out;
  const base = H;

  const img = darkest(image);
  const edges = pictureEdges(layout, frames);
  const sites = edgeSites(edges);
  let field: WarpField = out.field!;
  let found: Found[] = [];

  // pass 1 reaches as far as the paper may plausibly be off, short of the next picture;
  // the marker fit of a photo sheet is close already
  const radii = [layout.gridMarkers.length ? 1.2 : Math.max(1, Math.min(3.5, layout.spec.gap - 1.5)), 0.8, 0.5];
  for (let pass = 0; pass < radii.length; pass++) {
    const ms = sites.map((site) => measure(img, field, edges[site.edge], site, radii[pass]));
    const picked = pass === 0 ? pickRuns(ms, edges.length) : ms.filter((m) => m.cands.length);
    found = picked.map((m) => {
      const off = m.cands[0].off;
      const px: Pt = [m.q[0] + off * m.n[0], m.q[1] + off * m.n[1]];
      const value = m.n[0] * px[0] + m.n[1] * px[1];
      // judged against the first fit: the spline may already have followed a bad point
      const h = ref.map(m.site.mm[0], m.site.mm[1]);
      return { site: m.site, dir: m.n, value, off: (value - (m.n[0] * h[0] + m.n[1] * h[1])) / m.scale, scale: m.scale, px };
    });
    found = smoothAlongEdges(found);
    // the first pass is too rough to tell
    const grow = pass === 0 ? { x: 0, y: 0 } : edgeSpread(found, layout);
    if (pass > 0) found = facingAgree(found, layout, grow);
    for (const f of found) {
      const b = isTopOrBottom(f) ? grow.y : grow.x;
      f.value -= b * f.scale;
      f.off -= b;
    }
    const obs = group(found, Math.max(150, MAX_OBS - fixed.length));
    const noisePx = Math.max(0.12, 1.5 * spread(found));
    field = fitLineField(base, [...fixed, ...obs], { noisePx, smoothing: opts.smoothing });
  }

  out.field = opts.interior === 'spline' ? field : blendInside(field, base, layout);
  out.linePoints = found.map((f) => pointAt(field, f));
  out.linesLooked = sites.length;
  if (found.length < sites.length * 0.3)
    warnings.push(`picture edges found at only ${Math.round((100 * found.length) / sites.length)} % of places (white edges or lots of paint)`);
  out.seenAround = (k) => [0, 1, 2, 3].filter((side) => found.some((f) => f.site.edge === k * 4 + side)).length;
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Darkness per pixel as the smallest of R, G and B: a yellow picture stands
 * out from white paper as clearly as a dark one.
 */
function darkest(image: RGBAImage): Img {
  const n = image.width * image.height;
  const data = new Uint8Array(n);
  const d = image.data;
  for (let i = 0, o = 0; i < n; i++, o += 4) data[i] = Math.min(d[o], d[o + 1], d[o + 2]);
  return { data, w: image.width, h: image.height };
}

/** The four sides of every printed picture, 4·k + (top, right, bottom, left). */
function pictureEdges(layout: Layout, frames: number): Edge[] {
  const out: Edge[] = [];
  layout.cells.forEach((c: Rect, cell) => {
    // empty cells on the last sheet still get entries, so edge = 4·cell + side holds
    const real = cell < frames;
    const e = (horizontal: boolean, at: number, from: number, to: number, side: 1 | -1): Edge => ({
      cell,
      horizontal,
      at,
      from: real ? from : 0,
      to: real ? to : -1,
      out: side,
    });
    out.push(e(true, c.y, c.x, c.x + c.w, -1), e(false, c.x + c.w, c.y, c.y + c.h, 1), e(true, c.y + c.h, c.x, c.x + c.w, 1), e(false, c.x, c.y, c.y + c.h, -1));
  });
  return out;
}

function edgeSites(edges: Edge[]): Site[] {
  const out: Site[] = [];
  edges.forEach((e, edge) => {
    for (let s = e.from + NEAR_CORNER; s <= e.to - NEAR_CORNER + 1e-6; s += STEP) out.push({ edge, s, mm: e.horizontal ? [s, e.at] : [e.at, s] });
  });
  return out;
}

function sample(img: Img, x: number, y: number): number {
  if (!(x >= 0 && y >= 0 && x <= img.w - 1 && y <= img.h - 1)) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * img.w + x0;
  const dx = x0 < img.w - 1 ? 1 : 0;
  const dy = y0 < img.h - 1 ? img.w : 0;
  const d = img.data;
  return (d[i] * (1 - fx) + d[i + dx] * fx) * (1 - fy) + (d[i + dy] * (1 - fx) + d[i + dy + dx] * fx) * fy;
}

/**
 * Looks across an edge at one place: a brightness profile along the outward
 * normal, averaged over a short piece of the edge. A candidate is a step up
 * to paper that stays flat for a while; its position is where the profile
 * crosses halfway between picture and paper.
 */
function measure(img: Img, field: WarpField, edge: Edge, site: Site, radius: number): Measure {
  const [x, y] = site.mm;
  const h = edge.horizontal;
  const q = field.map(x, y);
  const a = field.map(x + (h ? 0 : 0.5 * edge.out), y + (h ? 0.5 * edge.out : 0));
  const b = field.map(x - (h ? 0 : 0.5 * edge.out), y - (h ? 0.5 * edge.out : 0));
  const ta = field.map(x + (h ? 0.5 : 0), y + (h ? 0 : 0.5));
  const tb = field.map(x - (h ? 0.5 : 0), y - (h ? 0 : 0.5));
  const scale = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const tscale = Math.hypot(ta[0] - tb[0], ta[1] - tb[1]);
  const n: Pt = [(a[0] - b[0]) / scale, (a[1] - b[1]) / scale];
  const t: Pt = [(ta[0] - tb[0]) / tscale, (ta[1] - tb[1]) / tscale];
  const m: Measure = { site, q, n, scale, cands: [] };

  const dt = 0.5; // px
  const g = Math.max(0.7, 0.12 * scale); // blur around the edge
  const w = Math.max(2, WINDOW * scale);
  const reach = radius * scale + g + 2 * w + 1;
  const len = Math.ceil((2 * reach) / dt) + 1;
  const prof = new Float64Array(len);
  const along = [-0.5, 0, 0.5].map((v) => v * tscale);
  for (let k = 0; k < len; k++) {
    const u = -reach + k * dt;
    let sum = 0;
    for (const v of along) {
      const val = sample(img, q[0] + u * n[0] + v * t[0], q[1] + u * n[1] + v * t[1]);
      if (Number.isNaN(val)) return m;
      sum += val;
    }
    prof[k] = sum / along.length;
  }
  const pre = new Float64Array(len + 1);
  for (let k = 0; k < len; k++) pre[k + 1] = pre[k] + prof[k];
  const idx = (u: number) => Math.max(0, Math.min(len - 1, Math.round((u + reach) / dt)));
  const mean = (u0: number, u1: number) => (pre[idx(u1) + 1] - pre[idx(u0)]) / (idx(u1) - idx(u0) + 1);

  // the clean paper in the gap is the brightest thing around (print can't be whiter than paper)
  const white = [...prof].sort((p, r) => p - r)[Math.floor(0.92 * (len - 1))];
  const scores: { c: number; score: number; inside: number; paper: number }[] = [];
  for (let c = -radius * scale; c <= radius * scale + 1e-9; c += dt) {
    const inside = mean(c - g - w, c - g);
    const paper = mean(c + g, c + g + w);
    const far = mean(c + g + w, c + g + 2 * w);
    // outside has to be that paper, and stay flat; a bright part of the picture usually isn't
    const flat = Math.abs(paper - far) <= 0.06 * paper && paper >= 0.93 * white;
    const score = flat && paper > 0 ? (paper - inside) / paper : 0;
    scores.push({ c, score, inside, paper });
  }
  const peaks = scores.filter(
    (p, i) =>
      p.score >= 0.05 &&
      p.paper - p.inside >= 6 &&
      (i === 0 || p.score >= scores[i - 1].score) &&
      (i === scores.length - 1 || p.score > scores[i + 1].score),
  );
  peaks.sort((p, r) => r.score - p.score);
  for (const p of peaks.slice(0, 3)) {
    const level = (p.inside + p.paper) / 2;
    // upward crossing of the half level nearest to the peak, between profile samples
    let best = NaN;
    for (let k = idx(p.c - g - w / 2); k < idx(p.c + g + w / 2); k++) {
      if (prof[k] < level && prof[k + 1] >= level) {
        const c = -reach + (k + (level - prof[k]) / (prof[k + 1] - prof[k])) * dt;
        if (Number.isNaN(best) || Math.abs(c - p.c) < Math.abs(best - p.c)) best = c;
      }
    }
    if (!Number.isNaN(best)) m.cands.push({ off: best, score: p.score });
  }
  return m;
}

/**
 * Pass 1: per edge, the chain of candidates that is strongest overall while
 * drifting only slowly along the edge. Everything off that chain is dropped.
 */
function pickRuns(ms: Measure[], edgeCount: number): Measure[] {
  const byEdge: Measure[][] = Array.from({ length: edgeCount }, () => []);
  for (const m of ms) if (m.cands.length) byEdge[m.site.edge].push(m);
  const out: Measure[] = [];
  for (const seq of byEdge) {
    if (!seq.length) continue;
    seq.sort((a, b) => a.site.s - b.site.s);
    // best[i][k]: lowest cost of a chain ending in candidate k of measurement i
    const best = seq.map((m) => m.cands.map(() => 0));
    const from = seq.map((m) => m.cands.map(() => [-1, -1] as [number, number]));
    for (let i = 0; i < seq.length; i++)
      seq[i].cands.forEach((c, k) => {
        const offMm = c.off / seq[i].scale;
        let cost = 0;
        for (let j = i - 1; j >= 0; j--) {
          const d = seq[i].site.s - seq[j].site.s;
          if (d > 30) break;
          const tol = 0.15 + MAX_SLOPE * d;
          seq[j].cands.forEach((cj, kj) => {
            const delta = Math.abs(offMm - cj.off / seq[j].scale);
            if (delta > tol) return;
            // drifting is allowed, jumping costs more than a candidate can gain
            const v = best[j][kj] + 0.5 * (delta / (0.15 + 0.15 * d)) ** 2;
            if (v < cost) {
              cost = v;
              from[i][k] = [j, kj];
            }
          });
        }
        best[i][k] = cost - c.score;
      });
    let end: [number, number] = [-1, -1];
    let low = 0;
    best.forEach((row, i) =>
      row.forEach((v, k) => {
        if (v < low) {
          low = v;
          end = [i, k];
        }
      }),
    );
    while (end[0] >= 0) {
      const [i, k] = end;
      out.push({ ...seq[i], cands: [seq[i].cands[k]] });
      end = from[i][k];
    }
  }
  return out;
}

/**
 * Drops measurements that disagree with their neighbours on the same edge.
 * The neighbours' offsets get a robust straight-line fit (median slope);
 * paper doesn't bend sharply within a few millimetres.
 */
function smoothAlongEdges(found: Found[]): Found[] {
  // twice: once the worst are gone, the neighbours tell the trend better
  return dropOddOnes(dropOddOnes(found, 4), 3);
}

function dropOddOnes(found: Found[], strict: number): Found[] {
  const byEdge = new Map<number, Found[]>();
  for (const f of found) {
    const list = byEdge.get(f.site.edge) ?? [];
    list.push(f);
    byEdge.set(f.site.edge, list);
  }
  const keep: Found[] = [];
  for (const list of byEdge.values()) {
    list.sort((a, b) => a.site.s - b.site.s);
    list.forEach((f, i) => {
      // wide enough that a blob of paint is the minority
      const near = list.filter((o, j) => j !== i && Math.abs(o.site.s - f.site.s) <= 16);
      // a lone measurement on an edge can't be checked
      if (near.length < 4) return;
      const ms = median(near.map((o) => o.site.s));
      const mo = median(near.map((o) => o.off));
      const slopes: number[] = [];
      for (let a = 0; a < near.length; a += 2)
        for (let b = a + 1; b < near.length; b += 2) {
          const ds = near[b].site.s - near[a].site.s;
          if (Math.abs(ds) > 3) slopes.push((near[b].off - near[a].off) / ds);
        }
      const slope = slopes.length ? median(slopes) : 0;
      const expect = mo + slope * (f.site.s - ms);
      // scatter of the better half, so a cluster of bad ones can't widen it
      const dev = near.map((o) => Math.abs(o.off - (mo + slope * (o.site.s - ms)))).sort((a, b) => a - b);
      const scatter = 1.4826 * dev[Math.floor(dev.length / 2)];
      if (Math.abs(f.off - expect) <= Math.max(0.15, strict * scatter)) keep.push(f);
    });
  }
  return keep;
}

const isTopOrBottom = (f: Found) => f.site.edge % 2 === 0;

/**
 * How far every picture edge sits outside where it was drawn, mm, for the
 * left/right (x) and top/bottom (y) edges. Across a gap two pictures face
 * each other; the paper can't bend noticeably over those few millimetres,
 * so the gap between them shows twice the spread directly.
 */
function edgeSpread(found: Found[], layout: Layout): { x: number; y: number } {
  const at = new Map<string, Found>();
  for (const f of found) at.set(`${f.site.edge}:${f.site.s.toFixed(2)}`, f);
  const { gap } = layout.spec;
  const est = (pairs: [number, number][]) => {
    const bs: number[] = [];
    for (const [a, b] of pairs)
      for (const f of found) {
        if (f.site.edge !== a) continue;
        const g = at.get(`${b}:${f.site.s.toFixed(2)}`);
        if (!g) continue;
        const between = (f.dir[0] * (g.px[0] - f.px[0]) + f.dir[1] * (g.px[1] - f.px[1])) / ((f.scale + g.scale) / 2);
        bs.push((gap - between) / 2);
      }
    // ink spread and blur are a fraction of a millimetre; more means something else went wrong
    return bs.length >= 10 ? Math.max(-0.3, Math.min(0.3, median(bs))) : 0;
  };
  const pairs = facingPairs(layout);
  return { x: est(pairs.filter((p) => p.x).map((p) => p.pair)), y: est(pairs.filter((p) => !p.x).map((p) => p.pair)) };
}

/** Pairs of edges facing each other across a gap: right/left and bottom/top. */
function facingPairs(layout: Layout): { pair: [number, number]; x: boolean }[] {
  const { cols, rows } = layout.spec;
  const out: { pair: [number, number]; x: boolean }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (c + 1 < cols) out.push({ pair: [4 * k + 1, 4 * (k + 1) + 3], x: true });
      if (r + 1 < rows) out.push({ pair: [4 * k + 2, 4 * (k + cols)], x: false });
    }
  return out;
}

/**
 * Two edges facing each other across a gap have to be a gap apart: paint
 * spilling over one of them, or a line in the picture taken for an edge,
 * shows up as a gap that's too narrow or too wide. Both get dropped there.
 */
function facingAgree(found: Found[], layout: Layout, grow: { x: number; y: number }): Found[] {
  const at = new Map<string, Found>();
  for (const f of found) at.set(`${f.site.edge}:${f.site.s.toFixed(2)}`, f);
  const drop = new Set<Found>();
  for (const { pair, x } of facingPairs(layout)) {
    const expect = layout.spec.gap - 2 * (x ? grow.x : grow.y);
    for (const f of found) {
      if (f.site.edge !== pair[0]) continue;
      const g = at.get(`${pair[1]}:${f.site.s.toFixed(2)}`);
      if (!g) continue;
      const between = (f.dir[0] * (g.px[0] - f.px[0]) + f.dir[1] * (g.px[1] - f.px[1])) / ((f.scale + g.scale) / 2);
      if (Math.abs(between - expect) > 0.3) {
        drop.add(f);
        drop.add(g);
      }
    }
  }
  return found.filter((f) => !drop.has(f));
}

/** Neighbouring measurements on an edge become one observation, so the spline stays small. */
function group(found: Found[], maxObs: number): LineObs[] {
  const piece = Math.max(4.5, (found.length * STEP) / maxObs);
  const byEdge = new Map<number, Found[]>();
  for (const f of found) {
    const list = byEdge.get(f.site.edge) ?? [];
    list.push(f);
    byEdge.set(f.site.edge, list);
  }
  const obs: LineObs[] = [];
  for (const list of byEdge.values()) {
    list.sort((a, b) => a.site.s - b.site.s);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i].site.s - list[start].site.s < piece && list[i].site.s - list[i - 1].site.s <= 2.5 * STEP) continue;
      const part = list.slice(start, i);
      start = i;
      // directions hardly differ within a piece; values are linear in position
      const n = unit([avg(part.map((p) => p.dir[0])), avg(part.map((p) => p.dir[1]))]);
      obs.push({ mm: [avg(part.map((p) => p.site.mm[0])), avg(part.map((p) => p.site.mm[1]))], n, value: avg(part.map((p) => p.value)) });
    }
  }
  return obs;
}

/**
 * Measurement noise of one observation, px: scatter of neighbouring
 * measurements on the same edge (second differences cancel the slow drift
 * of the paper), divided by how many an observation averages.
 */
function spread(found: Found[]): number {
  const byEdge = new Map<number, Found[]>();
  for (const f of found) {
    const list = byEdge.get(f.site.edge) ?? [];
    list.push(f);
    byEdge.set(f.site.edge, list);
  }
  const d2: number[] = [];
  for (const list of byEdge.values()) {
    list.sort((a, b) => a.site.s - b.site.s);
    for (let i = 1; i + 1 < list.length; i++)
      if (list[i + 1].site.s - list[i - 1].site.s <= 2.5 * STEP) d2.push(list[i + 1].value - 2 * list[i].value + list[i - 1].value);
  }
  if (d2.length < 10) return 0.3;
  const sigma = (1.4826 * median(d2.map(Math.abs))) / Math.sqrt(6);
  return sigma / Math.sqrt(4);
}

/** The found edge point in the image (on the field's normal through the site). */
function pointAt(field: WarpField, f: Found): Pt {
  const q = field.map(f.site.mm[0], f.site.mm[1]);
  const d = f.value - (f.dir[0] * q[0] + f.dir[1] * q[1]);
  return [q[0] + d * f.dir[0], q[1] + d * f.dir[1]];
}

/**
 * Inside each frame, the bend (field minus page homography) is blended from
 * the frame's four edges (Coons patch): exact on the edges, and a wave that
 * runs along one side is carried straight across the frame, where the
 * spline alone would flatten it out.
 */
function blendInside(field: WarpField, H: Mat3, layout: Layout): WarpField {
  const { cells, cellW: cw, cellH: ch } = layout;
  const { gap, cols, rows } = layout.spec;
  const x0 = cells[0].x;
  const y0 = cells[0].y;
  const memo = new Map<string, Pt>();
  const bend = (x: number, y: number): Pt => {
    const key = `${x.toFixed(4)},${y.toFixed(4)}`;
    let v = memo.get(key);
    if (!v) {
      const f = field.map(x, y);
      const h = apply(H, x, y);
      v = [f[0] - h[0], f[1] - h[1]];
      if (memo.size > 200_000) memo.clear();
      memo.set(key, v);
    }
    return v;
  };
  return {
    smoothing: field.smoothing,
    map(x, y) {
      const c = Math.floor((x - x0) / (cw + gap));
      const r = Math.floor((y - y0) / (ch + gap));
      if (c < 0 || r < 0 || c >= cols || r >= rows) return field.map(x, y);
      const cell = cells[r * cols + c];
      if (x > cell.x + cw || y > cell.y + ch) return field.map(x, y); // in a gap
      const [l, rt, t, b] = [cell.x, cell.x + cw, cell.y, cell.y + ch];
      const u = (x - l) / cw;
      const v = (y - t) / ch;
      const top = bend(x, t);
      const bot = bend(x, b);
      const left = bend(l, y);
      const right = bend(rt, y);
      const c00 = bend(l, t);
      const c10 = bend(rt, t);
      const c01 = bend(l, b);
      const c11 = bend(rt, b);
      const h = apply(H, x, y);
      const mix = (k: 0 | 1) =>
        (1 - v) * top[k] + v * bot[k] + (1 - u) * left[k] + u * right[k] - ((1 - u) * (1 - v) * c00[k] + u * (1 - v) * c10[k] + (1 - u) * v * c01[k] + u * v * c11[k]);
      return [h[0] + mix(0), h[1] + mix(1)];
    },
  };
}

function unit([x, y]: Pt): Pt {
  const l = Math.hypot(x, y);
  return [x / l, y / l];
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

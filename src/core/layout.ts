// Sheet geometry, shared by the sheet drawing and the scan detector.
// All values are millimetres, origin top-left of the page, y pointing down.
//
// A sheet has:
//  - 4 anchor markers in the page corners. Their IDs encode paper format,
//    orientation and which corner they are, so a scan can be rectified
//    before anything else is known.
//  - a grid of frames. Since version 3 nothing else is printed between them:
//    the detector measures the edges of the pictures against the white paper
//    to fit wavy or bent paper. Versions 1 and 2 had a small marker on every
//    gap crossing and halfway along each gap for that; version 4 (sheets that
//    get photographed) has those markers and uses the edges too.
//  - a QR code (bottom right) carrying everything needed to rebuild the
//    animation: project id, sheet number, grid, frame size, fps, frame count.

/**
 * 2: grid markers 4 mm (were 6 mm in 1).
 * 3: no grid markers, the picture edges do their job; gaps 5 mm instead of
 *    8, corner anchors 7 mm instead of 10. For scanners (flat paper).
 * 4: like 3, plus the 4 mm markers of version 2 in 8 mm gaps. For photos:
 *    paper that isn't flat needs more to hold on to than its edges.
 * Sheets of every version can be read; the version is in the QR code.
 */
export const LAYOUT_VERSION = 3;
export const PHOTO_LAYOUT = 4;
export const SUPPORTED_VERSIONS = [1, 2, 3, 4];

/** Layouts with grid markers: all but 3. */
export function hasGridMarkers(version = LAYOUT_VERSION): boolean {
  return version !== 3;
}

export type PaperId = 'A3' | 'A4' | 'A5' | 'LT';

export const PAPERS: Record<PaperId, { w: number; h: number; name: string }> = {
  A3: { w: 297, h: 420, name: 'A3' },
  A4: { w: 210, h: 297, name: 'A4' },
  A5: { w: 148, h: 210, name: 'A5' },
  LT: { w: 215.9, h: 279.4, name: 'Letter' },
};
/** order defines the anchor IDs, append only */
const PAPER_ORDER: PaperId[] = ['A4', 'A3', 'LT', 'A5'];

export const EDGE = 8; // page edge to anchors (printers can't print right up to the edge)
export const ANCHOR = 10; // anchor marker size up to version 2; the QR code keeps its place from then
export const QR_SIZE = 18;
export const BAND_GAP = 3; // space between header/footer bands and the grid
export const GAP_MAX = 30;
export const FRAME_MIN = 12;

/** Version 3: plain paper between the frames, mm. */
const GAP_V3 = 5;

export function anchorSize(version = LAYOUT_VERSION): number {
  return version >= 3 ? 7 : ANCHOR;
}

export function gapMin(version = LAYOUT_VERSION): number {
  return version === 3 ? GAP_V3 : version === 4 ? gapForBorder(0, 4) : 7;
}

export const ANCHOR_ID_BASE = 200;
export const MAX_GRID_MARKERS = ANCHOR_ID_BASE;

export interface SheetSpec {
  paper: PaperId;
  landscape: boolean;
  /** frame width / height */
  aspect: number;
  /** frame width, mm */
  frameW: number;
  /** space between frames, mm; the grid markers sit in it */
  gap: number;
  cols: number;
  rows: number;
  /** layout version the sheet was made with; missing = current */
  version?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MarkerPlace {
  id: number;
  /** top-left corner */
  x: number;
  y: number;
  size: number;
}

export interface Layout {
  spec: SheetSpec;
  pageW: number;
  pageH: number;
  /** row-major, cols * rows */
  cells: Rect[];
  cellW: number;
  cellH: number;
  /** versions 1 and 2 */
  gridMarkers: MarkerPlace[];
  anchors: MarkerPlace[];
  qr: Rect;
  header: Rect;
  footer: Rect;
}

export type Corner = 0 | 1 | 2 | 3; // TL, TR, BR, BL

export function anchorId(paper: PaperId, landscape: boolean, corner: Corner): number {
  return ANCHOR_ID_BASE + PAPER_ORDER.indexOf(paper) * 8 + (landscape ? 4 : 0) + corner;
}

export function parseAnchorId(id: number): { paper: PaperId; landscape: boolean; corner: Corner } | null {
  const n = id - ANCHOR_ID_BASE;
  if (n < 0 || n >= PAPER_ORDER.length * 8) return null;
  return {
    paper: PAPER_ORDER[Math.floor(n / 8)],
    landscape: (n & 4) !== 0,
    corner: (n & 3) as Corner,
  };
}

export function pageSize(paper: PaperId, landscape: boolean): { w: number; h: number } {
  const p = PAPERS[paper];
  return landscape ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/**
 * Grid marker size: 4 mm (6 mm in version 1). Measured in the lab: 4 mm is
 * as accurate as 6 mm and gets painted over less, if it keeps 2 mm of air
 * to the frames (1 mm made phone photos less reliable).
 */
export function markerSize(gap: number, version = LAYOUT_VERSION): number {
  return Math.min(version === 1 ? 6 : 4, gap - 2);
}

/** QR position only depends on the paper, so it can be found before the grid is known. */
export function qrRect(paper: PaperId, landscape: boolean): Rect {
  const { w, h } = pageSize(paper, landscape);
  return { x: w - EDGE - ANCHOR - BAND_GAP - QR_SIZE, y: h - EDGE - QR_SIZE, w: QR_SIZE, h: QR_SIZE };
}

/** Space left for the frame grid (including the outer ring of gap). */
export function gridArea(paper: PaperId, landscape: boolean, version = LAYOUT_VERSION): Rect {
  const { w, h } = pageSize(paper, landscape);
  const top = EDGE + anchorSize(version) + BAND_GAP;
  const bottom = h - EDGE - QR_SIZE - BAND_GAP;
  return { x: EDGE, y: top, w: w - 2 * EDGE, h: bottom - top };
}

/**
 * White paper border around each frame, mm. The grid markers sit outside it
 * (version 3: a strip of paper between the borders), so the border can be
 * painted on and kept in the final video.
 */
export const BORDERS = { none: 0, small: 3, large: 6 } as const;
export type BorderId = keyof typeof BORDERS;

/** Air between a grid marker and the frames next to it, mm (1 in version 1). */
function markerAir(version = LAYOUT_VERSION) {
  return version === 1 ? 1 : 2;
}

/**
 * Gap between frames for a border. Up to version 2: border on both sides +
 * marker + air on each side. Version 3: 5 mm without a border, else both
 * borders + 2 mm, so neighbouring borders stay apart.
 */
export function gapForBorder(border: number, version = LAYOUT_VERSION): number {
  if (version === 3) return border > 0 ? Math.max(GAP_V3 + 0.1, 2 * border + 2) : GAP_V3;
  return markerSize(Infinity, version) + 2 * markerAir(version) + 2 * border;
}

/** Clean paper around each frame for a given gap (inverse of gapForBorder). */
export function paperBorder(gap: number, version = LAYOUT_VERSION): number {
  if (version === 3) return gap <= GAP_V3 + 1e-6 ? 0 : (gap - 2) / 2;
  return Math.max(0, (gap - markerSize(gap, version) - 2 * markerAir(version)) / 2);
}

export interface GridChoice {
  cols: number;
  rows: number;
  count: number;
  /** largest frame width for this grid, whole mm */
  frameW: number;
}

/**
 * Sensible "frames per sheet" options: for every grid the biggest frames that
 * fit, without options that give fewer frames and aren't bigger either.
 */
export function gridChoices(paper: PaperId, landscape: boolean, aspect: number, gap: number, minFrame = 20, version = LAYOUT_VERSION): GridChoice[] {
  const area = gridArea(paper, landscape, version);
  const best = new Map<number, GridChoice>();
  for (let cols = 1; cols <= 10; cols++)
    for (let rows = 1; rows <= 15; rows++) {
      const w = Math.floor(Math.min((area.w - (cols + 1) * gap) / cols, ((area.h - (rows + 1) * gap) / rows) * aspect));
      if (w < minFrame || w / aspect < FRAME_MIN || (hasGridMarkers(version) && (cols + 1) * (rows + 1) > MAX_GRID_MARKERS)) continue;
      const count = cols * rows;
      const prev = best.get(count);
      if (!prev || w > prev.frameW) best.set(count, { cols, rows, count, frameW: w });
    }
  const sorted = [...best.values()].sort((a, b) => a.count - b.count);
  // drop options beaten by one with more frames that are at least as big
  return sorted.filter((c, i) => !sorted.slice(i + 1).some((d) => d.frameW >= c.frameW));
}

export function specForGrid(paper: PaperId, landscape: boolean, aspect: number, gap: number, g: GridChoice, version = LAYOUT_VERSION): SheetSpec {
  return { paper, landscape, aspect: Math.round(aspect * 1000) / 1000, frameW: g.frameW, gap, cols: g.cols, rows: g.rows, version };
}

/** Largest frame width that still fits once on the sheet. */
export function maxFrameWidth(paper: PaperId, landscape: boolean, aspect: number, gap: number): number {
  const area = gridArea(paper, landscape);
  return Math.floor(Math.min(area.w - 2 * gap, (area.h - 2 * gap) * aspect));
}

/**
 * A spec with as many frames per sheet as fit. Values are rounded the way
 * the QR code stores them, so print and detection use identical numbers.
 */
export function makeSpec(paper: PaperId, landscape: boolean, aspect: number, frameW: number, gap: number, version = LAYOUT_VERSION): SheetSpec {
  aspect = Math.round(aspect * 1000) / 1000;
  frameW = Math.round(frameW * 10) / 10;
  gap = Math.round(gap * 10) / 10;
  const area = gridArea(paper, landscape, version);
  const frameH = frameW / aspect;
  const cols = Math.max(0, Math.floor((area.w - gap + 1e-6) / (frameW + gap)));
  const rows = Math.max(0, Math.floor((area.h - gap + 1e-6) / (frameH + gap)));
  return { paper, landscape, aspect, frameW, gap, cols, rows, version };
}

export function cellSize(spec: SheetSpec): { w: number; h: number } {
  return { w: spec.frameW, h: spec.frameW / spec.aspect };
}

export function validateSpec(spec: SheetSpec): string | null {
  if (!PAPERS[spec.paper]) return `Unknown paper ${spec.paper}.`;
  if (!(spec.aspect > 0.1 && spec.aspect < 10)) return 'Unusual aspect ratio.';
  const min = gapMin(spec.version);
  if (!(spec.gap >= min - 1e-6 && spec.gap <= GAP_MAX)) return `Spacing must be between ${min} and ${GAP_MAX} mm.`;
  const c = cellSize(spec);
  if (c.w < FRAME_MIN || c.h < FRAME_MIN) return `Frames must be at least ${FRAME_MIN} mm on each side.`;
  if (!(spec.cols >= 1 && spec.rows >= 1)) return 'Frames this big don’t fit on the sheet.';
  const area = gridArea(spec.paper, spec.landscape, spec.version);
  if (spec.cols * (c.w + spec.gap) + spec.gap > area.w + 1e-6 || spec.rows * (c.h + spec.gap) + spec.gap > area.h + 1e-6)
    return 'Frames don’t fit on the sheet.';
  if (hasGridMarkers(spec.version) && (spec.cols + 1) * (spec.rows + 1) > MAX_GRID_MARKERS) return 'Too many frames per sheet.';
  return null;
}

export function computeLayout(spec: SheetSpec): Layout {
  const err = validateSpec(spec);
  if (err) throw new Error(err);
  const version = spec.version ?? LAYOUT_VERSION;
  const { w: W, h: H } = pageSize(spec.paper, spec.landscape);
  const area = gridArea(spec.paper, spec.landscape, version);
  const { w: cw, h: ch } = cellSize(spec);
  const G = spec.gap;

  const gridW = spec.cols * cw + (spec.cols + 1) * G;
  const gridH = spec.rows * ch + (spec.rows + 1) * G;
  const gx = area.x + (area.w - gridW) / 2;
  const gy = area.y + (area.h - gridH) / 2;

  const cells: Rect[] = [];
  for (let r = 0; r < spec.rows; r++)
    for (let c = 0; c < spec.cols; c++)
      cells.push({ x: gx + G + c * (cw + G), y: gy + G + r * (ch + G), w: cw, h: ch });

  const gridMarkers = hasGridMarkers(version) ? gridMarkerPlaces(spec, gx, gy) : [];

  const A = anchorSize(version);
  const anchorPos: [number, number][] = [
    [EDGE, EDGE],
    [W - EDGE - A, EDGE],
    [W - EDGE - A, H - EDGE - A],
    [EDGE, H - EDGE - A],
  ];
  const anchors = anchorPos.map(([x, y], corner) => ({
    id: anchorId(spec.paper, spec.landscape, corner as Corner),
    x,
    y,
    size: A,
  }));

  const qr = qrRect(spec.paper, spec.landscape);
  const header = { x: EDGE + A + BAND_GAP, y: EDGE, w: W - 2 * (EDGE + A + BAND_GAP), h: A };
  const footer = { x: EDGE + A + BAND_GAP, y: H - EDGE - A, w: qr.x - BAND_GAP - (EDGE + A + BAND_GAP), h: A };

  return { spec, pageW: W, pageH: H, cells, cellW: cw, cellH: ch, gridMarkers, anchors, qr, header, footer };
}

/**
 * Grid markers: first one on every gap crossing (id = r * (cols + 1) + c),
 * then one halfway along every gap segment if the frames are big enough
 * and the IDs suffice.
 */
function gridMarkerPlaces(spec: SheetSpec, gx: number, gy: number): MarkerPlace[] {
  const G = spec.gap;
  const M = markerSize(G, spec.version);
  const { w: cw, h: ch } = cellSize(spec);
  const mids = midMarkers(spec);
  const out: MarkerPlace[] = [];
  const at = (cx: number, cy: number) => out.push({ id: out.length, x: cx - M / 2, y: cy - M / 2, size: M });
  const X = (c: number) => gx + G / 2 + c * (cw + G);
  const Y = (r: number) => gy + G / 2 + r * (ch + G);
  for (let r = 0; r <= spec.rows; r++) for (let c = 0; c <= spec.cols; c++) at(X(c), Y(r));
  if (mids.h) for (let r = 0; r <= spec.rows; r++) for (let c = 0; c < spec.cols; c++) at(X(c + 0.5), Y(r));
  if (mids.v) for (let r = 0; r < spec.rows; r++) for (let c = 0; c <= spec.cols; c++) at(X(c), Y(r + 0.5));
  return out;
}

function midMarkers(spec: SheetSpec): { h: boolean; v: boolean } {
  const c = cellSize(spec);
  const M = markerSize(spec.gap, spec.version);
  const crossings = (spec.cols + 1) * (spec.rows + 1);
  const h = c.w >= 3 * M;
  const v = c.h >= 3 * M;
  const total = crossings + (h ? spec.cols * (spec.rows + 1) : 0) + (v ? (spec.cols + 1) * spec.rows : 0);
  return total <= MAX_GRID_MARKERS ? { h, v } : { h: false, v: false };
}

/** Marker corners in mm, in ArUco order: TL, TR, BR, BL. */
export function markerCorners(m: MarkerPlace): [number, number][] {
  return [
    [m.x, m.y],
    [m.x + m.size, m.y],
    [m.x + m.size, m.y + m.size],
    [m.x, m.y + m.size],
  ];
}

// --- copies: one picture over the whole sheet, nothing to scan ---

/** Copies have no anchors, QR code or text, so the grid gets the page inside the printer margin. */
export function copiesArea(paper: PaperId, landscape: boolean): Rect {
  const { w, h } = pageSize(paper, landscape);
  return { x: EDGE, y: EDGE, w: w - 2 * EDGE, h: h - 2 * EDGE };
}

/** Space between copies, mm: enough to cut between them, or both white borders. */
export function copiesGap(border: number): number {
  return border > 0 ? 2 * border : 3;
}

/** Width of the biggest copy that fits once, mm. */
export function copiesMaxWidth(paper: PaperId, landscape: boolean, aspect: number): number {
  const area = copiesArea(paper, landscape);
  return Math.min(area.w, area.h * aspect);
}

/** Copies `w` mm wide: as many as fit, in a grid in the middle of the page. */
export function copiesCells(paper: PaperId, landscape: boolean, aspect: number, gap: number, w: number): Rect[] {
  const area = copiesArea(paper, landscape);
  const h = w / aspect;
  const cols = Math.max(0, Math.floor((area.w + gap + 1e-6) / (w + gap)));
  const rows = Math.max(0, Math.floor((area.h + gap + 1e-6) / (h + gap)));
  const x0 = area.x + (area.w - (cols * w + (cols - 1) * gap)) / 2;
  const y0 = area.y + (area.h - (rows * h + (rows - 1) * gap)) / 2;
  const cells: Rect[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: x0 + c * (w + gap), y: y0 + r * (h + gap), w, h });
  return cells;
}

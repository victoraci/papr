// Detection lab: PDF → raster → fake scans → detect → measure.
// Writes lab-out/index.html with previews and a video per scenario.
//
//   node scripts/lab.ts            all scenarios
//   node scripts/lab.ts phone      only scenarios whose name contains "phone"

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { decode, encode } from 'fast-png';
import { loadCv, type CV } from '../src/core/cv.ts';
import { detectPage, type PageResult } from '../src/core/detect.ts';
import { dist, type Pt } from '../src/core/geom.ts';
import { toRGBA, type RGBAImage } from '../src/core/image.ts';
import { computeLayout, makeSpec, type PaperId, type SheetSpec } from '../src/core/layout.ts';
import { buildSheetsPdf, pageCount } from '../src/core/pdf.ts';
import { fakeScan, placePage, type Scenario } from '../test/fakescan.ts';
import { makeFrame, readBarcode } from '../test/synth.ts';

const OUT = 'lab-out';
const DPI = 300;
const FPS = 12;
const N = 30;
// override with env: PAPER=A5 ORIENT=P FW=40 GAP=7 BORDERS=1
const SPEC: SheetSpec = makeSpec(
  (process.env.PAPER ?? 'A4') as PaperId,
  (process.env.ORIENT ?? 'L') === 'L',
  16 / 9,
  Number(process.env.FW ?? 76),
  Number(process.env.GAP ?? 8),
);
if (process.env.VERSION) SPEC.version = Number(process.env.VERSION); // e.g. VERSION=1 for old 6 mm sheets
const PER = SPEC.cols * SPEC.rows;
console.log(`sheet ${SPEC.paper} ${SPEC.landscape ? 'landscape' : 'portrait'}, ${SPEC.cols}×${SPEC.rows} frames of ${SPEC.frameW} mm, gap ${SPEC.gap} mm`);
const filter = process.argv[2] ?? '';

const cv = await loadCv();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- sheets ---
const pdf = await buildSheetsPdf({
  spec: SPEC,
  style: { borders: !!process.env.BORDERS, frameNumbers: true, fileName: true, markers: (process.env.MARKERS ?? 'all') as 'all' | 'crossings' | 'ring' },
  projectId: 'LAB001',
  fps: FPS,
  frameCount: N,
  title: 'bouncing-ball.mp4',
  getFrame: async (i) => {
    const f = makeFrame(i, N);
    return { bytes: encode({ width: f.width, height: f.height, data: f.data as Uint8ClampedArray, channels: 4, depth: 8 }), type: 'png' };
  },
});
writeFileSync(`${OUT}/sheets.pdf`, pdf);
execFileSync('pdftoppm', ['-r', String(DPI), '-png', `${OUT}/sheets.pdf`, `${OUT}/page`]);
const pages = pageCount(SPEC, N);
const rasters: RGBAImage[] = [];
for (let p = 1; p <= pages; p++) {
  const png = decode(readFileSync(`${OUT}/page-${p}.png`));
  rasters.push(toRGBA(png.width, png.height, png.data as Uint8Array, png.channels));
  rmSync(`${OUT}/page-${p}.png`);
}
const layout = computeLayout(SPEC);
const PW = rasters[0].width;
const PH = rasters[0].height;

// --- scenarios ---
const P = (o: Parameters<typeof placePage>[2]) => placePage(PW, PH, o);
const allScenarios: Scenario[] = [
  { name: 'scanner-300dpi', outW: 3650, outH: 2580, quad: P({ outW: 3650, outH: 2580, rot: 1.2, scale: 1 }), blur: 0.7, noise: 3 },
  {
    name: 'scanner-150dpi-upside-down',
    outW: 1900,
    outH: 1340,
    quad: P({ outW: 1900, outH: 1340, rot: 181.5, scale: 0.5 }),
    blur: 0.6,
    noise: 3,
    bendMm: 0.4,
  },
  {
    name: 'scanner-rotated-90',
    outW: 1500,
    outH: 2100,
    quad: P({ outW: 1500, outH: 2100, rot: 90.8, scale: 0.58 }),
    blur: 0.6,
    noise: 3,
  },
  {
    name: 'phone-angled',
    outW: 3000,
    outH: 2250,
    quad: P({ outW: 3000, outH: 2250, rot: -4, scale: 0.72, squeezeTop: 0.06, squeezeLeft: 0.02 }),
    background: [70, 52, 40],
    lightX: [0.75, 1.05],
    lightY: [1.0, 0.8],
    blur: 1.2,
    noise: 6,
    bendMm: 1,
  },
  {
    name: 'phone-far-away',
    outW: 4000,
    outH: 3000,
    quad: P({ outW: 4000, outH: 3000, rot: 3, scale: 0.45, squeezeTop: 0.03, dx: 300 }),
    background: [60, 60, 65],
    lightX: [0.9, 1.0],
    blur: 1.0,
    noise: 5,
  },
  {
    name: 'wavy-paper',
    outW: 3650,
    outH: 2580,
    quad: P({ outW: 3650, outH: 2580, rot: -0.8, scale: 1 }),
    bendMm: 2.5,
    waveMm: 80,
    blur: 0.8,
    noise: 3,
  },
  {
    name: 'painted-phone',
    outW: 3000,
    outH: 2250,
    quad: P({ outW: 3000, outH: 2250, rot: -2.5, scale: 0.75, squeezeTop: 0.04 }),
    background: [90, 70, 55],
    lightX: [0.85, 1.05],
    strokes: 45,
    spill: 0.06,
    blur: 1.0,
    noise: 5,
    bendMm: 1.2,
    seed: 11,
  },
  {
    name: 'messy-paint',
    outW: 3000,
    outH: 2250,
    quad: P({ outW: 3000, outH: 2250, rot: 2, scale: 0.75, squeezeTop: 0.04 }),
    background: [50, 50, 50],
    lightY: [1.05, 0.85],
    strokes: 90,
    blur: 1.0,
    noise: 5,
    bendMm: 1.2,
    seed: 7,
  },
];
const scenarios = allScenarios.filter((s) => s.name.includes(filter));

// --- run ---
interface Row {
  scenario: string;
  page: number;
  qr: boolean;
  frames: number;
  expected: number;
  correctIds: number;
  meanErr: number;
  maxErr: number;
  markers: string;
  ms: number;
  warnings: string;
}
const rows: Row[] = [];
const html: string[] = [];

for (const sc of scenarios) {
  const dir = `${OUT}/${sc.name}`;
  mkdirSync(dir, { recursive: true });
  const frames = new Map<number, RGBAImage>();
  const previews: string[] = [];

  for (let p = 1; p <= pages; p++) {
    const scan = fakeScan(cv, rasters[p - 1], DPI, { ...sc, seed: (sc.seed ?? 1) + p }, layout.cells);
    const t0 = performance.now();
    const res = await detectPage(scan.image, { frameWidth: 640, smoothing: process.env.SMOOTH ? Number(process.env.SMOOTH) : undefined });
    const ms = Math.round(performance.now() - t0);
    const expected = Math.min(N - (p - 1) * PER, PER);

    // geometric error: 3x3 sample points per frame, in % of frame width
    const errs: number[] = [];
    for (const f of res.frames) {
      const cell = layout.cells[f.index - (p - 1) * PER];
      const cellPx = dist(scan.mmToPx(cell.x, cell.y), scan.mmToPx(cell.x + cell.w, cell.y));
      for (const fx of [0, 0.5, 1])
        for (const fy of [0, 0.5, 1]) {
          const x = cell.x + fx * cell.w;
          const y = cell.y + fy * cell.h;
          errs.push((dist(res.field!.map(x, y), scan.mmToPx(x, y)) / cellPx) * 100);
        }
    }
    let correct = 0;
    for (const f of res.frames) {
      if (readBarcode(cropTo(f.image, f.inner)) === f.index) correct++;
      frames.set(f.index, f.image);
    }
    const gridTotal = layout.gridMarkers.length + 4;
    rows.push({
      scenario: sc.name,
      page: p,
      qr: res.payload?.page === p && !res.usedFallback,
      frames: res.frames.length,
      expected,
      correctIds: correct,
      meanErr: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN,
      maxErr: errs.length ? Math.max(...errs) : NaN,
      markers: `${res.inlierIds.length}/${gridTotal}`,
      ms,
      warnings: [`stiffness ${res.field?.smoothing}`, ...res.warnings].join('; '),
    });

    if (process.env.RAW) {
      // full-size fake scan as JPEG, e.g. to drop into the app
      writePng(`${dir}/raw-${p}.png`, scan.image);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${dir}/raw-${p}.png`, '-q:v', '3', `${dir}/raw-${p}.jpg`]);
      rmSync(`${dir}/raw-${p}.png`);
    }
    {
      const file = `scan-${p}.png`;
      writePng(`${dir}/${file}`, overlay(cv, scan.image, res, 1100));
      previews.push(file);
    }
  }

  // frames → video
  const sorted = [...frames.keys()].sort((a, b) => a - b);
  sorted.forEach((idx, k) => writePng(`${dir}/f-${String(k).padStart(4, '0')}.png`, frames.get(idx)!));
  if (sorted.length) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/f-%04d.png`, '-pix_fmt', 'yuv420p', '-vf', 'scale=640:-2', `${dir}/anim.mp4`]);
    sorted.forEach((_, k) => rmSync(`${dir}/f-${String(k).padStart(4, '0')}.png`));
  }
  html.push(`<section><h2>${sc.name}</h2><div class="row">${previews
    .map((f) => `<img src="${sc.name}/${f}">`)
    .join('')}<video src="${sc.name}/anim.mp4" autoplay loop muted playsinline></video></div></section>`);
  console.log(`done ${sc.name}`);
}

// --- report ---
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '–');
console.log('\nscenario                      page  qr  frames  ids   err mean/max (% of frame width)  markers  ms');
for (const r of rows)
  console.log(
    `${r.scenario.padEnd(30)}${String(r.page).padEnd(6)}${(r.qr ? 'ok' : 'NO').padEnd(4)}${`${r.frames}/${r.expected}`.padEnd(8)}${`${r.correctIds}`.padEnd(6)}${`${fmt(r.meanErr)} / ${fmt(r.maxErr)}`.padEnd(33)}${r.markers.padEnd(9)}${r.ms}${r.warnings ? '  ' + r.warnings : ''}`,
  );

const table = rows
  .map(
    (r) =>
      `<tr class="${r.qr && r.correctIds === r.expected ? '' : 'bad'}"><td>${r.scenario}</td><td>${r.page}</td><td>${r.qr ? 'ok' : 'NO'}</td><td>${r.correctIds}/${r.expected}</td><td>${fmt(r.meanErr)} / ${fmt(r.maxErr)} %</td><td>${r.markers}</td><td>${r.ms} ms</td><td>${r.warnings}</td></tr>`,
  )
  .join('');
writeFileSync(
  `${OUT}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>PAPR lab</title>
<style>body{font:14px Inter,system-ui,sans-serif;margin:24px;background:#111;color:#ddd}
img,video{height:300px;border-radius:4px;background:#000}.row{display:flex;gap:12px;flex-wrap:wrap}
table{border-collapse:collapse;margin-bottom:24px}td,th{padding:4px 10px;text-align:left;border-bottom:1px solid #333}
.bad{color:#f77}h2{font-weight:500;margin:28px 0 8px}</style>
<h1 style="font-weight:500">PAPR · detection lab</h1>
<table><tr><th>scenario</th><th>page</th><th>QR</th><th>frames right</th><th>error mean / max</th><th>markers</th><th>time</th><th>notes</th></tr>${table}</table>
${html.join('\n')}`,
);
console.log(`\nopen ${OUT}/index.html`);

// ---------------------------------------------------------------------------

/** Copy of a sub-rectangle (frames come with their white border). */
function cropTo(img: RGBAImage, r: { x: number; y: number; w: number; h: number }): RGBAImage {
  if (r.x === 0 && r.y === 0 && r.w === img.width && r.h === img.height) return img;
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return { width: r.w, height: r.h, data: out };
}

function writePng(path: string, img: RGBAImage) {
  writeFileSync(path, encode({ width: img.width, height: img.height, data: img.data as Uint8ClampedArray, channels: 4, depth: 8 }));
}

/** Scan preview with detected markers (green), ignored markers (red) and frame outlines (cyan). */
function overlay(cv: CV, img: RGBAImage, res: PageResult, maxW: number): RGBAImage {
  const m = new cv.Mat(img.height, img.width, cv.CV_8UC4);
  m.data.set(img.data);
  const lw = Math.max(2, Math.round(img.width / 500));
  const poly = (pts: Pt[], color: number[]) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      cv.line(m, new cv.Point(a[0], a[1]), new cv.Point(b[0], b[1]), new cv.Scalar(...color), lw, cv.LINE_AA);
    }
  };
  const inl = new Set(res.inlierIds);
  for (const mk of res.markers) poly(mk.corners, inl.has(mk.id) ? [0, 220, 90, 255] : [255, 50, 50, 255]);
  for (const f of res.frames) poly(f.quad, [0, 200, 255, 255]);
  const s = Math.min(1, maxW / img.width);
  const small = new cv.Mat();
  cv.resize(m, small, new cv.Size(Math.round(img.width * s), Math.round(img.height * s)), 0, 0, cv.INTER_AREA);
  const out = { width: small.cols, height: small.rows, data: new Uint8ClampedArray(small.data) };
  m.delete();
  small.delete();
  return out;
}


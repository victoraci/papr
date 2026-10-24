// Scans / photos / scanner PDFs → recognised sheets → one ordered frame list per project.

import { detectPage, type PageResult } from '../core/detect.ts';
import type { RGBAImage } from '../core/image.ts';
import type { SheetPayload } from '../core/payload.ts';

/** Bigger images are scaled down first; markers stay plenty large and it's much faster. */
const MAX_SIDE = 4200;
const PDF_DPI = 300;

export interface ScanEntry {
  name: string;
  load: () => Promise<RGBAImage>;
  status: 'waiting' | 'working' | 'done' | 'failed';
  result?: PageResult;
  error?: string;
}

/** One entry per image, one per page for PDFs. */
export async function toEntries(files: File[]): Promise<ScanEntry[]> {
  const out: ScanEntry[] = [];
  for (const file of files) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      try {
        const pages = await pdfPages(file);
        pages.forEach((load, i) =>
          out.push({ name: pages.length > 1 ? `${file.name} · page ${i + 1}` : file.name, load, status: 'waiting' }),
        );
      } catch {
        out.push({ name: file.name, load: () => Promise.reject(new Error('This PDF can’t be opened.')), status: 'waiting' });
      }
    } else out.push({ name: file.name, load: () => readImage(file), status: 'waiting' });
  }
  return out;
}

async function readImage(file: File): Promise<RGBAImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(/heic|heif/i.test(file.type + file.name) ? 'HEIC photos can’t be read in this browser. Export as JPEG.' : 'Not an image this browser can read.');
  }
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s);
  const h = Math.round(bmp.height * s);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

async function pdfPages(file: File): Promise<(() => Promise<RGBAImage>)[]> {
  const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  return [...Array(doc.numPages).keys()].map((i) => async () => {
    const page = await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 }); // PDF points, 1/72 inch
    const scale = Math.min(PDF_DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    page.cleanup();
    return { width: canvas.width, height: canvas.height, data };
  });
}

export interface Project {
  id: string;
  payload: SheetPayload;
  /** frames including the white border, if the sheets were printed with one */
  frames: Map<number, ImageBitmap>;
  pages: Set<number>;
  /** the frame itself inside each image, px */
  inner: { x: number; y: number; w: number; h: number };
  /** whole image incl. border, px */
  full: { w: number; h: number };
}

/** Long side of the rebuilt frames. Same for every sheet, whatever the scan resolution. */
export const FRAME_LONG_SIDE = 1280;

export function frameSize(aspect: number, longSide = FRAME_LONG_SIDE): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return aspect >= 1 ? { w: even(longSide), h: even(longSide / aspect) } : { w: even(longSide * aspect), h: even(longSide) };
}

const MESSAGES: Record<string, string> = {
  'no markers found': 'No PAPR sheet found in this image.',
  'QR code not readable': 'The QR code can’t be read. Keep it clean and in focus.',
  'no markers of this sheet found': 'The black squares can’t be read.',
  'could not fit the page': 'The sheet is too distorted to read.',
};

export async function processScan(entry: ScanEntry, projects: Map<string, Project>): Promise<void> {
  entry.status = 'working';
  try {
    const result = await detectPage(await entry.load(), { frameLongSide: FRAME_LONG_SIDE });
    entry.result = result;
    if (!result.payload || !result.frames.length) {
      entry.status = 'failed';
      const w = result.warnings[result.warnings.length - 1] ?? '';
      entry.error = MESSAGES[w] ?? 'No PAPR sheet found in this image.';
      return;
    }
    const p = result.payload;
    let project = projects.get(p.projectId);
    if (!project) {
      const f = result.frames[0];
      project = { id: p.projectId, payload: p, frames: new Map(), pages: new Set(), inner: f.inner, full: { w: f.image.width, h: f.image.height } };
      projects.set(p.projectId, project);
    }
    project.pages.add(p.page);
    for (const f of result.frames) {
      const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(f.image.data), f.image.width, f.image.height));
      project.frames.get(f.index)?.close();
      project.frames.set(f.index, bmp);
    }
    entry.status = 'done';
  } catch (e) {
    entry.status = 'failed';
    entry.error = e instanceof Error ? e.message : String(e);
  }
}

export function missingPages(p: Project): number[] {
  const out: number[] = [];
  for (let i = 1; i <= p.payload.pages; i++) if (!p.pages.has(i)) out.push(i);
  return out;
}

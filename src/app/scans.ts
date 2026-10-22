// Scans / photos → recognised pages → one ordered frame list per project.

import { detectPage, type PageResult } from '../core/detect.ts';
import type { RGBAImage } from '../core/image.ts';
import type { SheetPayload } from '../core/payload.ts';

/** Bigger photos are scaled down first; markers stay plenty large and it's much faster. */
const MAX_SIDE = 4200;

export async function readImage(file: File): Promise<RGBAImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(/heic|heif/i.test(file.type + file.name) ? 'HEIC photos can’t be read here. Export as JPEG.' : 'Not an image this browser can read.');
  }
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s);
  const h = Math.round(bmp.height * s);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: data.data };
}

export interface ScanEntry {
  file: File;
  status: 'waiting' | 'working' | 'done' | 'failed';
  result?: PageResult;
  error?: string;
}

export interface Project {
  id: string;
  payload: SheetPayload;
  frames: Map<number, ImageBitmap>;
  pages: Set<number>;
  frameW: number;
  frameH: number;
}

/** Long side of the rebuilt frames. Same for every page, whatever the scan resolution. */
export const FRAME_LONG_SIDE = 1280;

export function frameSize(aspect: number): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return aspect >= 1
    ? { w: FRAME_LONG_SIDE, h: even(FRAME_LONG_SIDE / aspect) }
    : { w: even(FRAME_LONG_SIDE * aspect), h: FRAME_LONG_SIDE };
}

export async function processScan(entry: ScanEntry, projects: Map<string, Project>): Promise<void> {
  entry.status = 'working';
  try {
    const img = await readImage(entry.file);
    const result = await detectPage(img, { frameLongSide: FRAME_LONG_SIDE });
    entry.result = result;
    if (!result.payload) {
      entry.status = 'failed';
      entry.error = result.warnings[0] ?? 'not recognised';
      return;
    }
    const p = result.payload;
    let project = projects.get(p.projectId);
    if (!project) {
      const size = frameSize(p.spec.aspect);
      project = { id: p.projectId, payload: p, frames: new Map(), pages: new Set(), frameW: size.w, frameH: size.h };
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

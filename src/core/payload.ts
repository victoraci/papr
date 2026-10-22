// What every sheet's QR code carries. Kept to the QR "alphanumeric" charset
// (0-9 A-Z space $%*+-./:) so the code stays small and easy to read.
//
//   RP1:K3X9QZ:3:12:4:3:A4L:1778:12:139:600:80
//   ver id     sheet/sheets cols rows paper+orientation aspect*1000 fps frames
//   frame width*10 (mm) gap*10 (mm)

import { LAYOUT_VERSION, PAPERS, type PaperId, type SheetSpec } from './layout.ts';

export interface SheetPayload {
  version: number;
  projectId: string;
  /** 1-based */
  page: number;
  pages: number;
  spec: SheetSpec;
  fps: number;
  frameCount: number;
}

export function framesPerPage(spec: SheetSpec): number {
  return spec.cols * spec.rows;
}

export function firstFrameOfPage(p: SheetPayload): number {
  return (p.page - 1) * framesPerPage(p.spec);
}

export function encodePayload(p: SheetPayload): string {
  const s = p.spec;
  return [
    `RP${p.version}`,
    p.projectId,
    p.page,
    p.pages,
    s.cols,
    s.rows,
    `${s.paper}${s.landscape ? 'L' : 'P'}`,
    Math.round(s.aspect * 1000),
    +p.fps.toFixed(3),
    p.frameCount,
    Math.round(s.frameW * 10),
    Math.round(s.gap * 10),
  ].join(':');
}

export function decodePayload(text: string): SheetPayload | null {
  const parts = text.trim().split(':');
  if (parts.length !== 12) return null;
  const m = /^RP(\d+)$/.exec(parts[0]);
  if (!m) return null;
  const version = Number(m[1]);
  if (version !== LAYOUT_VERSION) return null;
  const [, projectId, page, pages, cols, rows, paperO, aspect, fps, frames, frameW, gap] = parts;
  const paper = paperO.slice(0, -1) as PaperId;
  const orient = paperO.slice(-1);
  if (!PAPERS[paper] || (orient !== 'L' && orient !== 'P')) return null;
  const nums = [page, pages, cols, rows, aspect, fps, frames, frameW, gap].map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return {
    version,
    projectId,
    page: nums[0],
    pages: nums[1],
    spec: {
      paper,
      landscape: orient === 'L',
      cols: nums[2],
      rows: nums[3],
      aspect: nums[4] / 1000,
      frameW: nums[7] / 10,
      gap: nums[8] / 10,
    },
    fps: nums[5],
    frameCount: nums[6],
  };
}

const ID_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, they read like 1/0

export function newProjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

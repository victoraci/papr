// Writes the printable sheets as a vector PDF (markers and QR stay razor sharp,
// only the frames themselves are images).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { computeLayout, LAYOUT_VERSION, type Rect, type SheetSpec } from './layout.ts';
import { framesPerPage } from './payload.ts';
import { drawSheet, type SheetCanvas, type SheetStyle } from './sheet.ts';

export interface FrameImage {
  bytes: Uint8Array;
  type: 'jpg' | 'png';
}

export interface SheetsInput {
  spec: SheetSpec;
  style: SheetStyle;
  projectId: string;
  fps: number;
  frameCount: number;
  getFrame: (index: number) => Promise<FrameImage>;
  /** where the printed part starts in the video, s; goes into the QR code for the sound */
  start?: number;
  /** printed in the header, e.g. the video's file name */
  title?: string;
  onProgress?: (done: number, total: number) => void;
}

const PT = 72 / 25.4;
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const GREY = rgb(0.45, 0.45, 0.45);
const BORDER = rgb(0.15, 0.15, 0.15);

export function pageCount(spec: SheetSpec, frameCount: number): number {
  return Math.max(1, Math.ceil(frameCount / framesPerPage(spec)));
}

export async function buildSheetsPdf(input: SheetsInput): Promise<Uint8Array> {
  const layout = computeLayout(input.spec);
  const pages = pageCount(input.spec, input.frameCount);

  const doc = await PDFDocument.create();
  doc.setTitle(`PAPR ${input.projectId}`);
  doc.setCreator('PAPR');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  let done = 0;
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([layout.pageW * PT, layout.pageH * PT]);
    const canvas = new PdfCanvas(page, layout.pageH, font, async (index) => {
      const f = await input.getFrame(index);
      input.onProgress?.(++done, input.frameCount);
      return f.type === 'jpg' ? doc.embedJpg(f.bytes) : doc.embedPng(f.bytes);
    });
    await drawSheet(canvas, {
      layout,
      title: input.title,
      style: input.style,
      payload: {
        version: input.spec.version ?? LAYOUT_VERSION,
        projectId: input.projectId,
        page: p,
        pages,
        spec: input.spec,
        fps: input.fps,
        frameCount: input.frameCount,
        start: input.start,
      },
    });
  }

  return doc.save();
}

class PdfCanvas implements SheetCanvas {
  private page: PDFPage;
  private pageH: number;
  private font: PDFFont;
  private embed: (index: number) => Promise<PDFImage>;

  constructor(page: PDFPage, pageH: number, font: PDFFont, embed: (index: number) => Promise<PDFImage>) {
    this.page = page;
    this.pageH = pageH;
    this.font = font;
    this.embed = embed;
  }

  private box(r: Rect) {
    return { x: r.x * PT, y: (this.pageH - r.y - r.h) * PT, width: r.w * PT, height: r.h * PT };
  }

  fill(r: Rect, white = false) {
    this.page.drawRectangle({ ...this.box(r), color: white ? WHITE : BLACK });
  }

  outline(r: Rect, width: number) {
    // drawn just outside the frame, so it never eats into the picture
    const o = width / 2;
    this.page.drawRectangle({ ...this.box({ x: r.x - o, y: r.y - o, w: r.w + width, h: r.h + width }), borderColor: BORDER, borderWidth: width * PT });
  }

  async frame(index: number, r: Rect) {
    this.page.drawImage(await this.embed(index), this.box(r));
  }

  text(s: string, x: number, y: number, size: number, opts: { right?: boolean; grey?: boolean } = {}) {
    const t = latin1(s);
    const w = opts.right ? this.font.widthOfTextAtSize(t, size) / PT : 0;
    this.page.drawText(t, { x: (x - w) * PT, y: (this.pageH - y) * PT, size, font: this.font, color: opts.grey ? GREY : BLACK });
  }
}

/** The built-in PDF font only covers Latin-1; drop anything else (emoji in file names etc.). */
function latin1(s: string): string {
  return s.replace(/[^\x20-\x7e\xa0-\xff–·’]/g, '');
}

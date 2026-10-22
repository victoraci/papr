// Writes the printable sheets as a vector PDF (markers and QR stay razor sharp,
// only the frames themselves are images).

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import qrcode from 'qrcode-generator';
import { ARUCO_4X4_250 } from './aruco-dict.ts';
import { computeLayout, LAYOUT_VERSION, type MarkerPlace, type Rect, type SheetSpec } from './layout.ts';
import { encodePayload, framesPerPage } from './payload.ts';

export interface FrameImage {
  bytes: Uint8Array;
  type: 'jpg' | 'png';
}

export interface SheetsInput {
  spec: SheetSpec;
  projectId: string;
  fps: number;
  frameCount: number;
  getFrame: (index: number) => Promise<FrameImage>;
  /** printed in the header, e.g. the video's file name */
  title?: string;
  onProgress?: (done: number, total: number) => void;
}

const PT = 72 / 25.4;
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const GREY = rgb(0.45, 0.45, 0.45);

export function pageCount(spec: SheetSpec, frameCount: number): number {
  return Math.max(1, Math.ceil(frameCount / framesPerPage(spec)));
}

export async function buildSheetsPdf(input: SheetsInput): Promise<Uint8Array> {
  const layout = computeLayout(input.spec);
  const pages = pageCount(input.spec, input.frameCount);
  const perPage = framesPerPage(input.spec);

  const doc = await PDFDocument.create();
  doc.setTitle(`rotopaper ${input.projectId}`);
  doc.setCreator('rotopaper');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  let done = 0;
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([layout.pageW * PT, layout.pageH * PT]);
    const draw = new Drawer(page, layout.pageH, font);
    const first = (p - 1) * perPage;
    const last = Math.min(first + perPage, input.frameCount) - 1;

    for (let i = 0; i < perPage; i++) {
      const index = first + i;
      if (index > last) break;
      const cell = layout.cells[i];
      const frame = await input.getFrame(index);
      const img = frame.type === 'jpg' ? await doc.embedJpg(frame.bytes) : await doc.embedPng(frame.bytes);
      draw.image(img, cell);
      draw.text(String(index + 1), cell.x + 0.6, cell.y + cell.h + 1.2, 6, GREY);
      input.onProgress?.(++done, input.frameCount);
    }

    for (const m of layout.gridMarkers) draw.marker(m);
    for (const m of layout.anchors) draw.marker(m);

    const payload = encodePayload({
      version: LAYOUT_VERSION,
      projectId: input.projectId,
      page: p,
      pages,
      spec: input.spec,
      fps: input.fps,
      frameCount: input.frameCount,
    });
    draw.qr(payload, layout.qr);

    const title = input.title ? ` · ${input.title}` : '';
    draw.text(`rotopaper${title}`, layout.header.x, layout.header.y + 3.2, 8, BLACK);
    draw.textRight(`${input.projectId} · page ${p} / ${pages}`, layout.header.x + layout.header.w, layout.header.y + 3.2, 8, BLACK);
    draw.text(
      `frames ${first + 1}–${last + 1} of ${input.frameCount} · ${+input.fps.toFixed(3)} fps`,
      layout.footer.x,
      layout.footer.y + layout.footer.h - 4.6,
      7,
      GREY,
    );
    draw.text(
      'Paint freely, but keep the black squares and the QR code clean.',
      layout.footer.x,
      layout.footer.y + layout.footer.h - 1.4,
      7,
      GREY,
    );
  }

  return doc.save();
}

class Drawer {
  private page: PDFPage;
  private pageH: number;
  private font: PDFFont;

  constructor(page: PDFPage, pageH: number, font: PDFFont) {
    this.page = page;
    this.pageH = pageH;
    this.font = font;
  }

  rect(x: number, y: number, w: number, h: number, color = BLACK) {
    this.page.drawRectangle({ x: x * PT, y: (this.pageH - y - h) * PT, width: w * PT, height: h * PT, color });
  }

  image(img: Parameters<PDFPage['drawImage']>[0], r: Rect) {
    this.page.drawImage(img, { x: r.x * PT, y: (this.pageH - r.y - r.h) * PT, width: r.w * PT, height: r.h * PT });
  }

  /** baseline at y (mm from top) */
  text(s: string, x: number, y: number, sizePt: number, color = BLACK) {
    this.page.drawText(latin1(s), { x: x * PT, y: (this.pageH - y) * PT, size: sizePt, font: this.font, color });
  }

  textRight(s: string, xRight: number, y: number, sizePt: number, color = BLACK) {
    const w = this.font.widthOfTextAtSize(latin1(s), sizePt) / PT;
    this.text(s, xRight - w, y, sizePt, color);
  }

  /** ArUco 4x4 marker with a 1-module black border, white bits punched out. */
  marker(m: MarkerPlace) {
    const code = ARUCO_4X4_250[m.id];
    const mod = m.size / 6;
    this.rect(m.x, m.y, m.size, m.size, BLACK);
    for (let r = 0; r < 4; r++) {
      let c = 0;
      while (c < 4) {
        if (!(code & (1 << (r * 4 + c)))) {
          c++;
          continue;
        }
        let run = 1;
        while (c + run < 4 && code & (1 << (r * 4 + c + run))) run++;
        this.rect(m.x + (c + 1) * mod, m.y + (r + 1) * mod, run * mod, mod, WHITE);
        c += run;
      }
    }
  }

  qr(text: string, r: Rect) {
    const q = qrcode(0, 'M');
    q.addData(text, 'Alphanumeric');
    q.make();
    const n = q.getModuleCount();
    const mod = r.w / n;
    for (let row = 0; row < n; row++) {
      let c = 0;
      while (c < n) {
        if (!q.isDark(row, c)) {
          c++;
          continue;
        }
        let run = 1;
        while (c + run < n && q.isDark(row, c + run)) run++;
        this.rect(r.x + c * mod, r.y + row * mod, run * mod, mod);
        c += run;
      }
    }
  }
}

/** The built-in PDF font only covers Latin-1; drop anything else (emoji in file names etc.). */
function latin1(s: string): string {
  return s.replace(/[^\x20-\x7e\xa0-\xff–·]/g, '');
}


// What goes on a sheet, independent of the output. The PDF writer and the
// on-screen preview both implement SheetCanvas, so they can't drift apart.

import qrcode from 'qrcode-generator';
import { ARUCO_4X4_250 } from './aruco-dict.ts';
import type { Layout, MarkerPlace, Rect } from './layout.ts';
import { encodePayload, firstFrameOfPage, type SheetPayload } from './payload.ts';

export interface SheetStyle {
  /** title, sheet number, frame numbers, note */
  text: boolean;
  /** thin outline around each frame */
  borders: boolean;
}

export interface SheetCanvas {
  fill(r: Rect, white?: boolean): void;
  outline(r: Rect, width: number): void;
  frame(index: number, r: Rect): void | Promise<void>;
  /** baseline at y; size in pt */
  text(s: string, x: number, y: number, size: number, opts?: { right?: boolean; grey?: boolean }): void;
}

export interface SheetContent {
  layout: Layout;
  payload: SheetPayload;
  title?: string;
  style: SheetStyle;
}

export async function drawSheet(c: SheetCanvas, { layout, payload, title, style }: SheetContent): Promise<void> {
  const first = firstFrameOfPage(payload);
  const count = Math.min(layout.cells.length, payload.frameCount - first);

  for (let i = 0; i < count; i++) await c.frame(first + i, layout.cells[i]);
  if (style.borders) for (let i = 0; i < count; i++) c.outline(layout.cells[i], 0.2);

  for (const m of layout.gridMarkers) marker(c, m);
  for (const m of layout.anchors) marker(c, m);
  qr(c, encodePayload(payload), layout.qr);

  if (!style.text) return;
  const { header, footer } = layout;
  const last = first + count;
  c.text(title ? `rotopaper · ${title}` : 'rotopaper', header.x, header.y + 3.2, 8);
  c.text(`${payload.projectId} · sheet ${payload.page} of ${payload.pages}`, header.x + header.w, header.y + 3.2, 8, { right: true });
  for (let i = 0; i < count; i++) {
    const cell = layout.cells[i];
    // 6 pt digits are ~2.1 mm tall; keep 1 mm air below the frame
    c.text(String(first + i + 1), cell.x, cell.y + cell.h + 3.2, 6, { grey: true });
  }
  c.text(`frames ${first + 1}–${last} of ${payload.frameCount} · ${payload.fps} fps`, footer.x, footer.y + footer.h - 4.6, 7, { grey: true });
  c.text('Don’t paint over the black squares or the QR code.', footer.x, footer.y + footer.h - 1.4, 7, { grey: true });
}

/** ArUco 4x4 marker with a 1-module black border, white bits punched out. */
function marker(c: SheetCanvas, m: MarkerPlace) {
  const code = ARUCO_4X4_250[m.id];
  const mod = m.size / 6;
  c.fill({ x: m.x, y: m.y, w: m.size, h: m.size });
  for (let r = 0; r < 4; r++) {
    let col = 0;
    while (col < 4) {
      if (!(code & (1 << (r * 4 + col)))) {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < 4 && code & (1 << (r * 4 + col + run))) run++;
      c.fill({ x: m.x + (col + 1) * mod, y: m.y + (r + 1) * mod, w: run * mod, h: mod }, true);
      col += run;
    }
  }
}

function qr(c: SheetCanvas, text: string, r: Rect) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Alphanumeric');
  q.make();
  const n = q.getModuleCount();
  const mod = r.w / n;
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!q.isDark(row, col)) {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < n && q.isDark(row, col + run)) run++;
      c.fill({ x: r.x + col * mod, y: r.y + row * mod, w: run * mod, h: mod });
      col += run;
    }
  }
}

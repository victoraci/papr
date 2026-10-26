// On-screen sheet preview: the same drawSheet() as the PDF, rendered as SVG.

import type { Layout, Rect } from '../core/layout.ts';
import type { SheetPayload } from '../core/payload.ts';
import { drawSheet, type SheetCanvas, type SheetStyle } from '../core/sheet.ts';

const NS = 'http://www.w3.org/2000/svg';
const PT_MM = 25.4 / 72;

class SvgCanvas implements SheetCanvas {
  root: SVGSVGElement;
  private thumbs: (index: number) => string | undefined;

  constructor(w: number, h: number, thumbs: (index: number) => string | undefined) {
    this.thumbs = thumbs;
    this.root = document.createElementNS(NS, 'svg');
    this.root.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.add('rect', { x: 0, y: 0, width: w, height: h, fill: '#fff' });
  }

  private add(tag: string, attrs: Record<string, string | number>) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    this.root.append(e);
    return e;
  }

  fill(r: Rect, white = false) {
    // a hair larger, so neighbouring modules don't show seams when scaled down
    this.add('rect', { x: r.x, y: r.y, width: r.w + 0.02, height: r.h + 0.02, fill: white ? '#fff' : '#000' });
  }

  outline(r: Rect, width: number) {
    const o = width / 2;
    this.add('rect', { x: r.x - o, y: r.y - o, width: r.w + width, height: r.h + width, fill: 'none', stroke: '#262626', 'stroke-width': width });
  }

  frame(index: number, r: Rect) {
    const href = this.thumbs(index);
    if (href) this.add('image', { href, x: r.x, y: r.y, width: r.w, height: r.h, preserveAspectRatio: 'none' });
    else this.add('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#e6e6e6' });
  }

  text(s: string, x: number, y: number, size: number, opts: { right?: boolean; grey?: boolean } = {}) {
    const t = this.add('text', {
      x,
      y,
      'font-size': size * PT_MM,
      'font-family': 'Helvetica, Arial, sans-serif',
      fill: opts.grey ? '#737373' : '#000',
      'text-anchor': opts.right ? 'end' : 'start',
    });
    t.textContent = s;
  }
}

export async function renderSheetSvg(
  layout: Layout,
  payload: SheetPayload,
  style: SheetStyle,
  title: string | undefined,
  thumbs: (index: number) => string | undefined,
): Promise<SVGSVGElement> {
  const c = new SvgCanvas(layout.pageW, layout.pageH, thumbs);
  await drawSheet(c, { layout, payload, style, title });
  return c.root;
}

/** A sheet of copies, as buildCopiesPdf() draws it. */
export function renderCopiesSvg(pageW: number, pageH: number, cells: Rect[], href: string | undefined, outline: boolean): SVGSVGElement {
  const c = new SvgCanvas(pageW, pageH, () => href);
  for (const r of cells) {
    c.frame(0, r);
    if (outline) c.outline({ x: r.x + 0.1, y: r.y + 0.1, w: r.w - 0.2, h: r.h - 0.2 }, 0.2);
  }
  return c.root;
}

// A picture of your own, for printing copies of it: shown with its crop on
// top, drag to move the crop.

import type { FrameImage } from '../core/pdf.ts';
import { el } from './ui.ts';
import { cropRect } from './video.ts';
import { dragCrop, showCrop } from './videoview.ts';

const LONG_SIDE = 720;

export interface Picture {
  file: File;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** where the crop sits (0 = left/top, 1 = right/bottom) */
  cropX: number;
  cropY: number;
}

export async function loadPicture(file: File): Promise<Picture> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This picture format is not supported by your browser.');
  });
  return { file, bitmap, width: bitmap.width, height: bitmap.height, cropX: 0.5, cropY: 0.5 };
}

/**
 * The cropped picture, `width` px wide at most (never above its own size).
 * PNGs stay PNG, so line art and see-through parts come out clean.
 */
export async function pictureImage(p: Picture, aspect: number, width: number): Promise<FrameImage> {
  const c = cropRect(p, { aspect, x: p.cropX, y: p.cropY });
  const w = Math.max(2, Math.round(Math.min(width, c.sw)));
  const h = Math.max(2, Math.round(w / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const png = p.file.type === 'image/png';
  if (!png) {
    // JPEG has no see-through parts: those go on white, like the paper
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(p.bitmap, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the picture.'))), png ? 'image/png' : 'image/jpeg', 0.92),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: png ? 'png' : 'jpg' };
}

export function pictureView(host: { picture(): Picture | null; aspect(): number; onCrop(x: number, y: number, done: boolean): void }) {
  const canvas = el('canvas');
  const box = el('div', { class: 'crop-box' });
  const wrap = el('div', { class: 'picture' }, canvas, box);
  const holder = el('div', { class: 'picture-holder' }, wrap);
  const ctx = canvas.getContext('2d')!;
  let shown: ImageBitmap | null = null;
  let a = 1;

  function fit() {
    const w = Math.min(holder.clientWidth, holder.clientHeight * a);
    wrap.style.width = `${Math.floor(w)}px`;
    wrap.style.height = `${Math.floor(w / a)}px`;
  }
  new ResizeObserver(fit).observe(holder);

  function refresh() {
    const p = host.picture();
    if (!p) return;
    if (p.bitmap !== shown) {
      const s = Math.min(1, LONG_SIDE / Math.max(p.width, p.height));
      canvas.width = Math.round(p.width * s);
      canvas.height = Math.round(p.height * s);
      // see-through parts on the paper colour
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(p.bitmap, 0, 0, canvas.width, canvas.height);
      a = p.width / p.height;
      holder.style.setProperty('--ar', `${p.width} / ${p.height}`);
      shown = p.bitmap;
      fit();
    }
    showCrop(wrap, box, p, { x: p.cropX, y: p.cropY }, host.aspect());
    wrap.title = box.hidden ? '' : 'Drag to move the crop';
  }

  wrap.onpointerdown = (e) => {
    const p = host.picture();
    if (!p) return;
    dragCrop(wrap, e, p, { x: p.cropX, y: p.cropY }, host.aspect(), {
      move: (x, y) => (host.onCrop(x, y, false), refresh()),
      done: (x, y) => (host.onCrop(x, y, true), refresh()),
      click: () => {},
    });
  };

  return { el: holder, refresh };
}

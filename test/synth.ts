// Synthetic test frames: a bouncing ball on a colour cycle, plus a 10-bit
// barcode of the frame index so a test can check every frame landed in the
// right place after print → scan → detect.

import type { RGBAImage } from '../src/core/image.ts';

export const BARCODE_BITS = 10;

function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

/** Barcode boxes in relative frame coordinates (0..1). */
export function barcodeBoxes(): { x: number; y: number; w: number; h: number }[] {
  const boxes = [];
  for (let b = 0; b < BARCODE_BITS; b++) boxes.push({ x: 0.06 + b * 0.088, y: 0.83, w: 0.07, h: 0.1 });
  return boxes;
}

export function makeFrame(i: number, n: number, w = 640, h = 360): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const t = i / n;
  const ballX = w * (0.15 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t)));
  const ballY = h * (0.7 - 0.5 * Math.abs(Math.sin(2 * Math.PI * t * 2)));
  const ballR = h * 0.12;
  const boxes = barcodeBoxes();

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let [r, g, b] = hsv((t * 360 + (y / h) * 40) % 360, 0.35, 0.95 - (y / h) * 0.25);
      // corner checkers help eyeballing alignment
      const inCorner = (x < 40 || x >= w - 40) && (y < 40 || y >= h - 40);
      if (inCorner && ((x >> 3) + (y >> 3)) % 2 === 0) r = g = b = 20;
      if ((x - ballX) ** 2 + (y - ballY) ** 2 < ballR * ballR) [r, g, b] = [230, 60, 40];
      for (let k = 0; k < boxes.length; k++) {
        const bx = boxes[k];
        if (x >= bx.x * w && x < (bx.x + bx.w) * w && y >= bx.y * h && y < (bx.y + bx.h) * h) {
          const on = (i >> k) & 1;
          r = g = b = on ? 15 : 250;
        }
      }
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  return { width: w, height: h, data };
}

/** Reads the frame index back from an extracted frame (any size). */
export function readBarcode(img: RGBAImage): number {
  let v = 0;
  barcodeBoxes().forEach((bx, k) => {
    // average the inner half of the box
    let sum = 0;
    let cnt = 0;
    const x0 = Math.floor((bx.x + bx.w * 0.25) * img.width);
    const x1 = Math.ceil((bx.x + bx.w * 0.75) * img.width);
    const y0 = Math.floor((bx.y + bx.h * 0.25) * img.height);
    const y1 = Math.ceil((bx.y + bx.h * 0.75) * img.height);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = (y * img.width + x) * 4;
        sum += (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3;
        cnt++;
      }
    if (sum / cnt < 128) v |= 1 << k;
  });
  return v;
}

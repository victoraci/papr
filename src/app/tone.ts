// Lighter or darker for print, as a gamma curve: the dark parts and the middle
// move, white stays white and black stays black. The same curve as an SVG
// filter shows it on screen without touching the pixels.

const STRENGTH = 1.3;
const FILTER_ID = 'papr-tone';

/** Gamma exponent for a brightness of -100 … 100 (0 = unchanged). */
const exponent = (brightness: number) => 2 ** ((-brightness / 100) * STRENGTH);

/** Changes the pixels of the canvas in place. */
export function applyTone(ctx: CanvasRenderingContext2D, w: number, h: number, brightness: number) {
  if (!brightness) return;
  const e = exponent(brightness);
  const curve = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.round(255 * (i / 255) ** e);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = curve[d[i]];
    d[i + 1] = curve[d[i + 1]];
    d[i + 2] = curve[d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
}

/** A CSS filter that shows the same curve on screen. */
export function toneFilter(brightness: number): string {
  if (!brightness) return 'none';
  let funcs = document.querySelectorAll<SVGElement>(`#${FILTER_ID} [type="gamma"]`);
  if (!funcs.length) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0';
    // sRGB, so it matches the curve on the pixels (filters work in linear light by default)
    svg.innerHTML = `<filter id="${FILTER_ID}" color-interpolation-filters="sRGB"><feComponentTransfer>${['R', 'G', 'B']
      .map((c) => `<feFunc${c} type="gamma" amplitude="1" offset="0" exponent="1"/>`)
      .join('')}</feComponentTransfer></filter>`;
    document.body.append(svg);
    funcs = svg.querySelectorAll('[type="gamma"]');
  }
  for (const f of funcs) f.setAttribute('exponent', String(exponent(brightness)));
  return `url(#${FILTER_ID})`;
}

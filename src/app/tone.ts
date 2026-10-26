// Lighter or darker for print, as a gamma curve: the dark parts and the middle
// move, white stays white and black stays black. Inverted first if wanted, so
// the curve works on what you see. The same as an SVG filter shows it on
// screen without touching the pixels.

export interface Tone {
  /** -100 … 100, 0 = as it is */
  brightness: number;
  invert: boolean;
}

const STRENGTH = 1.3;
const FILTER_ID = 'papr-tone';

/** Gamma exponent for a brightness (1 = unchanged). */
const exponent = (brightness: number) => 2 ** ((-brightness / 100) * STRENGTH);
const plain = (t?: Tone) => !t || (!t.brightness && !t.invert);

/** Changes the pixels of the canvas in place. */
export function applyTone(ctx: CanvasRenderingContext2D, w: number, h: number, tone?: Tone) {
  if (!tone || plain(tone)) return;
  const e = exponent(tone.brightness);
  const curve = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.round(255 * ((tone.invert ? 255 - i : i) / 255) ** e);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = curve[d[i]];
    d[i + 1] = curve[d[i + 1]];
    d[i + 2] = curve[d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
}

/** A CSS filter that shows the same on screen. */
export function toneFilter(tone: Tone): string {
  if (plain(tone)) return 'none';
  let filter = document.getElementById(FILTER_ID);
  if (!filter) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0';
    const funcs = (attrs: string) => ['R', 'G', 'B'].map((c) => `<feFunc${c} ${attrs}/>`).join('');
    // sRGB, so it matches the curve on the pixels (filters work in linear light by default)
    svg.innerHTML = `<filter id="${FILTER_ID}" color-interpolation-filters="sRGB">
      <feComponentTransfer>${funcs('type="table" tableValues="0 1"')}</feComponentTransfer>
      <feComponentTransfer>${funcs('type="gamma" amplitude="1" offset="0" exponent="1"')}</feComponentTransfer>
    </filter>`;
    document.body.append(svg);
    filter = document.getElementById(FILTER_ID)!;
  }
  for (const f of filter.querySelectorAll('[type="table"]')) f.setAttribute('tableValues', tone.invert ? '1 0' : '0 1');
  for (const f of filter.querySelectorAll('[type="gamma"]')) f.setAttribute('exponent', String(exponent(tone.brightness)));
  return `url(#${FILTER_ID})`;
}

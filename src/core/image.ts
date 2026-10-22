/** Plain RGBA pixels; ImageData-compatible, but also usable in Node. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Expands RGB or grey pixel data to RGBA. */
export function toRGBA(width: number, height: number, data: ArrayLike<number>, channels: number): RGBAImage {
  if (channels === 4) return { width, height, data: Uint8ClampedArray.from(data) };
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    out[i * 4] = data[j];
    out[i * 4 + 1] = data[channels >= 3 ? j + 1 : j];
    out[i * 4 + 2] = data[channels >= 3 ? j + 2 : j];
    out[i * 4 + 3] = 255;
  }
  return { width, height, data: out };
}

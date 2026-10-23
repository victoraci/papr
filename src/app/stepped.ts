// Plays the chosen part of the video at the print frame rate, i.e. exactly
// the frames that will end up on paper. Frames are cached after the first
// pass, so the loop runs smoothly from the second time on.

import { el } from './ui.ts';
import { cropRect, frameTime, seek, videoElement, type Crop, type LoadedVideo } from './video.ts';

const WIDTH = 960;

export interface SteppedParams {
  video: LoadedVideo;
  start: number;
  end: number;
  fps: number;
  crop: Crop;
}

export function steppedPlayer(onFrame?: (time: number | null) => void) {
  const canvas = el('canvas', { class: 'stepped', title: 'Click to pause' });
  const ctx = canvas.getContext('2d')!;
  let params: SteppedParams | null = null;
  let key = '';
  let cache = new Map<number, ImageBitmap>();
  let source: HTMLVideoElement | null = null;
  let sourceUrl = '';
  let busy = false;
  let playing = true;
  let t0 = performance.now();
  let shown = -1;

  const frames = () => (params ? Math.max(1, Math.floor((params.end - params.start) * params.fps + 1e-6)) : 0);

  async function fetchFrame(k: number) {
    if (!params || busy) return;
    busy = true;
    const p = params;
    const myKey = key;
    try {
      if (sourceUrl !== p.video.url) {
        source = await videoElement(p.video.url);
        sourceUrl = p.video.url;
      }
      await seek(source!, frameTime(p.video, p.start, p.fps, k));
      if (myKey !== key) return;
      const c = cropRect(p.video, p.crop);
      const bmp = await createImageBitmap(source!, c.sx, c.sy, c.sw, c.sh, {
        resizeWidth: canvas.width,
        resizeHeight: canvas.height,
      });
      if (myKey === key) cache.set(k, bmp);
      else bmp.close();
    } finally {
      busy = false;
    }
  }

  function tick(now: number) {
    const n = frames();
    if (params && n) {
      const k = playing ? Math.floor(((now - t0) / 1000) * params.fps) % n : Math.max(0, shown);
      const bmp = cache.get(k);
      if (bmp && k !== shown) {
        ctx.drawImage(bmp, 0, 0);
        shown = k;
        onFrame?.(params.start + k / params.fps);
      } else if (!bmp) void fetchFrame(k);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  canvas.onclick = () => {
    playing = !playing;
    // resume from the frame on screen
    if (playing && params) t0 = performance.now() - (Math.max(0, shown) / params.fps) * 1000;
  };

  return {
    el: canvas,
    set(p: SteppedParams) {
      // the end only changes how many frames loop; cached frames stay valid
      const k = `${p.video.url}|${p.start.toFixed(3)}|${p.fps}|${p.crop.aspect.toFixed(4)}|${p.crop.x.toFixed(3)}|${p.crop.y.toFixed(3)}`;
      const rangeChanged = !params || params.video !== p.video || params.start !== p.start || params.fps !== p.fps;
      params = p;
      if (k === key) return;
      key = k;
      for (const b of cache.values()) b.close();
      cache = new Map();
      // resizing clears the canvas, so only do it when the shape changes;
      // otherwise the last frame stays up until the new ones are in
      const h = Math.max(2, Math.round(WIDTH / p.crop.aspect));
      if (canvas.width !== WIDTH || canvas.height !== h) {
        canvas.width = WIDTH;
        canvas.height = h;
      }
      // a new range plays from its start; a crop change keeps the position
      if (rangeChanged) t0 = performance.now();
      shown = -1;
    },
  };
}

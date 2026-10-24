// The chosen part of the video at the print frame rate, i.e. exactly the
// frames that end up on paper, with the crop on top: drag the picture to move
// the crop, click it to pause. Frames are cached after the first pass, so the
// loop runs smoothly from the second time on.

import { el } from './ui.ts';
import { cropRect, frameTime, seek, videoElement, type Crop, type LoadedVideo } from './video.ts';

const LONG_SIDE = 960;

export interface ViewParams {
  video: LoadedVideo;
  start: number;
  end: number;
  fps: number;
  crop: Crop;
}

export function videoView(setCrop: (c: Crop) => void, onFrame?: (time: number) => void) {
  const canvas = el('canvas');
  const box = el('div', { class: 'crop-box' });
  const wrap = el('div', { class: 'picture' }, canvas, box);
  // holder takes the free space; the picture is fitted into it
  const holder = el('div', { class: 'picture-holder' }, wrap);
  const ctx = canvas.getContext('2d')!;

  let params: ViewParams | null = null;
  let key = '';
  let cache = new Map<number, ImageBitmap>();
  let source: HTMLVideoElement | null = null;
  let sourceUrl = '';
  let busy = false;
  let playing = true;
  let t0 = performance.now();
  let shown = -1;

  const frames = () => (params ? Math.max(1, Math.floor((params.end - params.start) * params.fps + 1e-6)) : 0);

  function fit() {
    if (!params) return;
    const a = params.video.width / params.video.height;
    const w = Math.min(holder.clientWidth, holder.clientHeight * a);
    wrap.style.width = `${Math.floor(w)}px`;
    wrap.style.height = `${Math.floor(w / a)}px`;
  }
  new ResizeObserver(fit).observe(holder);

  /** True when the crop leaves part of the picture out, i.e. there is something to move. */
  const movable = () => {
    if (!params) return false;
    const { video: v } = params;
    const c = cropRect(v, params.crop);
    return c.sw < v.width - 1 || c.sh < v.height - 1;
  };

  function syncCrop() {
    if (!params) return;
    const { video: v } = params;
    const c = cropRect(v, params.crop);
    box.hidden = !movable();
    box.style.left = `${(c.sx / v.width) * 100}%`;
    box.style.top = `${(c.sy / v.height) * 100}%`;
    box.style.width = `${(c.sw / v.width) * 100}%`;
    box.style.height = `${(c.sh / v.height) * 100}%`;
    wrap.classList.toggle('movable', movable());
    wrap.title = movable() ? 'Drag to move the crop, click to pause' : 'Click to pause';
  }

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
      const bmp = await createImageBitmap(source!, { resizeWidth: canvas.width, resizeHeight: canvas.height });
      if (myKey === key) cache.set(k, bmp);
      else bmp.close();
    } finally {
      busy = false;
    }
  }

  function tick(now: number) {
    const n = frames();
    if (params && n) {
      const k = playing ? Math.floor(((now - t0) / 1000) * params.fps) % n : Math.max(0, Math.min(shown, n - 1));
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

  // a click pauses, a drag moves the crop
  wrap.onpointerdown = (e) => {
    if (!params) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const r = wrap.getBoundingClientRect();
    const { video: v } = params;
    const start = { x: e.clientX, y: e.clientY, crop: params.crop };
    const c = cropRect(v, start.crop);
    // slack = how far the crop can move, as a share of the shown picture
    const slackX = (v.width - c.sw) / v.width;
    const slackY = (v.height - c.sh) / v.height;
    let dragged = false;
    wrap.onpointermove = (m) => {
      const dx = (m.clientX - start.x) / r.width;
      const dy = (m.clientY - start.y) / r.height;
      if (!dragged && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 4) return;
      dragged = true;
      if (!movable()) return;
      setCrop({
        ...start.crop,
        x: slackX > 0 ? Math.min(1, Math.max(0, start.crop.x + dx / slackX)) : 0.5,
        y: slackY > 0 ? Math.min(1, Math.max(0, start.crop.y + dy / slackY)) : 0.5,
      });
    };
    wrap.onpointerup = () => {
      wrap.onpointermove = null;
      wrap.onpointerup = null;
      if (dragged) return;
      playing = !playing;
      // resume from the frame on screen
      if (playing && params) t0 = performance.now() - (Math.max(0, shown) / params.fps) * 1000;
    };
  };

  return {
    el: holder,
    set(p: ViewParams) {
      const rangeChanged = !params || params.video !== p.video || params.start !== p.start || params.fps !== p.fps;
      params = p;
      syncCrop();
      // the crop is drawn on top and the end only changes how many frames
      // loop, so cached frames stay valid for both
      const k = `${p.video.url}|${p.start.toFixed(3)}|${p.fps}`;
      if (k === key) return;
      key = k;
      for (const b of cache.values()) b.close();
      cache = new Map();
      const s = LONG_SIDE / Math.max(p.video.width, p.video.height);
      const w = Math.round(p.video.width * s);
      const h = Math.round(p.video.height * s);
      // resizing clears the canvas, so only do it for a new video
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        holder.style.setProperty('--ar', `${w} / ${h}`); // phones size the holder by it
        fit();
      }
      if (rangeChanged) t0 = performance.now();
      shown = -1;
    },
  };
}

// The edit at the print frame rate, i.e. exactly the frames that end up on
// paper, with the crop of the clip on screen on top: drag the picture to move
// that crop, click it to play or pause. Frames are cached as they are shown,
// so the loop runs smoothly from the second time on.

import { frameAt, frameCount, type Clip } from './sequence.ts';
import { el } from './ui.ts';
import { cropRect, seek, videoElement } from './video.ts';

const LONG_SIDE = 720;
const CACHE = 300; // frames kept, oldest go first

export interface ViewHost {
  clips(): Clip[];
  fps(): number;
  aspect(): number;
  /** the crop of a clip was dragged; done when the pointer is released */
  onCrop(id: number, x: number, y: number, done: boolean): void;
  /** another frame is on screen; t = timeline time, s */
  onTime(t: number): void;
}

export function videoView(host: ViewHost) {
  const canvas = el('canvas');
  const box = el('div', { class: 'crop-box' });
  const wrap = el('div', { class: 'picture' }, canvas, box);
  // holder takes the free space; the picture is fitted into it
  const holder = el('div', { class: 'picture-holder' }, wrap);
  const ctx = canvas.getContext('2d')!;

  const cache = new Map<string, ImageBitmap>();
  const sources = new Map<string, HTMLVideoElement>();
  let busy = false;
  let playing = false;
  let k = 0; // frame on screen (or wanted)
  let playFrom = 0;
  let t0 = performance.now();
  let shown = '';
  let size = { w: 0, h: 0, a: 16 / 9 };

  const count = () => frameCount(host.clips(), host.fps());
  const keyOf = (i: number) => {
    const { clip, source } = frameAt(host.clips(), host.fps(), i);
    return { clip, source, key: `${clip.video.url}|${source.toFixed(3)}` };
  };

  function fit() {
    const w = Math.min(holder.clientWidth, holder.clientHeight * size.a);
    wrap.style.width = `${Math.floor(w)}px`;
    wrap.style.height = `${Math.floor(w / size.a)}px`;
  }
  new ResizeObserver(fit).observe(holder);

  /** Canvas sized to the video of the clip on screen. */
  function sizeFor(clip: Clip) {
    const v = clip.video;
    const s = LONG_SIDE / Math.max(v.width, v.height);
    const w = Math.round(v.width * s);
    const h = Math.round(v.height * s);
    if (w !== size.w || h !== size.h) {
      size = { w, h, a: w / h };
      canvas.width = w;
      canvas.height = h;
      holder.style.setProperty('--ar', `${w} / ${h}`); // phones size the holder by it
      fit();
      shown = '';
    }
  }

  const current = (): Clip | null => (count() ? keyOf(Math.min(k, count() - 1)).clip : null);
  const movable = (clip: Clip) => {
    const c = cropRect(clip.video, { aspect: host.aspect(), x: clip.cropX, y: clip.cropY });
    return c.sw < clip.video.width - 1 || c.sh < clip.video.height - 1;
  };

  function syncCrop() {
    const clip = current();
    if (!clip) return;
    const v = clip.video;
    const c = cropRect(v, { aspect: host.aspect(), x: clip.cropX, y: clip.cropY });
    box.hidden = !movable(clip);
    box.style.left = `${(c.sx / v.width) * 100}%`;
    box.style.top = `${(c.sy / v.height) * 100}%`;
    box.style.width = `${(c.sw / v.width) * 100}%`;
    box.style.height = `${(c.sh / v.height) * 100}%`;
    wrap.classList.toggle('movable', movable(clip));
    wrap.title = movable(clip) ? 'Drag to move the crop, click to play or pause' : 'Click to play or pause';
  }

  async function fetchFrame(i: number) {
    if (busy) return;
    busy = true;
    try {
      const { clip, source, key } = keyOf(i);
      if (cache.has(key)) return;
      let v = sources.get(clip.video.url);
      if (!v) {
        v = await videoElement(clip.video.url);
        sources.set(clip.video.url, v);
      }
      await seek(v, source);
      const s = LONG_SIDE / Math.max(clip.video.width, clip.video.height);
      const bmp = await createImageBitmap(v, { resizeWidth: Math.round(clip.video.width * s), resizeHeight: Math.round(clip.video.height * s) });
      cache.set(key, bmp);
      while (cache.size > CACHE) {
        const oldest = cache.keys().next().value!;
        cache.get(oldest)!.close();
        cache.delete(oldest);
      }
    } finally {
      busy = false;
    }
  }

  function tick(now: number) {
    const n = count();
    if (!n && shown !== 'empty') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      box.hidden = true;
      shown = 'empty';
    }
    if (n) {
      if (playing) k = (playFrom + Math.floor(((now - t0) / 1000) * host.fps())) % n;
      k = Math.min(k, n - 1);
      const { clip, key } = keyOf(k);
      const bmp = cache.get(key);
      if (bmp) {
        if (key !== shown) {
          sizeFor(clip);
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          shown = key;
          syncCrop();
          host.onTime(k / host.fps());
        }
        // look a few frames ahead while there's time
        for (let d = 1; d <= 6; d++)
          if (!cache.has(keyOf((k + d) % n).key)) {
            void fetchFrame((k + d) % n);
            break;
          }
      } else void fetchFrame(k);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // a click plays / pauses, a drag moves the crop
  wrap.onpointerdown = (e) => {
    const clip = current();
    if (!clip) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const r = wrap.getBoundingClientRect();
    const v = clip.video;
    const start = { x: e.clientX, y: e.clientY, cx: clip.cropX, cy: clip.cropY };
    const c = cropRect(v, { aspect: host.aspect(), x: clip.cropX, y: clip.cropY });
    // slack = how far the crop can move, as a share of the shown picture
    const slackX = (v.width - c.sw) / v.width;
    const slackY = (v.height - c.sh) / v.height;
    let dragged = false;
    let last = { x: start.cx, y: start.cy };
    wrap.onpointermove = (m) => {
      if (!dragged && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 4) return;
      dragged = true;
      if (!movable(clip)) return;
      const dx = (m.clientX - start.x) / r.width;
      const dy = (m.clientY - start.y) / r.height;
      last = {
        x: slackX > 0 ? Math.min(1, Math.max(0, start.cx + dx / slackX)) : 0.5,
        y: slackY > 0 ? Math.min(1, Math.max(0, start.cy + dy / slackY)) : 0.5,
      };
      host.onCrop(clip.id, last.x, last.y, false);
      syncCrop();
    };
    wrap.onpointerup = () => {
      wrap.onpointermove = null;
      wrap.onpointerup = null;
      if (dragged) host.onCrop(clip.id, last.x, last.y, true);
      else toggle();
    };
  };

  function play() {
    if (!count()) return;
    if (k >= count() - 1) k = 0;
    playFrom = k;
    t0 = performance.now();
    playing = true;
  }
  function pause() {
    playing = false;
  }
  function toggle() {
    if (playing) pause();
    else play();
  }

  return {
    el: holder,
    /** the edit changed: redraw what's under the playhead */
    refresh() {
      const n = count();
      if (n) k = Math.min(k, n - 1);
      shown = '';
      if (playing) {
        playFrom = k;
        t0 = performance.now();
      }
      syncCrop();
    },
    seek(t: number) {
      const n = count();
      k = Math.max(0, Math.min(n - 1, Math.floor(t * host.fps() + 1e-6)));
      playing = false;
      shown = '';
    },
    time: () => k / host.fps(),
    playing: () => playing,
    play,
    pause,
    toggle,
    /** the clip under the playhead */
    current,
  };
}

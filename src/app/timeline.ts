// Video timeline: a film strip of the whole clip with a selection you can
// drag by its edges or move as a whole, plus a playhead.

import { el } from './ui.ts';
import { seek, videoElement, type LoadedVideo } from './video.ts';

export interface Range {
  start: number;
  end: number;
}

export function timeline(get: () => Range, set: (r: Range) => void, minLength: () => number) {
  const strip = el('canvas', { class: 'strip' });
  const dimL = el('div', { class: 'tl-dim' });
  const dimR = el('div', { class: 'tl-dim' });
  const handleL = el('div', { class: 'tl-handle left' });
  const handleR = el('div', { class: 'tl-handle right' });
  const sel = el('div', { class: 'tl-sel' }, handleL, handleR);
  const head = el('div', { class: 'tl-head' });
  const track = el('div', { class: 'timeline' }, strip, dimL, dimR, sel, head);

  let duration = 1;
  let video: LoadedVideo | null = null;
  let stripRun = 0;

  const pct = (t: number) => `${(t / duration) * 100}%`;

  function sync() {
    const { start, end } = get();
    dimL.style.left = '0';
    dimL.style.width = pct(start);
    dimR.style.left = pct(end);
    dimR.style.right = '0';
    sel.style.left = pct(start);
    sel.style.width = pct(end - start);
  }

  function setPlayhead(t: number | null) {
    head.hidden = t === null;
    if (t !== null) head.style.left = pct(t);
  }

  // --- dragging ---
  const timeAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  function drag(target: HTMLElement, mode: 'start' | 'end' | 'move') {
    target.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      target.setPointerCapture(e.pointerId);
      const t0 = timeAt(e.clientX);
      const r0 = get();
      target.onpointermove = (m) => {
        const t = timeAt(m.clientX);
        const min = minLength();
        if (mode === 'start') set({ start: Math.min(t, r0.end - min), end: r0.end });
        else if (mode === 'end') set({ start: r0.start, end: Math.max(t, r0.start + min) });
        else {
          const len = r0.end - r0.start;
          const s = Math.min(duration - len, Math.max(0, r0.start + t - t0));
          set({ start: s, end: s + len });
        }
        sync();
      };
      target.onpointerup = () => {
        target.onpointermove = null;
        target.onpointerup = null;
      };
    };
  }
  drag(handleL, 'start');
  drag(handleR, 'end');
  drag(sel, 'move');
  // clicking outside the selection pulls the nearer edge there
  track.onpointerdown = (e) => {
    const t = timeAt(e.clientX);
    const { start, end } = get();
    const min = minLength();
    if (t < start) set({ start: t, end: Math.max(end, t + min) });
    else if (t > end) set({ start: Math.min(start, t - min), end: t });
    sync();
  };

  // --- film strip ---
  async function drawStrip() {
    if (!video) return;
    const run = ++stripRun;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(track.clientWidth * dpr));
    const h = Math.round(track.clientHeight * dpr);
    strip.width = w;
    strip.height = h;
    const ctx = strip.getContext('2d')!;
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, 0, w, h);
    const tw = Math.round(h * (video.width / video.height));
    const n = Math.ceil(w / tw);
    const el = await videoElement(video.url);
    for (let i = 0; i < n; i++) {
      if (run !== stripRun) return;
      await seek(el, Math.min(video.duration - 0.01, ((i + 0.5) / n) * video.duration));
      ctx.drawImage(el, i * tw, 0, tw, h);
    }
  }
  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => void drawStrip(), 150);
  }).observe(track);

  return {
    el: track,
    sync,
    setPlayhead,
    load(v: LoadedVideo) {
      video = v;
      duration = v.duration;
      sync();
      void drawStrip();
    },
  };
}

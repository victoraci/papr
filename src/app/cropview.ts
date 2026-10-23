// Crop editor: the full video frame with the crop window on top. Drag the
// picture to move the crop; everything outside it is dimmed.

import { el } from './ui.ts';
import { cropRect, seek, videoElement, type Crop, type LoadedVideo } from './video.ts';

export function cropView(get: () => Crop, set: (c: Crop) => void) {
  const canvas = el('canvas');
  const box = el('div', { class: 'crop-box' });
  const wrap = el('div', { class: 'crop' }, canvas, box);
  // holder fills the stage; the picture is fitted into it
  const holder = el('div', { class: 'crop-holder' }, wrap);
  let video: LoadedVideo | null = null;

  function fit() {
    if (!video) return;
    const a = video.width / video.height;
    const w = Math.min(holder.clientWidth, holder.clientHeight * a);
    wrap.style.width = `${Math.floor(w)}px`;
    wrap.style.height = `${Math.floor(w / a)}px`;
  }
  new ResizeObserver(fit).observe(holder);

  function sync() {
    if (!video) return;
    const c = cropRect(video, get());
    box.style.left = `${(c.sx / video.width) * 100}%`;
    box.style.top = `${(c.sy / video.height) * 100}%`;
    box.style.width = `${(c.sw / video.width) * 100}%`;
    box.style.height = `${(c.sh / video.height) * 100}%`;
    wrap.classList.toggle('movable', c.sw < video.width - 1 || c.sh < video.height - 1);
  }

  wrap.onpointerdown = (e) => {
    if (!video) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const r = wrap.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, crop: get() };
    const c = cropRect(video, start.crop);
    // slack = how far the crop can move, as a share of the shown picture
    const slackX = (video.width - c.sw) / video.width;
    const slackY = (video.height - c.sh) / video.height;
    wrap.onpointermove = (m) => {
      const dx = (m.clientX - start.x) / r.width;
      const dy = (m.clientY - start.y) / r.height;
      set({
        ...start.crop,
        x: slackX > 0 ? Math.min(1, Math.max(0, start.crop.x + dx / slackX)) : 0.5,
        y: slackY > 0 ? Math.min(1, Math.max(0, start.crop.y + dy / slackY)) : 0.5,
      });
      sync();
    };
    wrap.onpointerup = () => {
      wrap.onpointermove = null;
      wrap.onpointerup = null;
    };
  };

  return {
    el: holder,
    sync,
    /** Shows the video frame at time t. */
    async load(v: LoadedVideo, t: number) {
      video = v;
      const src = await videoElement(v.url);
      await seek(src, Math.min(v.duration - 0.01, t + 0.001));
      const scale = Math.min(1, 1280 / v.width);
      canvas.width = Math.round(v.width * scale);
      canvas.height = Math.round(v.height * scale);
      canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
      fit();
      sync();
    },
  };
}

// Reading frames out of a video file in the browser (no upload, no ffmpeg).

import type { FrameImage } from '../core/pdf.ts';

export interface LoadedVideo {
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
}

/** Crop: target aspect + where the crop sits (0 = left/top, 1 = right/bottom). */
export interface Crop {
  aspect: number;
  x: number;
  y: number;
}

export async function loadVideo(file: File): Promise<LoadedVideo> {
  const url = URL.createObjectURL(file);
  try {
    const el = await videoElement(url);
    if (!el.videoWidth || !Number.isFinite(el.duration)) throw new Error('Could not read this video.');
    return { file, url, duration: el.duration, width: el.videoWidth, height: el.videoHeight };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

export function videoElement(url: string): Promise<HTMLVideoElement> {
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.src = url;
  return new Promise((resolve, reject) => {
    el.onloadeddata = () => resolve(el);
    el.onerror = () => reject(new Error('This video format is not supported by your browser.'));
  });
}

export function seek(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener('seeked', done);
      resolve();
    };
    el.addEventListener('seeked', done);
    el.currentTime = t;
  });
}

/** Source rectangle of the video for a crop. */
export function cropRect(v: { width: number; height: number }, c: Crop) {
  const va = v.width / v.height;
  if (va > c.aspect) {
    const sw = v.height * c.aspect;
    return { sx: (v.width - sw) * c.x, sy: 0, sw, sh: v.height };
  }
  const sh = v.width / c.aspect;
  return { sx: 0, sy: (v.height - sh) * c.y, sw: v.width, sh };
}

/** A hair past the frame start, so rounding never lands on the previous frame. */
const NUDGE = 0.001;

export function frameTime(v: LoadedVideo, start: number, fps: number, i: number) {
  return Math.min(start + i / fps + NUDGE, v.duration - NUDGE);
}

/**
 * Grabs frames in order: frame i is taken at start + i / fps, cropped and
 * scaled to `width` px (never above the video's own size). Each grabber has
 * its own video element, so several can run side by side.
 */
export async function frameGrabber(v: LoadedVideo, start: number, fps: number, crop: Crop, width: number) {
  const el = await videoElement(v.url);
  const c = cropRect(v, crop);
  const w = Math.max(2, Math.round(Math.min(width, c.sw)));
  const h = Math.max(2, Math.round(w / crop.aspect));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const draw = async (i: number) => {
    await seek(el, frameTime(v, start, fps, i));
    ctx.drawImage(el, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
  };

  return {
    async jpeg(i: number, quality = 0.9): Promise<FrameImage> {
      await draw(i);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode a frame.'))), 'image/jpeg', quality),
      );
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'jpg' };
    },
    async dataUrl(i: number): Promise<string> {
      await draw(i);
      return canvas.toDataURL('image/jpeg', 0.8);
    },
    async bitmap(i: number): Promise<ImageBitmap> {
      await draw(i);
      return createImageBitmap(canvas);
    },
  };
}

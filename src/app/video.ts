// Reading frames out of a video file in the browser (no upload, no ffmpeg).

import type { FrameImage } from '../core/pdf.ts';

export interface LoadedVideo {
  file: File;
  el: HTMLVideoElement;
  url: string;
  duration: number;
  width: number;
  height: number;
}

export async function loadVideo(file: File): Promise<LoadedVideo> {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.src = url;
  await new Promise<void>((resolve, reject) => {
    el.onloadeddata = () => resolve();
    el.onerror = () => reject(new Error('This video format is not supported by your browser.'));
  });
  if (!el.videoWidth || !Number.isFinite(el.duration)) throw new Error('Could not read this video.');
  return { file, el, url, duration: el.duration, width: el.videoWidth, height: el.videoHeight };
}

function seek(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener('seeked', done);
      resolve();
    };
    el.addEventListener('seeked', done);
    el.currentTime = t;
  });
}

/**
 * Returns a frame grabber for the PDF writer.
 * Frame i is taken at start + i / fps; sized for printing at ~300 dpi.
 */
export function frameGrabber(video: LoadedVideo, start: number, fps: number, printWidthMm: number) {
  const maxW = Math.round((printWidthMm / 25.4) * 300);
  const w = Math.min(video.width, maxW);
  const h = Math.round((w * video.height) / video.width);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // a hair past the frame start, so rounding never lands on the previous frame
  const nudge = 0.001;

  return async (i: number): Promise<FrameImage> => {
    const t = Math.min(start + i / fps + nudge, video.duration - nudge);
    await seek(video.el, t);
    ctx.drawImage(video.el, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('frame encode failed'))), 'image/jpeg', 0.9),
    );
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'jpg' };
  };
}

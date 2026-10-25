// The edit: video clips back to back on one track. Cutting, trimming,
// moving and deleting only change this list; the video files stay as they
// are. The printed frames are sampled from it at the print frame rate.

import type { FrameImage } from '../core/pdf.ts';
import { cropRect, seek, videoElement, type LoadedVideo } from './video.ts';

export interface Clip {
  id: number;
  video: LoadedVideo;
  /** used part of the video, s */
  from: number;
  to: number;
  /** where the crop sits in this clip (0 = left/top, 1 = right/bottom) */
  cropX: number;
  cropY: number;
}

let nextId = 1;

export function newClip(video: LoadedVideo): Clip {
  return { id: nextId++, video, from: 0, to: video.duration, cropX: 0.5, cropY: 0.5 };
}

export const clipLength = (c: Clip) => c.to - c.from;

export function duration(clips: Clip[]): number {
  return clips.reduce((s, c) => s + clipLength(c), 0);
}

/** Where each clip starts on the timeline, s. */
export function starts(clips: Clip[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const c of clips) {
    out.push(t);
    t += clipLength(c);
  }
  return out;
}

/** The clip at timeline time t (the last one at the very end). */
export function clipAt(clips: Clip[], t: number): { clip: Clip; index: number; start: number } | null {
  let s = 0;
  for (let i = 0; i < clips.length; i++) {
    const len = clipLength(clips[i]);
    if (t < s + len || i === clips.length - 1) return { clip: clips[i], index: i, start: s };
    s += len;
  }
  return null;
}

export function frameCount(clips: Clip[], fps: number): number {
  return clips.length ? Math.max(1, Math.floor(duration(clips) * fps + 1e-6)) : 0;
}

/** A hair past the frame start, so rounding never lands on the previous frame. */
const NUDGE = 0.001;

/** Printed frame i: which clip, and when in its video. */
export function frameAt(clips: Clip[], fps: number, i: number): { clip: Clip; source: number } {
  const t = i / fps;
  const hit = clipAt(clips, t)!;
  const { clip } = hit;
  const source = Math.min(clip.from + (t - hit.start) + NUDGE, clip.to - NUDGE, clip.video.duration - NUDGE);
  return { clip, source: Math.max(clip.from, source) };
}

// --- edits: each returns a new list, null if nothing changes ---

/** Cuts the clip under t in two; both parts keep at least minLength. */
export function split(clips: Clip[], t: number, minLength: number): Clip[] | null {
  const hit = clipAt(clips, t);
  if (!hit) return null;
  const { clip, index, start } = hit;
  const at = clip.from + (t - start);
  if (at - clip.from < minLength || clip.to - at < minLength) return null;
  const left = { ...clip, to: at };
  const right = { ...clip, id: nextId++, from: at };
  return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)];
}

export function remove(clips: Clip[], id: number): Clip[] {
  return clips.filter((c) => c.id !== id);
}

/** Moves a clip so it ends up at position `to` in the list. */
export function move(clips: Clip[], id: number, to: number): Clip[] | null {
  const from = clips.findIndex((c) => c.id === id);
  if (from < 0) return null;
  const rest = clips.filter((c) => c.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  if (at === from) return null;
  return [...rest.slice(0, at), clips[from], ...rest.slice(at)];
}

/** New in or out point for a clip, kept inside its video and at least minLength long. */
export function trim(clips: Clip[], id: number, side: 'from' | 'to', value: number, minLength: number): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c;
    if (side === 'from') return { ...c, from: Math.max(0, Math.min(value, c.to - minLength)) };
    return { ...c, to: Math.min(c.video.duration, Math.max(value, c.from + minLength)) };
  });
}

export function insert(clips: Clip[], at: number, added: Clip[]): Clip[] {
  const i = Math.max(0, Math.min(clips.length, at));
  return [...clips.slice(0, i), ...added, ...clips.slice(i)];
}

export function setCrop(clips: Clip[], id: number, x: number, y: number): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, cropX: x, cropY: y } : c));
}

/** Undo / redo over whole clip lists. */
export function history(initial: Clip[] = []) {
  const past: Clip[][] = [];
  const future: Clip[][] = [];
  let now = initial;
  return {
    get: () => now,
    /** a new step that undo can go back from */
    push(next: Clip[]) {
      past.push(now);
      if (past.length > 200) past.shift();
      future.length = 0;
      now = next;
    },
    /** change the current step in place (crop moves, a drag still going on) */
    replace(next: Clip[]) {
      now = next;
    },
    undo() {
      const p = past.pop();
      if (!p) return false;
      future.push(now);
      now = p;
      return true;
    },
    redo() {
      const f = future.pop();
      if (!f) return false;
      past.push(now);
      now = f;
      return true;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    reset(next: Clip[]) {
      past.length = 0;
      future.length = 0;
      now = next;
    },
  };
}

/**
 * Grabs the printed frames of an edit in order, cropped and scaled to
 * `width` px. One video element per file, so going from clip to clip of the
 * same video doesn't reload it.
 */
export async function sequenceGrabber(clips: Clip[], fps: number, aspect: number, width: number) {
  const els = new Map<string, HTMLVideoElement>();
  const widest = Math.max(...clips.map((c) => cropRect(c.video, { aspect, x: 0.5, y: 0.5 }).sw));
  const w = Math.max(2, Math.round(Math.min(width, widest)));
  const h = Math.max(2, Math.round(w / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const draw = async (i: number) => {
    const { clip, source } = frameAt(clips, fps, i);
    let el = els.get(clip.video.url);
    if (!el) {
      el = await videoElement(clip.video.url);
      els.set(clip.video.url, el);
    }
    await seek(el, source);
    const c = cropRect(clip.video, { aspect, x: clip.cropX, y: clip.cropY });
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
  };
}

/** Small frames along a video for the timeline film strip, filled in as they come. */
export interface Thumbs {
  /** times of the frames, s */
  times: number[];
  images: (ImageBitmap | undefined)[];
}

const thumbCache = new WeakMap<LoadedVideo, Thumbs>();

export function thumbsOf(video: LoadedVideo, onProgress: () => void): Thumbs {
  let t = thumbCache.get(video);
  if (t) return t;
  const n = Math.max(6, Math.min(160, Math.round(video.duration * 4)));
  t = { times: [...Array(n).keys()].map((k) => ((k + 0.5) / n) * video.duration), images: [] };
  thumbCache.set(video, t);
  const thumbs = t;
  void (async () => {
    const el = await videoElement(video.url);
    const h = 96;
    const w = Math.round((h * video.width) / video.height);
    // coarse first, then fill the gaps, so the strip looks complete early
    const order: number[] = [];
    for (let step = 16; step >= 1; step /= 2) for (let k = 0; k < n; k += step) if (!order.includes(k)) order.push(k);
    let last = performance.now();
    for (const k of order) {
      await seek(el, thumbs.times[k]);
      thumbs.images[k] = await createImageBitmap(el, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
      if (performance.now() - last > 120) {
        last = performance.now();
        onProgress();
      }
    }
    onProgress();
  })();
  return thumbs;
}

/** The thumb closest to a time that is already there. */
export function thumbAt(t: Thumbs, time: number): ImageBitmap | undefined {
  const n = t.times.length;
  const k = Math.max(0, Math.min(n - 1, Math.round((time / t.times[n - 1]) * (n - 0.5) - 0.5)));
  for (let d = 0; d < n; d++) {
    const a = t.images[k - d];
    if (a) return a;
    const b = t.images[k + d];
    if (b) return b;
  }
  return undefined;
}

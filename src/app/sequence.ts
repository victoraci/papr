// The edit: video clips back to back on one track, and sound clips that
// were separated from them, each at its own place on the timeline. Cutting,
// trimming, moving and deleting only change these lists; the video files
// stay as they are. The printed frames are sampled from the clips at the
// print frame rate.

import { ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, Input, type InputVideoTrack, type WrappedCanvas } from 'mediabunny';
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
  /** its own sound is off (separated, or not wanted) */
  muted: boolean;
}

/** Sound of a video, on its own: placed anywhere on the timeline. */
export interface Sound {
  id: number;
  video: LoadedVideo;
  /** used part of the video's sound, s */
  from: number;
  to: number;
  /** where it starts on the timeline, s */
  at: number;
}

export interface Edit {
  clips: Clip[];
  sounds: Sound[];
}

export const emptyEdit = (): Edit => ({ clips: [], sounds: [] });

let nextId = 1;

export function newClip(video: LoadedVideo): Clip {
  return { id: nextId++, video, from: 0, to: video.duration, cropX: 0.5, cropY: 0.5, muted: false };
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

// --- sound ---

export const soundLength = (s: Sound) => s.to - s.from;

/** Takes the sound out of a clip: the clip goes quiet, the sound becomes a clip of its own right below. */
export function separate(edit: Edit, id: number): Edit | null {
  const i = edit.clips.findIndex((c) => c.id === id);
  const clip = edit.clips[i];
  if (!clip || clip.muted) return null;
  const sound: Sound = { id: nextId++, video: clip.video, from: clip.from, to: clip.to, at: starts(edit.clips)[i] };
  return {
    clips: edit.clips.map((c) => (c.id === id ? { ...c, muted: true } : c)),
    sounds: [...edit.sounds, sound],
  };
}

/** Cuts a sound in two at timeline time t; both parts keep at least minLength. */
export function splitSound(sounds: Sound[], id: number, t: number, minLength: number): Sound[] | null {
  const s = sounds.find((k) => k.id === id);
  if (!s) return null;
  const cut = s.from + (t - s.at);
  if (cut - s.from < minLength || s.to - cut < minLength) return null;
  const right: Sound = { ...s, id: nextId++, from: cut, at: t };
  return sounds.flatMap((k) => (k.id === id ? [{ ...k, to: cut }, right] : [k]));
}

/** Everything that sounds, as pieces on the timeline: the clips' own sound and the separated sounds. */
export function soundPieces(edit: Edit): { video: LoadedVideo; from: number; to: number; at: number }[] {
  const at = starts(edit.clips);
  return [
    ...edit.clips.flatMap((c, i) => (c.muted ? [] : [{ video: c.video, from: c.from, to: c.to, at: at[i] }])),
    ...edit.sounds.map((s) => ({ video: s.video, from: s.from, to: s.to, at: s.at })),
  ];
}

/** Undo / redo over whole edits. */
export function history(initial: Edit = emptyEdit()) {
  const past: Edit[] = [];
  const future: Edit[] = [];
  let now = initial;
  return {
    get: () => now,
    /** a new step that undo can go back from */
    push(next: Edit) {
      past.push(now);
      if (past.length > 200) past.shift();
      future.length = 0;
      now = next;
    },
    /** change the current step in place (crop moves, a drag still going on) */
    replace(next: Edit) {
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
    reset(next: Edit) {
      past.length = 0;
      future.length = 0;
      now = next;
    },
  };
}

/**
 * Grabs the printed frames of an edit, cropped and scaled to `width` px.
 * `order` lists the frames that will be asked for, in that order: those are
 * decoded straight through, clip by clip, which is many times faster than
 * seeking for each one (a seek can mean decoding seconds of video for videos
 * with few key frames). Frames asked for out of that order, and videos the
 * decoder can't take, are seeked for with one video element per file.
 */
export async function sequenceGrabber(clips: Clip[], fps: number, aspect: number, width: number, order: number[] = []) {
  const els = new Map<string, HTMLVideoElement>();
  const widest = Math.max(...clips.map((c) => cropRect(c.video, { aspect, x: 0.5, y: 0.5 }).sw));
  const w = Math.max(2, Math.round(Math.min(width, widest)));
  const h = Math.max(2, Math.round(w / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const straight = straightThrough(clips, fps, aspect, w, h, order);

  const draw = async (i: number) => {
    const decoded = await straight.take(i);
    if (decoded) return void ctx.drawImage(decoded, 0, 0, w, h);
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

/** Frames in a planned order, decoded clip by clip; null for a frame that has to be seeked for. */
function straightThrough(clips: Clip[], fps: number, aspect: number, w: number, h: number, order: number[]) {
  const plan = order.map((i) => ({ i, ...frameAt(clips, fps, i) }));
  let at = 0; // next in the plan
  let run: { end: number; it: AsyncGenerator<WrappedCanvas | null> | null } | null = null;
  const tracks = new Map<LoadedVideo, Promise<InputVideoTrack | null>>();
  const trackOf = (video: LoadedVideo) => {
    let t = tracks.get(video);
    if (!t) {
      t = (async () => {
        const input = new Input({ source: new BlobSource(video.file), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        return track && (await track.canDecode()) ? track : null;
      })().catch(() => null);
      tracks.set(video, t);
    }
    return t;
  };

  return {
    async take(i: number): Promise<CanvasImageSource | null> {
      if (plan[at]?.i !== i) return null;
      if (!run || at >= run.end) {
        // the next stretch of frames from one clip
        void run?.it?.return(undefined);
        const { clip } = plan[at];
        let end = at;
        while (end < plan.length && plan[end].clip === clip) end++;
        const track = await trackOf(clip.video);
        const c = cropRect(clip.video, { aspect, x: clip.cropX, y: clip.cropY });
        const crop = { left: Math.round(c.sx), top: Math.round(c.sy), width: Math.round(c.sw), height: Math.round(c.sh) };
        const sink = track && new CanvasSink(track, { width: w, height: h, fit: 'fill', crop });
        run = { end, it: sink ? sink.canvasesAtTimestamps(plan.slice(at, end).map((p) => p.source)) : null };
      }
      at++;
      if (!run.it) return null;
      try {
        return (await run.it.next()).value?.canvas ?? null;
      } catch {
        run.it = null; // the decoder gave up: seek for the rest of this clip
        return null;
      }
    },
  };
}

/** Small frames along a video for the timeline film strip, filled in as they come. */
export interface Thumbs {
  /** times of the frames, s, in order */
  times: number[];
  images: (ImageBitmap | undefined)[];
}

const thumbCache = new WeakMap<LoadedVideo, Thumbs>();
const THUMB_H = 96;
const MAX_THUMBS = 200;

/** Coarse first, then the gaps, so a strip looks complete early. */
function coarseToFine(n: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let step = 16; step >= 1; step /= 2)
    for (let k = 0; k < n; k += step)
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
  return order;
}

export function thumbsOf(video: LoadedVideo, onProgress: () => void): Thumbs {
  let t = thumbCache.get(video);
  if (t) return t;
  t = { times: [], images: [] };
  thumbCache.set(video, t);
  const thumbs = t;
  void (async () => {
    const quick = await keyframeThumbs(video, thumbs, onProgress).catch(() => false);
    if (!quick) await seekThumbs(video, thumbs, onProgress);
    onProgress();
  })();
  return thumbs;
}

/**
 * Thumbs from the key frames only. Each of those decodes on its own, so this
 * is quick even for long, heavy videos and leaves the decoder free for playing.
 */
async function keyframeThumbs(video: LoadedVideo, thumbs: Thumbs, onProgress: () => void): Promise<boolean> {
  const input = new Input({ source: new BlobSource(video.file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return false;
  const packets = new EncodedPacketSink(track);
  let keys: number[] = [];
  for (let p = await packets.getFirstPacket({ metadataOnly: true }); p; p = await packets.getNextKeyPacket(p, { metadataOnly: true }))
    keys.push(p.timestamp);
  if (!keys.length) return false;
  if (keys.length > MAX_THUMBS) keys = [...Array(MAX_THUMBS).keys()].map((i) => keys[Math.floor((i * keys.length) / MAX_THUMBS)]);
  const w = Math.round((THUMB_H * video.width) / video.height);
  const sink = new CanvasSink(track, { width: w, height: THUMB_H, fit: 'fill' });
  thumbs.times = keys;
  let last = performance.now();
  for (const k of coarseToFine(keys.length)) {
    const frame = await sink.getCanvas(keys[k]);
    if (frame) thumbs.images[k] = await createImageBitmap(frame.canvas);
    if (performance.now() - last > 120) {
      last = performance.now();
      onProgress();
    }
  }
  return true;
}

/** Thumbs by seeking a video element, for videos the decoder can't take on its own. */
async function seekThumbs(video: LoadedVideo, thumbs: Thumbs, onProgress: () => void) {
  const n = Math.max(6, Math.min(160, Math.round(video.duration * 4)));
  thumbs.times = [...Array(n).keys()].map((k) => ((k + 0.5) / n) * video.duration);
  thumbs.images = [];
  const el = await videoElement(video.url);
  const w = Math.round((THUMB_H * video.width) / video.height);
  let last = performance.now();
  for (const k of coarseToFine(n)) {
    await seek(el, thumbs.times[k]);
    thumbs.images[k] = await createImageBitmap(el, { resizeWidth: w, resizeHeight: THUMB_H, resizeQuality: 'medium' });
    if (performance.now() - last > 120) {
      last = performance.now();
      onProgress();
    }
  }
}

/** The thumb closest to a time that is already there. */
export function thumbAt(t: Thumbs, time: number): ImageBitmap | undefined {
  const { times, images } = t;
  const n = times.length;
  if (!n) return undefined;
  // last thumb at or before the time
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  // the nearest one that's there, looking both ways
  let a = lo;
  let b = lo + 1;
  while (a >= 0 || b < n) {
    const da = a >= 0 ? time - times[a] : Infinity;
    const db = b < n ? times[b] - time : Infinity;
    if (da <= db) {
      if (images[a]) return images[a];
      a--;
    } else {
      if (images[b]) return images[b];
      b++;
    }
  }
  return undefined;
}

// Frames → MP4 (WebCodecs via mediabunny), GIF (gifenc) or PNG frames in a ZIP.
// Everything runs in the browser.

import { zipSync } from 'fflate';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from 'mediabunny';
import type { SoundPiece } from './session.ts';

/** Draws output frame i into the canvas at w × h. */
export type DrawFrame = (ctx: OffscreenCanvasRenderingContext2D, i: number, w: number, h: number) => void;

export interface ExportJob {
  /** number of output frames */
  frames: number;
  fps: number;
  w: number;
  h: number;
  draw: DrawFrame;
  /** sound for the whole output, MP4 only */
  audio?: AudioBuffer;
  onProgress?: (done: number, total: number) => void;
}

const breathe = () => new Promise((r) => setTimeout(r, 0));

export async function exportMp4(job: ExportJob): Promise<Blob> {
  const { w, h, fps } = job;
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: w, height: h });
  if (!codec) throw new Error('This browser can’t encode video. Try a current Chrome, Edge or Safari, or export a GIF.');

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: fps });

  let audio: AudioBufferSource | null = null;
  if (job.audio) {
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: job.audio.numberOfChannels,
      sampleRate: job.audio.sampleRate,
    });
    if (!audioCodec) throw new Error('This browser can’t encode sound. Export without sound or try Chrome.');
    audio = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
    output.addAudioTrack(audio);
  }
  await output.start();
  if (audio && job.audio) await audio.add(job.audio);

  for (let i = 0; i < job.frames; i++) {
    job.draw(ctx, i, w, h);
    await video.add(i / fps, 1 / fps);
    job.onProgress?.(i + 1, job.frames);
  }
  await output.finalize();
  return new Blob([output.target.buffer!], { type: 'video/mp4' });
}

export async function exportGif(job: ExportJob): Promise<Blob> {
  const { w, h } = job;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  // GIF delays are stored in 1/100 s
  const delay = Math.max(20, Math.round(100 / job.fps) * 10);

  for (let i = 0; i < job.frames; i++) {
    job.draw(ctx, i, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay, repeat: 0 });
    job.onProgress?.(i + 1, job.frames);
    if (i % 8 === 7) await breathe(); // keep the page responsive
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
}

/** Every frame as a PNG, numbered, in one ZIP (PNGs are compressed already, so the ZIP just stores them). */
export async function exportPngZip(job: ExportJob, name: string): Promise<Blob> {
  const { w, h } = job;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  const digits = Math.max(4, String(job.frames).length);
  for (let i = 0; i < job.frames; i++) {
    job.draw(ctx, i, w, h);
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    files[`${name}/${name}_${String(i + 1).padStart(digits, '0')}.png`] = [png, { level: 0 }];
    job.onProgress?.(i + 1, job.frames);
  }
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}

/** Fade at a jump in the sound, so it doesn't click. */
const JUMP_FADE = 0.004;

/**
 * The original sound of the printed edit: every piece at its place on the
 * timeline, overlaps mixed. Then only the sound under `frames` (printed frame
 * numbers at `fps`, in output order) is kept, and that is repeated `times`.
 * Videos without readable sound stay silent for their part.
 */
export async function cutSound(pieces: SoundPiece[], fps: number, frames: number[], times: number): Promise<AudioBuffer> {
  const rate = 48000;
  // decoding resamples to the context's rate, so pieces of different videos fit together
  const ctx = new OfflineAudioContext(2, 1, rate);
  const decoded = new Map<File, AudioBuffer | null>();
  for (const p of pieces)
    if (!decoded.has(p.file)) decoded.set(p.file, await ctx.decodeAudioData(await p.file.arrayBuffer()).catch(() => null));
  if (![...decoded.values()].some(Boolean)) throw new Error('These videos have no sound this browser can read.');

  const edge = (i: number) => Math.round((i * rate) / fps);
  const len = Math.max(1, edge(Math.max(...frames) + 1));
  const whole = [new Float32Array(len), new Float32Array(len)];
  // pieces that overlap on the timeline are mixed
  for (const p of pieces) {
    const full = decoded.get(p.file);
    const at = Math.round(p.at * rate);
    if (!full || at >= len) continue;
    const from = Math.min(full.length, Math.round(p.start * rate));
    const n = Math.min(len - at, full.length - from, Number.isFinite(p.length) ? Math.round(p.length * rate) : len);
    for (let c = 0; c < 2; c++) {
      const src = full.getChannelData(Math.min(c, full.numberOfChannels - 1));
      const dst = whole[c];
      for (let i = 0; i < n; i++) dst[at + i] += src[from + i];
    }
  }

  // the sound of each kept frame, one after the other
  const size = frames.reduce((n, i) => n + edge(i + 1) - edge(i), 0);
  const once = [new Float32Array(size), new Float32Array(size)];
  const fade = Math.round(JUMP_FADE * rate);
  let to = 0;
  frames.forEach((i, k) => {
    const from = edge(i);
    const n = edge(i + 1) - from;
    const jumpIn = k > 0 && frames[k - 1] !== i - 1;
    const jumpOut = k < frames.length - 1 && frames[k + 1] !== i + 1;
    for (let c = 0; c < 2; c++) {
      const dst = once[c];
      dst.set(whole[c].subarray(from, from + n), to);
      for (let j = 0; j < Math.min(fade, n); j++) {
        if (jumpIn) dst[to + j] *= j / fade;
        if (jumpOut) dst[to + n - 1 - j] *= j / fade;
      }
    }
    to += n;
  });

  const out = new AudioBuffer({ length: Math.max(1, size * times), numberOfChannels: 2, sampleRate: rate });
  for (let c = 0; c < 2; c++) for (let t = 0; t < times; t++) out.getChannelData(c).set(once[c], t * size);
  return out;
}

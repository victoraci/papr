// Frames → MP4 (WebCodecs via mediabunny) or GIF (gifenc), all in the browser.

import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';

/** Draws frame i into the canvas at w × h. */
export type DrawFrame = (ctx: OffscreenCanvasRenderingContext2D, i: number, w: number, h: number) => void;

export interface ExportJob {
  frames: number;
  fps: number;
  w: number;
  h: number;
  draw: DrawFrame;
  onProgress?: (done: number, total: number) => void;
}

export async function exportMp4(job: ExportJob): Promise<Blob> {
  const { w, h, fps } = job;
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: w, height: h });
  if (!codec) throw new Error('This browser can’t encode video. Try a current Chrome, Edge or Safari, or export a GIF.');

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  for (let i = 0; i < job.frames; i++) {
    job.draw(ctx, i, w, h);
    await source.add(i / fps, 1 / fps);
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
    // keep the page responsive on long animations
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
}

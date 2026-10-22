// Frames → MP4, encoded in the browser (WebCodecs via mediabunny).

import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';

/**
 * @param frames ordered; a missing frame (undefined) repeats the previous one
 */
export async function exportMp4(
  frames: (ImageBitmap | undefined)[],
  fps: number,
  w: number,
  h: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: w, height: h });
  if (!codec) throw new Error('This browser can’t encode video. Try a current Chrome, Edge or Safari.');

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f) ctx.drawImage(f, 0, 0, w, h);
    await source.add(i / fps, 1 / fps);
    onProgress?.(i + 1, frames.length);
  }
  await output.finalize();
  return new Blob([output.target.buffer!], { type: 'video/mp4' });
}

// The sound of a video, read once: for playing it in the editor and for the
// waveforms on the timeline.

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import type { LoadedVideo } from './video.ts';

export interface VideoSound {
  buffer: AudioBuffer;
  /** loudest sample per slice, 0..1 */
  peaks: Float32Array;
  /** slices per second */
  peakRate: number;
}

const PEAK_RATE = 50;
const reading = new WeakMap<LoadedVideo, Promise<VideoSound | null>>();
const ready = new WeakMap<LoadedVideo, VideoSound | null>();
const listeners = new Set<() => void>();

/** Called whenever the sound of another video is ready. */
export function onSound(f: () => void) {
  listeners.add(f);
}

/** The sound once it's read; undefined while it's being read, null for a video without sound. */
export function soundOf(video: LoadedVideo): VideoSound | null | undefined {
  if (ready.has(video)) return ready.get(video);
  if (!reading.has(video))
    reading.set(
      video,
      read(video)
        .catch(() => null)
        .then((s) => {
          ready.set(video, s);
          for (const f of listeners) f();
          return s;
        }),
    );
  return undefined;
}

async function read(video: LoadedVideo): Promise<VideoSound | null> {
  const input = new Input({ source: new BlobSource(video.file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) return null;
  const buffer = (await track.canDecode()) ? await decodeTrack(track, video.duration) : await decodeWhole(video.file);
  return buffer && { buffer, ...peaksOf(buffer) };
}

/** Decodes only the sound track, piece by piece, into one buffer (two channels at most). */
async function decodeTrack(track: InputAudioTrack, fallback: number) {
  const seconds = (await track.computeDuration().catch(() => 0)) || fallback;
  let out: AudioBuffer | null = null;
  for await (const { buffer: b, timestamp } of new AudioBufferSink(track).buffers()) {
    out ??= new AudioBuffer({
      length: Math.max(1, Math.ceil(seconds * b.sampleRate)),
      numberOfChannels: Math.min(2, b.numberOfChannels),
      sampleRate: b.sampleRate,
    });
    const at = Math.round(timestamp * out.sampleRate);
    for (let c = 0; c < out.numberOfChannels; c++) {
      let data = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      let to = at;
      if (to < 0) {
        data = data.subarray(-to);
        to = 0;
      }
      if (to >= out.length) continue;
      if (to + data.length > out.length) data = data.subarray(0, out.length - to);
      out.copyToChannel(data, c, to);
    }
  }
  return out;
}

/** For sound the decoder above can't take: let the browser read the whole file. */
async function decodeWhole(file: File) {
  const ctx = new OfflineAudioContext(2, 1, 48000);
  return ctx.decodeAudioData(await file.arrayBuffer()).catch(() => null);
}

function peaksOf(buffer: AudioBuffer) {
  const step = Math.max(1, Math.round(buffer.sampleRate / PEAK_RATE));
  const n = Math.ceil(buffer.length / step);
  const peaks = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = peaks[i];
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > m) m = v;
      }
      peaks[i] = m;
    }
  }
  return { peaks, peakRate: buffer.sampleRate / step };
}

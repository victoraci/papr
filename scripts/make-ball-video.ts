// Writes the lab's bouncing-ball animation as a video, for real print tests:
// node scripts/make-ball-video.ts <frame dir> <out.mp4>
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { encode } from 'fast-png';
import { makeFrame } from '../test/synth.ts';

const [dir, out] = process.argv.slice(2);
const N = 36; // 3 s at 12 fps
for (let i = 0; i < N; i++) {
  const f = makeFrame(i, N, 1280, 720);
  writeFileSync(`${dir}/f-${String(i).padStart(3, '0')}.png`, encode({ width: f.width, height: f.height, data: f.data as Uint8ClampedArray, channels: 4, depth: 8 }));
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12', '-i', `${dir}/f-%03d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', out]);
console.log('wrote', out);

// One sheet as PDF + PNG, to look at the layout without the app.
//   node scripts/sheet-png.ts <out-prefix>      env: VERSION PAPER ORIENT FW GAP DPI


import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { encode } from 'fast-png';
import { makeSpec, gapForBorder, type PaperId } from '../src/core/layout.ts';
import { buildSheetsPdf } from '../src/core/pdf.ts';
import { makeFrame } from '../test/synth.ts';
const V = Number(process.env.VERSION ?? 3);
const spec = makeSpec((process.env.PAPER ?? 'A4') as PaperId, (process.env.ORIENT ?? 'L') === 'L', 16 / 9, Number(process.env.FW ?? 76), Number(process.env.GAP ?? gapForBorder(0, V)), V);
console.log(spec);
const out = process.argv[2];
const pdf = await buildSheetsPdf({
  spec, style: { borders: false, frameNumbers: true, fileName: true }, projectId: 'LAB001', fps: 12, frameCount: 30, title: 'bouncing-ball.mp4',
  getFrame: async (i) => { const f = makeFrame(i, 30); return { bytes: encode({ width: f.width, height: f.height, data: f.data as Uint8ClampedArray, channels: 4, depth: 8 }), type: 'png' }; },
});
writeFileSync(`${out}.pdf`, pdf);
execFileSync('pdftoppm', ['-r', process.env.DPI ?? '100', '-png', '-f', '1', '-l', '1', '-singlefile', `${out}.pdf`, out]);

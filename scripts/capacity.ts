// How many frames fit on a sheet, layout v2 against the current one.
//   node scripts/capacity.ts            A4, 16:9, no white border
//   PAPER=A3 ASPECT=1 node scripts/capacity.ts

import { gapForBorder, gridChoices, type PaperId } from '../src/core/layout.ts';

const paper = (process.env.PAPER ?? 'A4') as PaperId;
const aspect = Number(process.env.ASPECT ?? 16 / 9);
const widths = [50, 60, 70, 80, 90, 100, 110, 120, 130, 140];

/** Most frames of at least `w` mm width, either orientation. */
function most(version: number, w: number): string {
  let best = { count: 0, label: '–' };
  for (const landscape of [false, true]) {
    const choices = gridChoices(paper, landscape, aspect, gapForBorder(0, version), 20, version);
    for (const c of choices)
      if (c.frameW >= w && c.count > best.count) best = { count: c.count, label: `${c.count} (${c.cols}×${c.rows} ${landscape ? 'landscape' : 'portrait'}, ${c.frameW} mm)` };
  }
  return best.label;
}

console.log(`${paper}, aspect ${aspect.toFixed(2)}: frames per sheet for frames at least this wide`);
console.log('width   v2 (gap 8 mm)                        v3 (gap 5 mm)');
for (const w of widths) console.log(`${String(w).padEnd(8)}${most(2, w).padEnd(37)}${most(3, w)}`);

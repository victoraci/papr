// Scan panel: scans / photos → animation → MP4.

import { exportMp4 } from './export.ts';
import { missingPages, processScan, type Project, type ScanEntry } from './scans.ts';
import { dropZone, el, mb } from './ui.ts';

export function scanPanel() {
  const scans: ScanEntry[] = [];
  const projects = new Map<string, Project>();
  let queue = Promise.resolve();

  const drop = dropZone('Drop scans or photos here or click to choose them', 'image/*', true, (f) => add(f));
  const list = el('div', { class: 'scans' });
  const info = el('p', { class: 'muted' });
  const exportBtn = el('button', { class: 'primary wide', textContent: 'Export MP4', disabled: true });
  const mp4Link = el('a', { class: 'button wide', hidden: true });
  const exportNote = el('p', { class: 'muted' });

  const player = el('canvas', { title: 'Click to pause', hidden: true });
  const empty = el('p', { class: 'muted', textContent: 'The animation plays here once sheets are added.' });

  function add(files: File[]) {
    for (const file of files) {
      const entry: ScanEntry = { file, status: 'waiting' };
      scans.push(entry);
      queue = queue.then(async () => {
        render();
        await new Promise((r) => setTimeout(r, 30)); // let the list paint before the heavy work
        await processScan(entry, projects);
        render();
      });
    }
    render();
  }

  function current(): Project | null {
    let best: Project | null = null;
    for (const p of projects.values()) if (!best || p.frames.size > best.frames.size) best = p;
    return best;
  }

  function render() {
    list.replaceChildren(
      ...scans.map((s) => {
        const r = s.result;
        let text = '';
        let cls = 'muted';
        if (s.status === 'waiting') text = 'Waiting';
        else if (s.status === 'working') text = 'Reading…';
        else if (s.status === 'failed') {
          text = s.error ?? 'Not recognised';
          cls = 'warn';
        } else if (r?.payload) text = `Sheet ${r.payload.page} of ${r.payload.pages}`;
        return el('div', {}, el('span', { textContent: s.file.name }), el('span', { className: cls, textContent: text }));
      }),
    );
    const p = current();
    if (!p) return;
    const miss = missingPages(p);
    info.textContent =
      (p.frames.size === p.payload.frameCount ? `All ${p.payload.frameCount} frames` : `${p.frames.size} of ${p.payload.frameCount} frames`) +
      ` · ${p.payload.fps} frames per second` +
      (miss.length ? ` · ${miss.length === 1 ? 'sheet' : 'sheets'} ${miss.join(', ')} missing` : '') +
      (projects.size > 1 ? ' · sheets from another project are left out' : '');
    player.hidden = false;
    empty.hidden = true;
    exportBtn.disabled = false;
    if (player.width !== p.frameW) {
      player.width = p.frameW;
      player.height = p.frameH;
    }
  }

  // player loop
  let playing = true;
  let t0 = performance.now();
  let shown = -1;
  player.onclick = () => {
    playing = !playing;
    t0 = performance.now();
  };
  const ordered = (p: Project) => {
    const out: (ImageBitmap | undefined)[] = [];
    let last: ImageBitmap | undefined;
    for (let i = 0; i < p.payload.frameCount; i++) {
      last = p.frames.get(i) ?? last;
      out.push(last);
    }
    return out;
  };
  const tick = (now: number) => {
    const p = current();
    if (p && playing) {
      const i = Math.floor(((now - t0) / 1000) * p.payload.fps) % p.payload.frameCount;
      if (i !== shown) {
        shown = i;
        const ctx = player.getContext('2d')!;
        const f = ordered(p)[i];
        if (f) ctx.drawImage(f, 0, 0, player.width, player.height);
        else {
          ctx.fillStyle = '#1b1b1b';
          ctx.fillRect(0, 0, player.width, player.height);
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  exportBtn.onclick = async () => {
    const p = current();
    if (!p) return;
    exportBtn.disabled = true;
    mp4Link.hidden = true;
    try {
      const blob = await exportMp4(ordered(p), p.payload.fps, p.frameW, p.frameH, (d, n) => {
        exportNote.textContent = `Encoding frame ${d} of ${n}`;
      });
      mp4Link.href = URL.createObjectURL(blob);
      mp4Link.download = `rotopaper-${p.id}.mp4`;
      mp4Link.textContent = `Download MP4 · ${mb(blob.size)}`;
      mp4Link.hidden = false;
      exportNote.textContent = missingPages(p).length ? 'Missing frames repeat the frame before them.' : '';
    } catch (e) {
      exportNote.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      exportBtn.disabled = false;
    }
  };

  const panel = el(
    'div',
    { class: 'panel' },
    el(
      'aside',
      { class: 'side' },
      el(
        'div',
        { class: 'side-scroll' },
        el('h2', { textContent: 'Add your sheets' }),
        el('div', { class: 'step-body' }, drop.el, el('p', { class: 'muted', textContent: 'Any order is fine.' }), list, info),
      ),
      el('div', { class: 'side-foot' }, exportBtn, mp4Link, exportNote),
    ),
    el('div', { class: 'stage' }, player, empty),
  );
  return { el: panel, add };
}

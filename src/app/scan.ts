// Scan panel: scans / photos / PDFs → animation → MP4 or GIF.

import { exportGif, exportMp4, type DrawFrame } from './export.ts';
import { frameSize, missingPages, processScan, toEntries, type Project, type ScanEntry } from './scans.ts';
import { dropZone, el, mb, segmented, slider, toggleRow } from './ui.ts';

const SIZES = { small: 640, medium: 960, large: 1280 } as const;
type Size = keyof typeof SIZES;

export function scanPanel() {
  const scans: ScanEntry[] = [];
  const projects = new Map<string, Project>();
  const opts = { format: 'mp4' as 'mp4' | 'gif', size: 'large' as Size, trim: 0, keepBorder: false };
  let queue = Promise.resolve();
  let lastUrl = '';

  const drop = dropZone('Drop scans, photos or PDFs here or click to choose them', 'image/*,application/pdf,.pdf', true, (f) => void add(f));
  const list = el('div', { class: 'scans' });
  const info = el('p', { class: 'muted' });

  const formatCtl = segmented(
    [
      { value: 'mp4', label: 'MP4' },
      { value: 'gif', label: 'GIF' },
    ],
    () => opts.format,
    (v) => {
      opts.format = v;
      // GIFs get big fast, so they start small
      opts.size = v === 'gif' ? 'small' : 'large';
      changed();
    },
  );
  const sizeCtl = segmented(
    [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ],
    () => opts.size,
    (v) => ((opts.size = v), changed()),
  );
  const sizeLabel = el('span', { class: 'muted' });
  const trimCtl = slider(
    'Trim edges',
    { min: () => 0, max: () => 6, step: 0.5 },
    () => opts.trim,
    (v) => ((opts.trim = v), changed()),
    () => (opts.trim ? `${opts.trim} %` : 'Off'),
  );
  formatCtl.el.classList.add('grid2');
  sizeCtl.el.classList.add('grid3');
  const borderCtl = toggleRow('Keep the white border', () => opts.keepBorder, (v) => ((opts.keepBorder = v), changed()));
  const exportOpts = el(
    'div',
    { class: 'stack', hidden: true },
    el('h2', { class: 'section-title', textContent: 'Export' }),
    formatCtl.el,
    sizeCtl.el,
    sizeLabel,
    borderCtl.el,
    trimCtl.el,
  );

  const exportBtn = el('button', { class: 'primary wide', textContent: 'Export MP4', disabled: true });
  const fileLink = el('a', { class: 'button wide', hidden: true });
  const exportNote = el('p', { class: 'muted' });

  const player = el('canvas', { title: 'Click to pause', hidden: true });
  const empty = el('p', { class: 'muted', textContent: 'The animation plays here once sheets are added.' });

  async function add(files: File[]) {
    const entries = await toEntries(files);
    for (const entry of entries) {
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

  /** Part of each stored image that goes into the video. */
  const source = (p: Project) => (opts.keepBorder && p.inner.x > 0 ? { x: 0, y: 0, w: p.full.w, h: p.full.h } : p.inner);
  const outSize = (p: Project) => {
    const s = source(p);
    return frameSize(s.w / s.h, SIZES[opts.size]);
  };

  function changed() {
    for (const c of [formatCtl, sizeCtl, trimCtl, borderCtl]) c.sync();
    exportBtn.textContent = opts.format === 'gif' ? 'Export GIF' : 'Export MP4';
    const p = current();
    if (p) {
      const s = outSize(p);
      sizeLabel.textContent = `${s.w} × ${s.h} pixels`;
      borderCtl.el.hidden = p.inner.x === 0;
      // the player shows exactly what gets exported
      const ps = frameSize(s.w / s.h, 1280);
      if (player.width !== ps.w || player.height !== ps.h) {
        player.width = ps.w;
        player.height = ps.h;
      }
    }
    fileLink.hidden = true;
    exportNote.textContent = '';
    shown = -1;
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
          text = s.error ?? 'No Rotopaper sheet found in this image.';
          cls = 'warn';
        } else if (r?.payload) text = `Sheet ${r.payload.page} of ${r.payload.pages}`;
        return el('div', { class: s.status === 'failed' ? 'failed' : '' }, el('span', { textContent: s.name }), el('span', { className: cls, textContent: text }));
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
    exportOpts.hidden = false;
    exportBtn.disabled = false;
    changed();
  }

  /** Frame list in order; a missing frame repeats the one before it. */
  const ordered = (p: Project) => {
    const out: (ImageBitmap | undefined)[] = [];
    let last: ImageBitmap | undefined;
    for (let i = 0; i < p.payload.frameCount; i++) {
      last = p.frames.get(i) ?? last;
      out.push(last);
    }
    return out;
  };

  const drawer = (p: Project, frames: (ImageBitmap | undefined)[]): DrawFrame => {
    const s = source(p);
    const t = opts.trim / 100;
    return (ctx, i, w, h) => {
      const f = frames[i];
      if (!f) {
        ctx.fillStyle = '#1b1b1b';
        ctx.fillRect(0, 0, w, h);
        return;
      }
      ctx.drawImage(f, s.x + s.w * t, s.y + s.h * t, s.w * (1 - 2 * t), s.h * (1 - 2 * t), 0, 0, w, h);
    };
  };

  // player loop
  let playing = true;
  let t0 = performance.now();
  let shown = -1;
  player.onclick = () => {
    playing = !playing;
    t0 = performance.now();
  };
  const tick = (now: number) => {
    const p = current();
    if (p && playing) {
      const i = Math.floor(((now - t0) / 1000) * p.payload.fps) % p.payload.frameCount;
      if (i !== shown) {
        shown = i;
        const ctx = player.getContext('2d')! as unknown as OffscreenCanvasRenderingContext2D;
        drawer(p, ordered(p))(ctx, i, player.width, player.height);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  exportBtn.onclick = async () => {
    const p = current();
    if (!p) return;
    exportBtn.disabled = true;
    fileLink.hidden = true;
    const s = outSize(p);
    const gif = opts.format === 'gif';
    try {
      const job = {
        frames: p.payload.frameCount,
        fps: p.payload.fps,
        w: s.w,
        h: s.h,
        draw: drawer(p, ordered(p)),
        onProgress: (d: number, n: number) => (exportNote.textContent = `Encoding frame ${d} of ${n}`),
      };
      const blob = gif ? await exportGif(job) : await exportMp4(job);
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      fileLink.href = lastUrl;
      fileLink.download = `rotopaper-${p.id}.${gif ? 'gif' : 'mp4'}`;
      fileLink.textContent = `Download ${gif ? 'GIF' : 'MP4'} · ${mb(blob.size)}`;
      fileLink.hidden = false;
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
        exportOpts,
      ),
      el('div', { class: 'side-foot' }, exportBtn, fileLink, exportNote),
    ),
    el('div', { class: 'stage' }, player, empty),
  );
  return { el: panel, add };
}

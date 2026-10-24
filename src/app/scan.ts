// Scan: finished sheets in, video out, on one screen. Drop the scans, the
// animation plays right away, one button downloads it. Everything else sits
// under "More settings".

import { cutSound, exportGif, exportMp4, exportPngZip, type DrawFrame } from './export.ts';
import { frameSize, missingPages, processScan, toEntries, type Project, type ScanEntry } from './scans.ts';
import { printed } from './session.ts';
import { dropTarget, el, field, filePicker, group, hint, mb, more, options, plural, saveFile, sidebar, slider, toggleRow, type Control } from './ui.ts';

const SIZES = { small: 640, medium: 960, large: 1280 } as const;
type Size = keyof typeof SIZES;
type Format = 'mp4' | 'gif' | 'png';
const FPS_CHOICES = [6, 8, 12, 15, 24];
const REPEATS = [1, 2, 3, 5];
const ACCEPT = 'image/*,application/pdf,.pdf';

export function scanPanel() {
  const scans: ScanEntry[] = [];
  const projects = new Map<string, Project>();
  const opts = {
    fps: 0, // 0 = as printed
    boomerang: false,
    repeat: 1,
    sound: true,
    soundFile: null as File | null,
    soundStart: 0,
    format: 'mp4' as Format,
    size: 'large' as Size,
    trim: 0,
    keepBorder: false,
  };
  let queue = Promise.resolve();
  let busy = false;
  /** The last export; downloading again without changes gives the same file. */
  let last: { key: string; url: string; name: string } | null = null;
  /** Settings the note under the button speaks about. */
  let noteKey = '';

  const current = (): Project | null => {
    let best: Project | null = null;
    for (const p of projects.values()) if (!best || p.frames.size > best.frames.size) best = p;
    return best;
  };
  const fps = (p: Project) => opts.fps || p.payload.fps;
  /** Order of frames in the output (before repeats). */
  const sequence = (p: Project) => {
    const base = [...Array(p.payload.frameCount).keys()];
    return opts.boomerang && base.length > 2 ? [...base, ...base.slice(1, -1).reverse()] : base;
  };
  const soundAllowed = (p: Project) => fps(p) === p.payload.fps && !opts.boomerang;
  const withSound = (p: Project) => opts.format === 'mp4' && opts.sound && !!opts.soundFile && soundAllowed(p);
  const exportKey = (p: Project) => JSON.stringify([p.id, p.frames.size, opts, opts.soundFile?.name, withSound(p)]);

  // --- before anything is in ---
  const picker = filePicker(ACCEPT, true, (f) => void add(f));
  const intake = el(
    'div',
    { class: 'intake' },
    el('h1', { textContent: 'Drop your sheets here' }),
    el('p', { class: 'hint', textContent: 'Scans, photos or PDFs, in any order.' }),
    el('button', { class: 'primary', textContent: 'Choose files', onclick: picker.open }),
  );

  async function add(files: File[]) {
    intake.hidden = true;
    work.hidden = false;
    const entries = await toEntries(files);
    for (const entry of entries) {
      scans.push(entry);
      queue = queue.then(async () => {
        render();
        await new Promise((r) => setTimeout(r, 30)); // let the list paint before the heavy work
        await processScan(entry, projects);
        onProject();
        render();
      });
    }
    render();
  }

  /** When a project shows up: use what this session knows about it. */
  function onProject() {
    const p = current();
    if (!p || opts.soundFile) return;
    const known = printed.get(p.id);
    if (known) {
      opts.soundFile = known.video.file;
      opts.soundStart = known.start;
    }
  }

  // --- view: player + frame strip ---
  const player = el('canvas', { class: 'player', title: 'Click to pause' });
  const strip = el('div', { class: 'frame-strip' });
  const waiting = el('p', { class: 'hint waiting' });
  const playerHolder = el('div', { class: 'picture-holder' }, player, waiting);
  const view = el('div', { class: 'view scan-view' }, playerHolder, strip);
  let thumbs: HTMLElement[] = [];

  function buildStrip(p: Project) {
    thumbs = [...Array(p.payload.frameCount).keys()].map((i) => {
      const f = p.frames.get(i);
      const t = el('button', { class: f ? 'thumb' : 'thumb missing', title: `Frame ${i + 1}`, onclick: () => showFrame(i) });
      if (f) {
        const c = el('canvas');
        c.height = 96;
        c.width = Math.round((96 * p.inner.w) / p.inner.h);
        c.getContext('2d')!.drawImage(f, p.inner.x, p.inner.y, p.inner.w, p.inner.h, 0, 0, c.width, c.height);
        t.append(c);
      } else t.style.aspectRatio = `${p.inner.w} / ${p.inner.h}`;
      return t;
    });
    strip.replaceChildren(...thumbs);
  }

  // --- controls ---
  const sheetList = el('div', { class: 'sheet-list' });
  const readingNote = hint();
  const errorList = el('div', { class: 'errors' });

  const download = el('button', { class: 'primary wide', onclick: () => void runExport() });
  const summary = hint();
  const exportNote = hint();

  const fpsCtl = options(
    FPS_CHOICES.map((f) => ({ value: f, label: String(f) })),
    () => {
      const p = current();
      return p ? fps(p) : 12;
    },
    (v) => ((opts.fps = v), changed()),
  );
  const fpsHint = hint();
  const boomerangCtl = toggleRow('Boomerang (forward, then back)', () => opts.boomerang, (v) => ((opts.boomerang = v), changed()));
  const repeatCtl = options(
    REPEATS.map((r) => ({ value: r, label: `${r}×` })),
    () => opts.repeat,
    (v) => ((opts.repeat = v), changed()),
  );

  const soundToggle = toggleRow('Sound', () => opts.sound, (v) => ((opts.sound = v), changed()));
  const soundPicker = filePicker('video/*', false, (f) => {
    const p = current();
    opts.soundFile = f[0];
    opts.soundStart = (p && (printed.get(p.id)?.start ?? p.payload.start)) ?? 0;
    opts.sound = true;
    changed();
  });
  const soundButton = el('button', { class: 'link', onclick: soundPicker.open });
  const soundNote = hint();

  const formatCtl = options<Format>(
    [
      { value: 'mp4', label: 'MP4' },
      { value: 'gif', label: 'GIF' },
      { value: 'png', label: 'Frames' },
    ],
    () => opts.format,
    (v) => {
      opts.format = v;
      // GIFs get big fast, so they start small
      opts.size = v === 'gif' ? 'small' : 'large';
      changed();
    },
  );
  const formatHint = hint();
  const sizeCtl = options<Size>(
    [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ],
    () => opts.size,
    (v) => ((opts.size = v), changed()),
  );
  const sizeLabel = hint();
  const borderCtl = toggleRow('Keep the white border', () => opts.keepBorder, (v) => ((opts.keepBorder = v), changed()));
  const trimCtl = slider(
    'Trim edges',
    { min: () => 0, max: () => 6, step: 0.5 },
    () => opts.trim,
    (v) => ((opts.trim = v), changed()),
    () => (opts.trim ? `${opts.trim} %` : 'Off'),
  );

  const controls = sidebar(
    [
      group('Sheets', sheetList, readingNote, errorList, el('button', { class: 'link', textContent: 'Add more sheets', onclick: picker.open })),
      more(
        field('Frames per second', fpsCtl.el, fpsHint),
        boomerangCtl.el,
        field('Repeat', repeatCtl.el, hint('For MP4. GIFs loop on their own.')),
        field('Sound', soundToggle.el, soundButton, soundNote),
        field('File', formatCtl.el, formatHint),
        field('Size', sizeCtl.el, sizeLabel),
        borderCtl.el,
        trimCtl.el,
      ),
    ],
    [download, summary, exportNote],
  );

  const work = el('div', { class: 'work', hidden: true }, controls, view);

  // --- render ---
  function render() {
    const p = current();
    const found = new Map<number, string>();
    for (const s of scans) if (s.status === 'done' && s.result?.payload?.projectId === p?.id) found.set(s.result!.payload!.page, s.name);
    sheetList.replaceChildren(
      ...(p
        ? [...Array(p.payload.pages).keys()].map((i) => {
            const name = found.get(i + 1);
            return el(
              'div',
              {},
              el('span', { textContent: `Sheet ${i + 1}` }),
              el('span', { class: name ? 'muted' : 'warn', textContent: name ?? 'missing' }),
            );
          })
        : []),
    );
    const working = scans.filter((s) => s.status === 'waiting' || s.status === 'working').length;
    readingNote.textContent = working ? `Reading ${plural(working, 'file', 'files')}…` : '';
    errorList.replaceChildren(
      ...scans
        .filter((s) => s.status === 'failed' || (s.status === 'done' && s.result?.payload?.projectId !== p?.id))
        .map((s) =>
          el(
            'div',
            {},
            el('span', { textContent: s.name }),
            el('span', { class: 'warn', textContent: s.status === 'failed' ? (s.error ?? 'No PAPR sheet found in this image.') : 'From another project, left out.' }),
          ),
        ),
    );
    player.hidden = !p;
    waiting.hidden = !!p;
    waiting.textContent = working ? 'Reading your sheets…' : 'No sheet found yet.';
    if (p) buildStrip(p);
    changed();
  }

  /** Part of each stored image that goes into the video. */
  const source = (p: Project) => (opts.keepBorder && p.inner.x > 0 ? { x: 0, y: 0, w: p.full.w, h: p.full.h } : p.inner);
  const outSize = (p: Project) => {
    const s = source(p);
    return frameSize(s.w / s.h, SIZES[opts.size]);
  };
  const label = () => (opts.format === 'png' ? 'frames' : opts.format.toUpperCase());

  function changed() {
    const p = current();
    for (const c of [fpsCtl, boomerangCtl, repeatCtl, soundToggle, formatCtl, sizeCtl, borderCtl, trimCtl] as Control[]) c.sync();
    if (!busy) download.textContent = `Download ${label()}`;
    download.disabled = !p || busy;
    if (p) {
      const n = sequence(p).length;
      const reps = opts.format === 'mp4' ? opts.repeat : 1;
      const s = outSize(p);
      fpsHint.textContent = `Printed at ${p.payload.fps}.`;
      sizeLabel.textContent = `${s.w} × ${s.h} pixels`;
      borderCtl.el.hidden = p.inner.x === 0;
      formatHint.textContent = opts.format === 'png' ? 'Every frame as a PNG image, in one ZIP. For further editing.' : '';
      summary.textContent = [
        plural(n * reps, 'frame', 'frames'),
        `${((n * reps) / fps(p)).toFixed(1)} s`,
        `${s.w} × ${s.h}`,
        withSound(p) ? 'with sound' : '',
      ]
        .filter(Boolean)
        .join(' · ');

      // sound
      const allowed = soundAllowed(p);
      const has = !!opts.soundFile;
      soundToggle.el.hidden = !has || !allowed;
      soundButton.hidden = !allowed;
      soundButton.textContent = has ? `${opts.soundFile!.name} · change` : 'Add the original video for its sound';
      soundNote.textContent = !allowed
        ? `Sound only fits at ${p.payload.fps} frames per second and without boomerang.`
        : has && opts.format !== 'mp4'
          ? 'Only MP4 has sound.'
          : has && p.payload.start === undefined && !printed.has(p.id)
            ? 'These sheets don’t say where in the video they start, so the sound starts at the beginning.'
            : '';

      // the player shows exactly what gets exported (minus repeats)
      const ps = frameSize(s.w / s.h, 1280);
      if (player.width !== ps.w || player.height !== ps.h) {
        player.width = ps.w;
        player.height = ps.h;
        playerHolder.style.setProperty('--ar', `${ps.w} / ${ps.h}`); // phones size the holder by it
      }
      // after a change the last file's name (or error) no longer applies
      if (!busy && noteKey !== exportKey(p)) {
        noteKey = '';
        exportNote.className = 'hint';
        exportNote.textContent = missingPages(p).length ? 'Missing frames repeat the frame before them.' : '';
      }
    }
    shown = -1;
  }

  const drawer = (p: Project, order: number[]): DrawFrame => {
    const s = source(p);
    const t = opts.trim / 100;
    // a missing frame repeats the one before it
    const frames: (ImageBitmap | undefined)[] = [];
    let prev: ImageBitmap | undefined;
    for (let i = 0; i < p.payload.frameCount; i++) frames.push((prev = p.frames.get(i) ?? prev));
    return (ctx, i, w, h) => {
      const f = frames[order[i % order.length]];
      if (!f) {
        ctx.fillStyle = '#1b1b1b';
        ctx.fillRect(0, 0, w, h);
        return;
      }
      ctx.drawImage(f, s.x + s.w * t, s.y + s.h * t, s.w * (1 - 2 * t), s.h * (1 - 2 * t), 0, 0, w, h);
    };
  };

  // --- player loop ---
  let playing = true;
  let t0 = performance.now();
  let shown = -1;
  let pos = 0;
  player.onclick = () => {
    playing = !playing;
    const p = current();
    if (playing && p) t0 = performance.now() - (pos / fps(p)) * 1000;
  };
  function showFrame(i: number) {
    const p = current();
    if (!p) return;
    playing = false;
    pos = Math.max(0, sequence(p).indexOf(i));
    shown = -1;
  }
  const tick = (now: number) => {
    const p = current();
    if (p) {
      const order = sequence(p);
      if (playing) pos = Math.floor(((now - t0) / 1000) * fps(p)) % order.length;
      if (pos !== shown) {
        shown = pos;
        drawer(p, order)(player.getContext('2d')! as unknown as OffscreenCanvasRenderingContext2D, pos, player.width, player.height);
        const src = order[pos];
        thumbs.forEach((t, k) => t.classList.toggle('on', k === src));
        if (!playing) thumbs[src]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // --- export: one click, straight to the download ---
  async function runExport() {
    const p = current();
    if (!p || busy) return;
    const key = exportKey(p);
    if (last?.key === key) return saveFile(last.url, last.name);
    noteKey = key;
    busy = true;
    download.disabled = true;
    exportNote.className = 'hint';
    const s = outSize(p);
    const order = sequence(p);
    const repeat = opts.format === 'mp4' ? opts.repeat : 1;
    try {
      let audio: AudioBuffer | undefined;
      if (withSound(p)) {
        download.textContent = 'Reading the sound…';
        audio = await cutSound(opts.soundFile!, opts.soundStart, p.payload.frameCount / p.payload.fps, repeat);
      }
      const job = {
        frames: order.length * repeat,
        fps: fps(p),
        w: s.w,
        h: s.h,
        draw: drawer(p, order),
        audio,
        onProgress: (d: number, n: number) => (download.textContent = `Making frame ${d} of ${n}`),
      };
      const name = `papr-${p.id}`;
      const blob = opts.format === 'gif' ? await exportGif(job) : opts.format === 'png' ? await exportPngZip(job, name) : await exportMp4(job);
      if (last) URL.revokeObjectURL(last.url);
      last = { key, url: URL.createObjectURL(blob), name: `${name}.${opts.format === 'png' ? 'zip' : opts.format}` };
      saveFile(last.url, last.name);
      exportNote.textContent = `${last.name} · ${mb(blob.size)}`;
    } catch (e) {
      exportNote.className = 'warn';
      exportNote.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      changed();
    }
  }

  const page = el('section', { class: 'page' }, intake, work);
  dropTarget(page, ACCEPT, true, (f) => void add(f));
  changed();
  return { el: page, add };
}

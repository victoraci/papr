// Scan panel: sheets back in → timing → sound → export. The stage shows the
// finished animation and a strip with every frame.

import { cutSound, exportGif, exportMp4, exportPngZip, type DrawFrame } from './export.ts';
import { frameSize, missingPages, processScan, toEntries, type Project, type ScanEntry } from './scans.ts';
import { printed } from './session.ts';
import { chips, dropZone, el, mb, plural, slider, toggleRow, type Control } from './ui.ts';

const SIZES = { small: 640, medium: 960, large: 1280 } as const;
type Size = keyof typeof SIZES;
type Format = 'mp4' | 'gif' | 'png';
const FPS_CHOICES = [6, 8, 12, 15, 24];
const REPEATS = [1, 2, 3, 5];

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
  let step = 0;
  let queue = Promise.resolve();
  let lastUrl = '';

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

  // --- step 1: sheets ---
  const drop = dropZone('Drop scans, photos or PDFs here or click to choose them', 'image/*,application/pdf,.pdf', true, (f) => void add(f));
  const sheetList = el('div', { class: 'sheet-list' });
  const errorList = el('div', { class: 'scans' });
  const sheetInfo = el('p', { class: 'muted' });

  async function add(files: File[]) {
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

  // --- step 2: timing ---
  const fpsCtl = chips(
    FPS_CHOICES.map((f) => ({ value: f, label: String(f) })),
    () => {
      const p = current();
      return p ? fps(p) : 12;
    },
    (v) => ((opts.fps = v), changed()),
    5,
  );
  const fpsHint = el('p', { class: 'muted small' });
  const boomerangCtl = toggleRow('Boomerang (forward, then back)', () => opts.boomerang, (v) => ((opts.boomerang = v), changed()));
  const repeatCtl = chips(
    REPEATS.map((r) => ({ value: r, label: `${r}×` })),
    () => opts.repeat,
    (v) => ((opts.repeat = v), changed()),
    4,
  );

  // --- step 3: sound ---
  const soundToggle = toggleRow('Sound', () => opts.sound, (v) => ((opts.sound = v), changed()));
  const soundName = el('p', { class: 'muted small' });
  const soundDrop = dropZone('Drop the original video here to use its sound', 'video/*', false, (f) => {
    const p = current();
    opts.soundFile = f[0];
    opts.soundStart = (p && (printed.get(p.id)?.start ?? p.payload.start)) ?? 0;
    opts.sound = true;
    changed();
  });
  const soundNote = el('p', { class: 'muted small' });

  // --- step 4: export ---
  const formatCtl = chips(
    [
      { value: 'mp4' as Format, label: 'MP4' },
      { value: 'gif' as Format, label: 'GIF' },
      { value: 'png' as Format, label: 'Frames' },
    ],
    () => opts.format,
    (v) => {
      opts.format = v;
      // GIFs get big fast, so they start small
      opts.size = v === 'gif' ? 'small' : 'large';
      changed();
    },
    3,
  );
  const formatHint = el('p', { class: 'muted small' });
  const sizeCtl = chips(
    [
      { value: 'small' as Size, label: 'Small' },
      { value: 'medium' as Size, label: 'Medium' },
      { value: 'large' as Size, label: 'Large' },
    ],
    () => opts.size,
    (v) => ((opts.size = v), changed()),
    3,
  );
  const sizeLabel = el('p', { class: 'muted small' });
  const borderCtl = toggleRow('Keep the white border', () => opts.keepBorder, (v) => ((opts.keepBorder = v), changed()));
  const trimCtl = slider(
    'Trim edges',
    { min: () => 0, max: () => 6, step: 0.5 },
    () => opts.trim,
    (v) => ((opts.trim = v), changed()),
    () => (opts.trim ? `${opts.trim} %` : 'Off'),
  );
  const fileLink = el('a', { class: 'button primary wide', hidden: true });
  const exportNote = el('p', { class: 'muted' });

  const label = (t: string) => el('span', { textContent: t });
  const steps: { title: string; hint?: string; body: Node[] }[] = [
    { title: 'Sheets', hint: 'Scans or photos of your sheets, in any order.', body: [drop.el, sheetList, sheetInfo, errorList] },
    {
      title: 'Timing',
      body: [
        el('div', { class: 'stack' }, label('Frames per second'), fpsCtl.el, fpsHint),
        boomerangCtl.el,
        el('div', { class: 'stack' }, label('Repeat'), repeatCtl.el, el('p', { class: 'muted small', textContent: 'For MP4. GIFs loop on their own.' })),
      ],
    },
    { title: 'Sound', hint: 'The sound of the part you printed, under your animation.', body: [soundToggle.el, soundName, soundDrop.el, soundNote] },
    {
      title: 'Export',
      body: [
        el('div', { class: 'stack' }, formatCtl.el, formatHint),
        el('div', { class: 'stack' }, label('Size'), sizeCtl.el, sizeLabel),
        borderCtl.el,
        trimCtl.el,
        fileLink,
        exportNote,
      ],
    },
  ];

  // --- sidebar shell ---
  const title = el('h2');
  const stepHint = el('p', { class: 'muted small' });
  const body = el('div', { class: 'step-body' });
  const progress = el('div', { class: 'progress' });
  const segs = steps.map((_, i) => el('button', { ariaLabel: `Step ${i + 1}`, onclick: () => current() && go(i) }));
  progress.append(...segs);
  const back = el('button', { textContent: 'Back', onclick: () => go(step - 1) });
  const next = el('button', { class: 'primary' });
  next.onclick = () => (step === steps.length - 1 ? void runExport() : go(step + 1));

  function go(i: number) {
    step = Math.max(0, Math.min(steps.length - 1, i));
    renderStep();
  }

  function renderStep() {
    const s = steps[step];
    title.textContent = s.title;
    stepHint.textContent = s.hint ?? '';
    body.replaceChildren(...s.body);
    segs.forEach((b, i) => b.classList.toggle('done', i <= step));
    back.disabled = step === 0;
    next.textContent = step < steps.length - 1 ? 'Next' : opts.format === 'png' ? 'Export frames' : `Export ${opts.format.toUpperCase()}`;
    next.disabled = !current();
  }

  // --- stage: player + frame strip ---
  const player = el('canvas', { class: 'stepped', title: 'Click to pause' });
  const strip = el('div', { class: 'frame-strip' });
  const empty = el('p', { class: 'muted', textContent: 'The animation plays here once sheets are added.' });
  const playerWrap = el('div', { class: 'video-stage scan', hidden: true }, player, strip);
  const stage = el('div', { class: 'stage' }, playerWrap, empty);
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
    sheetInfo.textContent = working ? `Reading ${plural(working, 'file', 'files')}…` : '';
    errorList.replaceChildren(
      ...scans
        .filter((s) => s.status === 'failed' || (s.status === 'done' && s.result?.payload?.projectId !== p?.id))
        .map((s) =>
          el(
            'div',
            { class: 'failed' },
            el('span', { textContent: s.name }),
            el('span', { class: 'warn', textContent: s.status === 'failed' ? (s.error ?? 'No Rotopaper sheet found in this image.') : 'From another project, left out.' }),
          ),
        ),
    );
    if (p) {
      playerWrap.hidden = false;
      empty.hidden = true;
      buildStrip(p);
    }
    changed();
  }

  /** Part of each stored image that goes into the video. */
  const source = (p: Project) => (opts.keepBorder && p.inner.x > 0 ? { x: 0, y: 0, w: p.full.w, h: p.full.h } : p.inner);
  const outSize = (p: Project) => {
    const s = source(p);
    return frameSize(s.w / s.h, SIZES[opts.size]);
  };

  function changed() {
    const p = current();
    for (const c of [fpsCtl, boomerangCtl, repeatCtl, soundToggle, formatCtl, sizeCtl, borderCtl, trimCtl] as Control[]) c.sync();
    if (p) {
      const n = sequence(p).length;
      fpsHint.textContent = `Printed at ${p.payload.fps}. ${plural(n, 'frame', 'frames')} take ${(n / fps(p)).toFixed(1)} s.`;
      const s = outSize(p);
      sizeLabel.textContent = `${s.w} × ${s.h} pixels`;
      borderCtl.el.hidden = p.inner.x === 0;
      formatHint.textContent = opts.format === 'png' ? 'Every frame as a PNG image, in one ZIP. For further editing.' : '';

      // sound
      const allowed = soundAllowed(p);
      const has = !!opts.soundFile;
      soundToggle.el.hidden = !has || !allowed;
      soundName.textContent = has && allowed ? opts.soundFile!.name : '';
      soundDrop.el.hidden = has || !allowed;
      soundNote.textContent = !allowed
        ? `Sound only fits at ${p.payload.fps} frames per second and without boomerang.`
        : opts.format !== 'mp4'
          ? 'Only MP4 has sound.'
          : has && p.payload.start === undefined && !printed.has(p.id)
            ? 'These sheets don’t say where in the video they start, so the sound starts at the beginning.'
            : '';

      // the player shows exactly what gets exported (minus repeats)
      const ps = frameSize(s.w / s.h, 1280);
      if (player.width !== ps.w || player.height !== ps.h) {
        player.width = ps.w;
        player.height = ps.h;
      }
    }
    fileLink.hidden = true;
    exportNote.textContent = '';
    shown = -1;
    renderStep();
  }

  const drawer = (p: Project, order: number[]): DrawFrame => {
    const s = source(p);
    const t = opts.trim / 100;
    // a missing frame repeats the one before it
    const frames: (ImageBitmap | undefined)[] = [];
    let last: ImageBitmap | undefined;
    for (let i = 0; i < p.payload.frameCount; i++) frames.push((last = p.frames.get(i) ?? last));
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

  // --- export ---
  async function runExport() {
    const p = current();
    if (!p) return;
    next.disabled = true;
    fileLink.hidden = true;
    const s = outSize(p);
    const order = sequence(p);
    const repeat = opts.format === 'mp4' ? opts.repeat : 1;
    try {
      let audio: AudioBuffer | undefined;
      if (opts.format === 'mp4' && opts.sound && opts.soundFile && soundAllowed(p)) {
        exportNote.textContent = 'Reading the sound…';
        audio = await cutSound(opts.soundFile, opts.soundStart, p.payload.frameCount / p.payload.fps, repeat);
      }
      const job = {
        frames: order.length * repeat,
        fps: fps(p),
        w: s.w,
        h: s.h,
        draw: drawer(p, order),
        audio,
        onProgress: (d: number, n: number) => (exportNote.textContent = `Encoding frame ${d} of ${n}`),
      };
      const name = `rotopaper-${p.id}`;
      const blob = opts.format === 'gif' ? await exportGif(job) : opts.format === 'png' ? await exportPngZip(job, name) : await exportMp4(job);
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      fileLink.href = lastUrl;
      fileLink.download = `${name}.${opts.format === 'png' ? 'zip' : opts.format}`;
      fileLink.textContent = `Download ${opts.format === 'png' ? 'frames' : opts.format.toUpperCase()} · ${mb(blob.size)}`;
      fileLink.hidden = false;
      exportNote.textContent = missingPages(p).length ? 'Missing frames repeat the frame before them.' : '';
    } catch (e) {
      exportNote.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      next.disabled = false;
    }
  }

  const panel = el(
    'div',
    { class: 'panel' },
    el(
      'aside',
      { class: 'side' },
      el('div', { class: 'side-scroll' }, el('div', { class: 'step-head' }, title, stepHint), body),
      el('div', { class: 'side-foot' }, progress, el('div', { class: 'nav' }, back, next)),
    ),
    stage,
  );
  renderStep();
  return { el: panel, add };
}

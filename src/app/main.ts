import '@fontsource-variable/inter';
import './style.css';
import kauzalSvg from './assets/kauzal.svg?raw';
import logoSvg from './assets/rotopaper.svg?raw';
import {
  computeLayout,
  FRAME_MIN,
  GAP_MAX,
  GAP_MIN,
  LAYOUT_VERSION,
  makeSpec,
  maxFrameWidth,
  PAPERS,
  validateSpec,
  type PaperId,
  type SheetSpec,
} from '../core/layout.ts';
import { framesPerPage, newProjectId } from '../core/payload.ts';
import { buildSheetsPdf, pageCount } from '../core/pdf.ts';
import { exportMp4 } from './export.ts';
import { renderSheetSvg } from './preview.ts';
import { missingPages, processScan, type Project, type ScanEntry } from './scans.ts';
import { frameGrabber, loadVideo, type LoadedVideo } from './video.ts';

// --- small DOM helpers -----------------------------------------------------

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  for (const c of children) if (c) e.append(c);
  return e;
}

function svgSpan(svg: string, cls: string) {
  const s = el('span', { class: cls });
  s.innerHTML = svg;
  return s;
}

function fileButton(label: string, accept: string, multiple: boolean, onFiles: (files: File[]) => void) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true });
  input.onchange = () => {
    if (input.files?.length) onFiles([...input.files]);
    input.value = '';
  };
  const button = el('button', { class: 'primary', textContent: label, onclick: () => input.click() });
  return el('div', {}, button, input);
}

function segmented<T extends string>(options: { value: T; label: string }[], get: () => T, set: (v: T) => void) {
  const wrap = el('div', { class: 'segmented' });
  const buttons = options.map((o) =>
    el('button', {
      textContent: o.label,
      onclick: () => {
        set(o.value);
        sync();
      },
    }),
  );
  const sync = () => buttons.forEach((b, i) => b.classList.toggle('on', options[i].value === get()));
  wrap.append(...buttons);
  sync();
  return { el: wrap, sync };
}

function toggle(get: () => boolean, set: (v: boolean) => void, label: string) {
  const b = el('button', { class: 'switch', role: 'switch', ariaLabel: label });
  const sync = () => b.setAttribute('aria-checked', String(get()));
  b.onclick = () => {
    set(!get());
    sync();
  };
  sync();
  return { el: b, sync };
}

function numberInput(get: () => number, set: (v: number) => void, attrs: { min: number; max?: number; step: number }) {
  const input = el('input', { type: 'number', min: String(attrs.min), step: String(attrs.step) });
  if (attrs.max !== undefined) input.max = String(attrs.max);
  const sync = () => {
    if (document.activeElement !== input) input.value = String(+get().toFixed(2));
  };
  input.oninput = () => {
    const v = Number(input.value);
    if (input.value !== '' && Number.isFinite(v)) set(v);
  };
  input.onblur = sync;
  sync();
  return { el: input, sync };
}

const unit = (text: string) => el('span', { class: 'muted', textContent: text });
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// --- 1. video → sheets -----------------------------------------------------

const ASPECTS: { value: string; label: string; ratio: number }[] = [
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  { value: '4:3', label: '4:3', ratio: 4 / 3 },
  { value: '1:1', label: '1:1', ratio: 1 },
  { value: '4:5', label: '4:5', ratio: 4 / 5 },
  { value: '9:16', label: '9:16', ratio: 9 / 16 },
  { value: '2.39:1', label: '2.39:1', ratio: 2.39 },
];

const state = {
  video: null as LoadedVideo | null,
  paper: 'A4' as PaperId,
  landscape: true,
  aspect: 'original',
  frameW: 74,
  gap: 8,
  fps: 12,
  start: 0,
  end: 0,
  text: true,
  borders: false,
  projectId: newProjectId(),
  pdfUrl: '',
};

function aspectRatio(): number {
  const v = state.video;
  if (state.aspect === 'original' || !v) return v ? v.width / v.height : 16 / 9;
  return ASPECTS.find((a) => a.value === state.aspect)!.ratio;
}

function spec(): SheetSpec {
  return makeSpec(state.paper, state.landscape, aspectRatio(), state.frameW, state.gap);
}

function frameCount() {
  return Math.max(1, Math.floor((state.end - state.start) * state.fps + 1e-6));
}

/** Biggest frame width that still gives at least 9 frames per sheet. */
function defaultFrameWidth(): number {
  const max = maxFrameWidth(state.paper, state.landscape, aspectRatio(), state.gap);
  for (let w = max; w > FRAME_MIN; w--) {
    const s = makeSpec(state.paper, state.landscape, aspectRatio(), w, state.gap);
    if (s.cols * s.rows >= 9) return w;
  }
  return max;
}

function aspectName(r: number): string {
  const near = ASPECTS.find((a) => Math.abs(a.ratio - r) < 0.01);
  return near ? near.label : `${r.toFixed(2)}:1`;
}

const videoPick = fileButton('Choose video', 'video/*', false, (f) => void openVideo(f[0]));
const videoInfo = el('p', { class: 'muted' });
const videoPlayer = el('video', { controls: true, muted: true, loop: true, playsInline: true });

const paperCtl = segmented(
  (Object.keys(PAPERS) as PaperId[]).map((id) => ({ value: id, label: PAPERS[id].name })),
  () => state.paper,
  (v) => {
    state.paper = v;
    state.frameW = defaultFrameWidth();
    update();
  },
);
const orientCtl = segmented(
  [
    { value: 'P', label: 'Portrait' },
    { value: 'L', label: 'Landscape' },
  ],
  () => (state.landscape ? 'L' : 'P'),
  (v) => {
    state.landscape = v === 'L';
    state.frameW = defaultFrameWidth();
    update();
  },
);
const aspectSel = el('select');
aspectSel.onchange = () => {
  state.aspect = aspectSel.value;
  state.frameW = defaultFrameWidth();
  update();
};
const frameWIn = numberInput(() => state.frameW, (v) => ((state.frameW = v), update()), { min: FRAME_MIN, step: 1 });
const gapIn = numberInput(() => state.gap, (v) => ((state.gap = v), update()), { min: GAP_MIN, max: GAP_MAX, step: 0.5 });
const fpsIn = numberInput(() => state.fps, (v) => ((state.fps = v), update()), { min: 1, max: 60, step: 1 });
const startIn = numberInput(() => state.start, (v) => ((state.start = v), update()), { min: 0, step: 0.1 });
const endIn = numberInput(() => state.end, (v) => ((state.end = v), update()), { min: 0, step: 0.1 });
const textCtl = toggle(() => state.text, (v) => ((state.text = v), update()), 'Text');
const bordersCtl = toggle(() => state.borders, (v) => ((state.borders = v), update()), 'Frame borders');

const row = (label: string, ...controls: Child[]) => [
  el('span', { class: 'muted', textContent: label }),
  el('div', {}, ...controls),
];
const settings = el(
  'div',
  { class: 'settings' },
  ...row('Paper', paperCtl.el),
  ...row('Orientation', orientCtl.el),
  ...row('Aspect ratio', aspectSel),
  ...row('Frame width', frameWIn.el, unit('mm')),
  ...row('Spacing', gapIn.el, unit('mm')),
  ...row('Frame rate', fpsIn.el, unit('fps')),
  ...row('Section', startIn.el, unit('to'), endIn.el, unit('s')),
  ...row('Text', textCtl.el),
  ...row('Frame borders', bordersCtl.el),
);
const summary = el('p', { class: 'muted' });
const makePdf = el('button', { class: 'primary', textContent: 'Create PDF' });
const pdfLink = el('a', { class: 'button', hidden: true });
const pdfNote = el('p', { class: 'muted' });
const sheetPreview = el('div', { class: 'sheet' });

const setup = el(
  'div',
  { class: 'setup', hidden: true },
  el('div', { class: 'controls' }, videoPlayer, settings, summary, el('div', { class: 'row' }, makePdf, pdfLink), pdfNote),
  el('div', { class: 'preview' }, sheetPreview),
);

async function openVideo(file: File) {
  videoInfo.className = 'muted';
  videoInfo.textContent = 'Opening…';
  try {
    const v = await loadVideo(file);
    if (state.video) URL.revokeObjectURL(state.video.url);
    state.video = v;
    state.start = 0;
    state.end = +v.duration.toFixed(2);
    state.aspect = 'original';
    state.landscape = v.width >= v.height;
    state.frameW = defaultFrameWidth();
    aspectSel.replaceChildren(
      el('option', { value: 'original', textContent: `Original (${aspectName(v.width / v.height)})` }),
      ...ASPECTS.map((a) => el('option', { value: a.value, textContent: a.label })),
    );
    videoInfo.textContent = `${file.name} · ${v.duration.toFixed(1)} s · ${v.width} × ${v.height}`;
    videoPlayer.src = v.url;
    setup.hidden = false;
    pdfLink.hidden = true;
    pdfNote.textContent = '';
    thumbs.clear();
    update();
  } catch (e) {
    videoInfo.className = 'warn';
    videoInfo.textContent = e instanceof Error ? e.message : String(e);
  }
}

function update() {
  const v = state.video;
  if (!v) return;
  state.end = Math.min(state.end, +v.duration.toFixed(2));
  for (const c of [paperCtl, orientCtl, frameWIn, gapIn, fpsIn, startIn, endIn, textCtl, bordersCtl]) c.sync();
  aspectSel.value = state.aspect;
  frameWIn.el.max = String(maxFrameWidth(state.paper, state.landscape, aspectRatio(), state.gap));

  const s = spec();
  const err = validateSpec(s) ?? (state.end > state.start ? null : 'The section is empty.');
  if (err) {
    summary.className = 'warn';
    summary.textContent = err;
    makePdf.disabled = true;
    return;
  }
  const n = frameCount();
  summary.className = 'muted';
  summary.textContent = `${plural(n, 'frame', 'frames')} · ${framesPerPage(s)} per sheet · ${plural(pageCount(s, n), 'sheet', 'sheets')}`;
  makePdf.disabled = false;
  void renderPreview();
}

// sheet preview with real frames, fetched in the background
const thumbs = new Map<string, string>();
let previewRun = 0;

const thumbKey = (i: number) => `${state.start}|${state.fps}|${aspectRatio().toFixed(4)}|${i}`;

async function renderPreview() {
  const run = ++previewRun;
  const s = spec();
  const layout = computeLayout(s);
  const n = frameCount();
  const draw = async () => {
    const svg = await renderSheetSvg(
      layout,
      { version: LAYOUT_VERSION, projectId: state.projectId, page: 1, pages: pageCount(s, n), spec: s, fps: state.fps, frameCount: n },
      { text: state.text, borders: state.borders },
      state.video?.file.name,
      (i) => thumbs.get(thumbKey(i)),
    );
    if (run === previewRun) sheetPreview.replaceChildren(svg);
  };
  await draw();

  const wanted = Math.min(framesPerPage(s), n, 60);
  const missing = [...Array(wanted).keys()].filter((i) => !thumbs.has(thumbKey(i)));
  if (!missing.length || !state.video) return;
  await new Promise((r) => setTimeout(r, 250)); // settle while the user is still typing
  if (run !== previewRun) return;
  const grab = await frameGrabber(state.video, state.start, state.fps, aspectRatio(), 240);
  for (const i of missing) {
    if (run !== previewRun) return;
    thumbs.set(thumbKey(i), await grab.dataUrl(i));
  }
  await draw();
}

makePdf.onclick = async () => {
  const v = state.video;
  const s = spec();
  if (!v || validateSpec(s)) return;
  makePdf.disabled = true;
  pdfLink.hidden = true;
  const n = frameCount();
  const id = state.projectId;
  try {
    // ~300 dpi on paper
    const grab = await frameGrabber(v, state.start, state.fps, s.aspect, (s.frameW / 25.4) * 300);
    const bytes = await buildSheetsPdf({
      spec: s,
      style: { text: state.text, borders: state.borders },
      projectId: id,
      fps: state.fps,
      frameCount: n,
      title: v.file.name,
      getFrame: (i) => grab.jpeg(i),
      onProgress: (done, total) => (pdfNote.textContent = `Frame ${done} of ${total}`),
    });
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    pdfLink.href = state.pdfUrl;
    pdfLink.download = `rotopaper-${id}.pdf`;
    pdfLink.textContent = `Download PDF · ${mb(bytes.length)}`;
    pdfLink.hidden = false;
    pdfNote.textContent = 'Print at 100 % or fit to page. Don’t paint over the black squares or the QR code.';
    // the next PDF is a new project, so sheets of both can't get mixed up
    state.projectId = newProjectId();
  } catch (e) {
    pdfNote.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    makePdf.disabled = false;
  }
};

// --- 2. scans → video ------------------------------------------------------

const scans: ScanEntry[] = [];
const projects = new Map<string, Project>();

const scanPick = fileButton('Add scans', 'image/*', true, (f) => addScans(f));
const scanList = el('div', { class: 'scans' });
const projectInfo = el('p', { class: 'muted' });
const player = el('canvas', { hidden: true, title: 'Click to pause' });
const exportBtn = el('button', { class: 'primary', textContent: 'Export MP4', hidden: true });
const exportStatus = el('p', { class: 'muted' });
const mp4Link = el('a', { class: 'button', hidden: true });
let queue = Promise.resolve();

function addScans(files: File[]) {
  for (const file of files) {
    const entry: ScanEntry = { file, status: 'waiting' };
    scans.push(entry);
    queue = queue.then(async () => {
      renderScans();
      await new Promise((r) => setTimeout(r, 30)); // let the list paint before the heavy work
      await processScan(entry, projects);
      renderScans();
    });
  }
  renderScans();
}

function currentProject(): Project | null {
  let best: Project | null = null;
  for (const p of projects.values()) if (!best || p.frames.size > best.frames.size) best = p;
  return best;
}

function renderScans() {
  scanList.replaceChildren(
    ...scans.map((s) => {
      const r = s.result;
      let text = '';
      let cls = 'muted';
      if (s.status === 'waiting') text = 'Waiting';
      else if (s.status === 'working') text = 'Reading…';
      else if (s.status === 'failed') {
        text = s.error ?? 'Not recognised';
        cls = 'warn';
      } else if (r?.payload) text = `Sheet ${r.payload.page} of ${r.payload.pages} · ${plural(r.frames.length, 'frame', 'frames')}`;
      return el('div', {}, el('span', { textContent: s.file.name }), el('span', { className: cls, textContent: text }));
    }),
  );

  const p = currentProject();
  if (!p) return;
  const miss = missingPages(p);
  projectInfo.textContent =
    `${p.frames.size} of ${p.payload.frameCount} frames · ${p.payload.fps} fps` +
    (miss.length ? ` · ${miss.length === 1 ? 'sheet' : 'sheets'} ${miss.join(', ')} missing` : '') +
    (projects.size > 1 ? ` · scans from another project are left out` : '');
  player.hidden = false;
  exportBtn.hidden = false;
  if (player.width !== p.frameW) {
    player.width = p.frameW;
    player.height = p.frameH;
  }
}

// preview loop
let playing = true;
let t0 = performance.now();
player.onclick = () => {
  playing = !playing;
  t0 = performance.now();
};
function orderedFrames(p: Project): (ImageBitmap | undefined)[] {
  const out: (ImageBitmap | undefined)[] = [];
  let last: ImageBitmap | undefined;
  for (let i = 0; i < p.payload.frameCount; i++) {
    last = p.frames.get(i) ?? last;
    out.push(last);
  }
  return out;
}
let shown = -1;
function tick(now: number) {
  const p = currentProject();
  if (p && playing) {
    const i = Math.floor(((now - t0) / 1000) * p.payload.fps) % p.payload.frameCount;
    if (i !== shown) {
      shown = i;
      const ctx = player.getContext('2d')!;
      const f = orderedFrames(p)[i];
      if (f) ctx.drawImage(f, 0, 0, player.width, player.height);
      else {
        ctx.fillStyle = '#1b1b1b';
        ctx.fillRect(0, 0, player.width, player.height);
      }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

exportBtn.onclick = async () => {
  const p = currentProject();
  if (!p) return;
  exportBtn.disabled = true;
  mp4Link.hidden = true;
  try {
    const blob = await exportMp4(orderedFrames(p), p.payload.fps, p.frameW, p.frameH, (d, n) => {
      exportStatus.textContent = `Encoding frame ${d} of ${n}`;
    });
    mp4Link.href = URL.createObjectURL(blob);
    mp4Link.download = `rotopaper-${p.id}.mp4`;
    mp4Link.textContent = `Download MP4 · ${mb(blob.size)}`;
    mp4Link.hidden = false;
    exportStatus.textContent = missingPages(p).length ? 'Missing frames repeat the frame before them.' : '';
  } catch (e) {
    exportStatus.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    exportBtn.disabled = false;
  }
};

// --- page ------------------------------------------------------------------

document.getElementById('app')!.append(
  el(
    'header',
    {},
    svgSpan(logoSvg, 'logo'),
    el('a', { class: 'by', href: 'https://kauzal.com', target: '_blank', rel: 'noopener' }, el('span', { textContent: 'by' }), svgSpan(kauzalSvg, 'kauzal')),
    el('p', { class: 'muted intro', textContent: 'Turn a video into printable sheets, work on them by hand and scan them back into a video.' }),
  ),
  el('section', {}, el('h2', { textContent: 'Video to sheets' }), el('div', { class: 'row' }, videoPick, videoInfo), setup),
  el(
    'section',
    {},
    el('h2', { textContent: 'Sheets to video' }),
    el('p', { class: 'muted', textContent: 'Scan or photograph the sheets and add them here. The order doesn’t matter.' }),
    scanPick,
    scanList,
    projectInfo,
    player,
    el('div', { class: 'row' }, exportBtn, mp4Link),
    exportStatus,
  ),
);

// dev hook so the flow can be driven without a file dialog
if (import.meta.env.DEV) Object.assign(window, { rotopaper: { openVideo, addScans, state } });

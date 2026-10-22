import '@fontsource-variable/inter';
import './style.css';
import { cellSize, PAPERS, suggestGrid, validateSpec, type PaperId, type SheetSpec } from '../core/layout.ts';
import { newProjectId, framesPerPage } from '../core/payload.ts';
import { buildSheetsPdf, pageCount } from '../core/pdf.ts';
import { exportMp4 } from './export.ts';
import { missingPages, processScan, type Project, type ScanEntry } from './scans.ts';
import { frameGrabber, loadVideo, type LoadedVideo } from './video.ts';

// --- tiny DOM helper -------------------------------------------------------

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

function fileButton(label: string, accept: string, multiple: boolean, onFiles: (files: File[]) => void) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true });
  input.onchange = () => {
    if (input.files?.length) onFiles([...input.files]);
    input.value = '';
  };
  const button = el('button', { class: 'primary', textContent: label, onclick: () => input.click() });
  return { button, input };
}

function mb(bytes: number) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

// --- 1. video → sheets -----------------------------------------------------

const state = {
  video: null as LoadedVideo | null,
  paper: 'A4' as PaperId,
  landscape: true,
  cols: 3,
  rows: 3,
  fps: 12,
  start: 0,
  end: 0,
  pdfUrl: '',
};

const videoPick = fileButton('Choose video', 'video/*', false, (f) => void openVideo(f[0]));
const videoInfo = el('p', { class: 'muted' });
const videoPreview = el('video', { controls: true, muted: true, loop: true, playsInline: true, hidden: true });

const paperSel = el('select', {}, ...Object.entries(PAPERS).map(([id, p]) => el('option', { value: id, textContent: p.name })));
const orientSel = el('select', {}, el('option', { value: 'L', textContent: 'Landscape' }), el('option', { value: 'P', textContent: 'Portrait' }));
const colsIn = el('input', { type: 'number', min: '1', max: '10', step: '1' });
const rowsIn = el('input', { type: 'number', min: '1', max: '15', step: '1' });
const fpsIn = el('input', { type: 'number', min: '1', max: '60', step: '1' });
const startIn = el('input', { type: 'number', min: '0', step: '0.1' });
const endIn = el('input', { type: 'number', min: '0', step: '0.1' });
const settings = el(
  'div',
  { class: 'settings', hidden: true },
  el('span', { class: 'muted', textContent: 'Paper' }),
  el('div', {}, paperSel, orientSel),
  el('span', { class: 'muted', textContent: 'Frames per sheet' }),
  el('div', {}, colsIn, el('span', { class: 'muted', textContent: '×' }), rowsIn),
  el('span', { class: 'muted', textContent: 'Frame rate' }),
  el('div', {}, fpsIn, el('span', { class: 'muted', textContent: 'fps' })),
  el('span', { class: 'muted', textContent: 'Section' }),
  el('div', {}, startIn, el('span', { class: 'muted', textContent: 'to' }), endIn, el('span', { class: 'muted', textContent: 's' })),
);
const summary = el('p', { class: 'muted' });
const makePdf = el('button', { class: 'primary', textContent: 'Create PDF', hidden: true });
const pdfStatus = el('p', { class: 'muted' });
const pdfLink = el('a', { class: 'button', hidden: true });

function frameCount() {
  return Math.max(1, Math.floor((state.end - state.start) * state.fps + 1e-6));
}

function spec(): SheetSpec | null {
  const v = state.video;
  if (!v) return null;
  return { paper: state.paper, landscape: state.landscape, cols: state.cols, rows: state.rows, aspect: v.width / v.height };
}

function syncInputs() {
  paperSel.value = state.paper;
  orientSel.value = state.landscape ? 'L' : 'P';
  colsIn.value = String(state.cols);
  rowsIn.value = String(state.rows);
  fpsIn.value = String(state.fps);
  startIn.value = String(+state.start.toFixed(2));
  endIn.value = String(+state.end.toFixed(2));
}

function updateSummary() {
  const s = spec();
  if (!s) return;
  const err = validateSpec(s);
  if (err) {
    summary.textContent = err.charAt(0).toUpperCase() + err.slice(1) + '.';
    summary.className = 'warn';
    makePdf.disabled = true;
    return;
  }
  const n = frameCount();
  const c = cellSize(s);
  const pages = pageCount(s, n);
  summary.className = 'muted';
  summary.textContent = `${n} frames on ${pages} ${pages === 1 ? 'sheet' : 'sheets'}, each frame ${Math.round(c.w)} × ${Math.round(c.h)} mm.`;
  makePdf.disabled = !(state.end > state.start);
}

function suggest() {
  const v = state.video;
  if (!v) return;
  const g = suggestGrid(state.paper, state.landscape, v.width / v.height, 60);
  state.cols = g.cols;
  state.rows = g.rows;
}

async function openVideo(file: File) {
  videoInfo.className = 'muted';
  videoInfo.textContent = 'Opening…';
  try {
    if (state.video) URL.revokeObjectURL(state.video.url);
    const v = await loadVideo(file);
    state.video = v;
    state.start = 0;
    state.end = v.duration;
    state.landscape = v.width >= v.height;
    suggest();
    syncInputs();
    videoInfo.textContent = `${file.name} · ${v.duration.toFixed(1)} s · ${v.width} × ${v.height}`;
    videoPreview.src = v.url;
    videoPreview.hidden = false;
    settings.hidden = false;
    makePdf.hidden = false;
    pdfLink.hidden = true;
    pdfStatus.textContent = '';
    updateSummary();
  } catch (e) {
    videoInfo.className = 'warn';
    videoInfo.textContent = e instanceof Error ? e.message : String(e);
  }
}

paperSel.onchange = () => {
  state.paper = paperSel.value as PaperId;
  suggest();
  syncInputs();
  updateSummary();
};
orientSel.onchange = () => {
  state.landscape = orientSel.value === 'L';
  suggest();
  syncInputs();
  updateSummary();
};
const num = (input: HTMLInputElement, key: 'cols' | 'rows' | 'fps' | 'start' | 'end', int: boolean) => {
  input.oninput = () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    state[key] = int ? Math.round(v) : v;
    if (state.video) state.end = Math.min(state.end, state.video.duration);
    updateSummary();
  };
};
num(colsIn, 'cols', true);
num(rowsIn, 'rows', true);
num(fpsIn, 'fps', false);
num(startIn, 'start', false);
num(endIn, 'end', false);

makePdf.onclick = async () => {
  const v = state.video;
  const s = spec();
  if (!v || !s || validateSpec(s)) return;
  makePdf.disabled = true;
  pdfLink.hidden = true;
  const n = frameCount();
  const id = newProjectId();
  try {
    const bytes = await buildSheetsPdf({
      spec: s,
      projectId: id,
      fps: state.fps,
      frameCount: n,
      title: v.file.name,
      getFrame: frameGrabber(v, state.start, state.fps, cellSize(s).w),
      onProgress: (done, total) => (pdfStatus.textContent = `Frame ${done} of ${total}`),
    });
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const pages = pageCount(s, n);
    pdfLink.href = state.pdfUrl;
    pdfLink.download = `rotopaper-${id}.pdf`;
    pdfLink.textContent = `Download PDF · ${pages} ${pages === 1 ? 'sheet' : 'sheets'} · ${mb(bytes.length)}`;
    pdfLink.hidden = false;
    pdfStatus.textContent = `Print at 100 % or “fit to page”, both work. Keep the black squares and the QR code clean.`;
  } catch (e) {
    pdfStatus.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    makePdf.disabled = false;
  }
};

// --- 2. scans → video ------------------------------------------------------

const scans: ScanEntry[] = [];
const projects = new Map<string, Project>();

const scanPick = fileButton('Add scans', 'image/*', true, (f) => void addScans(f));
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
      if (s.status === 'waiting') text = 'waiting';
      else if (s.status === 'working') text = projects.size || scans.indexOf(s) > 0 ? 'reading…' : 'loading the detector, then reading…';
      else if (s.status === 'failed') {
        text = s.error ?? 'not recognised';
        cls = 'warn';
      } else if (r?.payload) {
        text = `sheet ${r.payload.page} of ${r.payload.pages} · ${r.frames.length} frames`;
        if (r.warnings.length) text += ` · ${r.warnings.join(', ')}`;
      }
      return el('div', {}, el('span', { textContent: s.file.name }), el('span', { className: cls, textContent: text }));
    }),
  );

  const p = currentProject();
  if (!p) return;
  const miss = missingPages(p);
  const others = projects.size > 1 ? ` · ${projects.size - 1} other project(s) ignored` : '';
  projectInfo.textContent =
    `${p.frames.size} of ${p.payload.frameCount} frames · ${p.payload.fps} fps` +
    (miss.length ? ` · missing ${miss.length === 1 ? 'sheet' : 'sheets'} ${miss.join(', ')}` : '') +
    others;
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
    exportStatus.textContent = missingPages(p).length ? 'Missing frames hold the previous frame.' : '';
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
    el('h1', { textContent: 'rotopaper' }),
    el('p', { class: 'muted', textContent: 'Mixed media animation. Runs in your browser, nothing is uploaded.' }),
  ),
  el(
    'section',
    {},
    el('h2', { textContent: 'Video to sheets' }),
    el('p', { class: 'muted', textContent: 'Pick a video and get a PDF with its frames laid out on sheets. Print them and work on them by hand.' }),
    el('div', { class: 'row' }, videoPick.button, videoPick.input, videoInfo),
    videoPreview,
    settings,
    summary,
    el('div', { class: 'row' }, makePdf, pdfLink),
    pdfStatus,
  ),
  el(
    'section',
    {},
    el('h2', { textContent: 'Sheets to video' }),
    el('p', { class: 'muted', textContent: 'Scan or photograph the finished sheets and add them here, in any order.' }),
    el('div', { class: 'row' }, scanPick.button, scanPick.input),
    scanList,
    projectInfo,
    player,
    el('div', { class: 'row' }, exportBtn, mp4Link),
    exportStatus,
  ),
);

// dev hook so the flow can be driven without a file dialog
if (import.meta.env.DEV) {
  Object.assign(window, { rotopaper: { openVideo, addScans, state, projects, framesPerPage } });
}

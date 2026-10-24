// Print: video → printable sheets, all on one screen. Drop a video, pick the
// part, download the PDF. The view on the left shows the moving video (with
// the crop) or the sheets, and follows whatever was changed last.

import {
  BORDERS,
  computeLayout,
  gapForBorder,
  gridChoices,
  LAYOUT_VERSION,
  PAPERS,
  PHOTO_LAYOUT,
  specForGrid,
  validateSpec,
  type BorderId,
  type GridChoice,
  type PaperId,
  type SheetSpec,
} from '../core/layout.ts';
import { framesPerPage, newProjectId } from '../core/payload.ts';
import { buildSheetsPdf, pageCount } from '../core/pdf.ts';
import type { SheetStyle } from '../core/sheet.ts';
import { renderSheetSvg } from './preview.ts';
import { printed } from './session.ts';
import { timeline } from './timeline.ts';
import { dropTarget, el, field, filePicker, group, hint, mb, more, options, plural, saveFile, sidebar, toggleRow, type Control } from './ui.ts';
import { frameGrabber, loadVideo, type Crop, type LoadedVideo } from './video.ts';
import { videoView } from './videoview.ts';

const FPS_CHOICES = [6, 8, 12, 15, 24];
const CROPS: { value: string; ratio: number }[] = [
  { value: '1:1', ratio: 1 },
  { value: '4:5', ratio: 4 / 5 },
  { value: '9:16', ratio: 9 / 16 },
  { value: '16:9', ratio: 16 / 9 },
  { value: '4:3', ratio: 4 / 3 },
];
const MAX_GRID_OPTIONS = 8;

type View = 'video' | 'sheets';
/** How the painted sheets come back in; photos get a sheet with more to hold on to. */
type Capture = 'scanner' | 'photo';

/** Up to `max` options, spread evenly over the list. */
function spread<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  return [...new Set([...Array(max).keys()].map((i) => Math.round((i * (list.length - 1)) / (max - 1))))].map((i) => list[i]);
}

const fmtTime = (t: number) => `${t.toFixed(1)} s`;

export function printPanel() {
  const state = {
    video: null as LoadedVideo | null,
    start: 0,
    end: 0,
    fps: 12,
    crop: 'original',
    cropX: 0.5,
    cropY: 0.5,
    paper: 'A4' as PaperId,
    landscape: true,
    capture: 'scanner' as Capture,
    count: 9,
    border: 'none' as BorderId,
    style: { borders: false, frameNumbers: true, fileName: true } as SheetStyle,
    projectId: newProjectId(),
    view: 'video' as View,
    page: 1,
    busy: false,
  };
  /** The last PDF; downloading again without changes gives the same file (and project). */
  let last: { key: string; url: string; name: string } | null = null;

  // --- derived ---
  const aspect = () => {
    const c = CROPS.find((x) => x.value === state.crop);
    if (c) return c.ratio;
    return state.video ? state.video.width / state.video.height : 16 / 9;
  };
  const crop = (): Crop => ({ aspect: aspect(), x: state.cropX, y: state.cropY });
  const version = () => (state.capture === 'photo' ? PHOTO_LAYOUT : LAYOUT_VERSION);
  const gap = () => gapForBorder(BORDERS[state.border], version());
  const choices = (): GridChoice[] => spread(gridChoices(state.paper, state.landscape, aspect(), gap(), 20, version()), MAX_GRID_OPTIONS);
  const choice = (): GridChoice => {
    const list = choices();
    return list.reduce((best, c) => (Math.abs(c.count - state.count) < Math.abs(best.count - state.count) ? c : best), list[0]);
  };
  const spec = (): SheetSpec => specForGrid(state.paper, state.landscape, aspect(), gap(), choice(), version());
  const frameCount = () => (state.video ? Math.max(1, Math.floor((state.end - state.start) * state.fps + 1e-6)) : 1);
  const pdfKey = () => JSON.stringify([state.video?.url, state.start, state.end, state.fps, crop(), spec(), state.style]);

  // --- before a video is in ---
  const picker = filePicker('video/*', false, (f) => void open(f[0]));
  const intakeNote = el('p', { class: 'hint' });
  const intake = el(
    'div',
    { class: 'intake' },
    el('h1', { textContent: 'Drop a video here' }),
    el('button', { class: 'primary', textContent: 'Choose a video', onclick: picker.open }),
    intakeNote,
  );

  // --- view: video or sheets ---
  const view = videoView(
    (c) => {
      state.cropX = c.x;
      state.cropY = c.y;
      changed('video');
    },
    (t) => tl.setPlayhead(t),
  );
  const tl = timeline(
    () => ({ start: state.start, end: state.end }),
    (r) => {
      state.start = r.start;
      state.end = r.end;
      changed('video');
    },
    () => 2 / state.fps,
  );
  const rangeLabel = el('span');
  const videoPane = el(
    'div',
    { class: 'video-pane' },
    view.el,
    tl.el,
    el('div', { class: 'tl-label' }, rangeLabel, el('span', { class: 'muted', textContent: 'Drag the edges to pick the part you want' })),
  );

  const sheet = el('div', { class: 'sheet' });
  const pageLabel = el('span');
  const prev = el('button', { class: 'link', textContent: 'Previous', onclick: () => turn(-1) });
  const nextPage = el('button', { class: 'link', textContent: 'Next', onclick: () => turn(1) });
  const sheetPane = el('div', { class: 'sheet-pane', hidden: true }, sheet, el('div', { class: 'pager' }, prev, pageLabel, nextPage));

  const viewCtl = options<View>(
    [
      { value: 'video', label: 'Video' },
      { value: 'sheets', label: 'Sheets' },
    ],
    () => state.view,
    (v) => show(v),
  );

  function show(v: View) {
    if (v === state.view) return;
    state.view = v;
    viewCtl.sync();
    videoPane.hidden = v !== 'video';
    sheetPane.hidden = v !== 'sheets';
    if (v === 'sheets') void renderPreview();
  }

  // --- controls ---
  const fileName = el('span', { class: 'file-name' });
  const fileNote = el('p', { class: 'hint' });
  const fpsCtl = options(
    FPS_CHOICES.map((f) => ({ value: f, label: String(f) })),
    () => state.fps,
    (v) => ((state.fps = v), changed('video')),
  );
  const cropCtl = options(
    [{ value: 'original', label: 'Original' }, ...CROPS.map((c) => ({ value: c.value, label: c.value }))],
    () => state.crop,
    (v) => {
      state.crop = v;
      state.cropX = state.cropY = 0.5;
      changed('video');
    },
  );
  const cropHint = hint('Drag the picture to choose what stays in the frame.');
  const paperCtl = options(
    (['A4', 'A3', 'A5', 'LT'] as PaperId[]).map((id) => ({ value: id, label: PAPERS[id].name })),
    () => state.paper,
    (v) => ((state.paper = v), changed('sheets')),
  );
  const orientCtl = options(
    [
      { value: 'P', label: 'Portrait' },
      { value: 'L', label: 'Landscape' },
    ],
    () => (state.landscape ? 'L' : 'P'),
    (v) => ((state.landscape = v === 'L'), changed('sheets')),
  );
  const captureCtl = options<Capture>(
    [
      { value: 'scanner', label: 'Scanner' },
      { value: 'photo', label: 'Phone or tablet' },
    ],
    () => state.capture,
    (v) => ((state.capture = v), changed('sheets')),
  );
  const captureHint = hint();
  const gridCtl = options([], () => choice().count, (v) => ((state.count = v), changed('sheets')));
  const frameSizeNote = hint();
  const borderCtl = options<BorderId>(
    [
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large' },
    ],
    () => state.border,
    (v) => ((state.border = v), changed('sheets')),
  );
  const toggles: Control[] = [
    toggleRow('Thin line around each frame', () => state.style.borders, (v) => ((state.style.borders = v), changed('sheets'))),
    toggleRow('Frame numbers', () => state.style.frameNumbers, (v) => ((state.style.frameNumbers = v), changed('sheets'))),
    toggleRow('Video file name', () => state.style.fileName, (v) => ((state.style.fileName = v), changed('sheets'))),
  ];
  const download = el('button', { class: 'primary wide', textContent: 'Download PDF', onclick: () => void createPdf() });
  const summary = hint();
  const pdfNote = hint();

  const controls = sidebar(
    [
      el('div', { class: 'file' }, fileName, el('button', { class: 'link', textContent: 'Change', onclick: picker.open })),
      fileNote,
      group('Video', field('Frames per second', fpsCtl.el, hint('Animation on paper usually runs at 8 or 12.')), field('Crop', cropCtl.el, cropHint)),
      group(
        'Paper',
        field('Size', paperCtl.el),
        field('Orientation', orientCtl.el),
        field('Scan with', captureCtl.el, captureHint),
        field('Frames per sheet', gridCtl.el, frameSizeNote),
      ),
      more(
        field('White border', borderCtl.el, hint('Blank paper around each frame to paint past the edge. You can keep it in the finished video.')),
        el('div', { class: 'toggles' }, ...toggles.map((t) => t.el)),
        hint('The thin line helps photos line up when your video is white at the edges.'),
      ),
    ],
    [download, summary, pdfNote],
  );

  const work = el(
    'div',
    { class: 'work', hidden: true },
    controls,
    el('div', { class: 'view' }, el('div', { class: 'view-head' }, viewCtl.el), videoPane, sheetPane),
  );

  async function open(file: File) {
    const note = state.video ? fileNote : intakeNote;
    note.className = 'hint';
    note.textContent = 'Opening…';
    try {
      const v = await loadVideo(file);
      if (state.video) URL.revokeObjectURL(state.video.url);
      state.video = v;
      state.start = 0;
      state.end = v.duration;
      state.crop = 'original';
      state.cropX = state.cropY = 0.5;
      state.landscape = v.width >= v.height;
      state.page = 1;
      thumbs.clear();
      note.textContent = '';
      fileName.textContent = file.name;
      intake.hidden = true;
      work.hidden = false;
      show('video');
      tl.load(v);
      changed();
    } catch (e) {
      note.className = 'warn';
      note.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  // --- sheet preview ---
  function turn(d: number) {
    state.page = Math.max(1, Math.min(pageCount(spec(), frameCount()), state.page + d));
    void renderPreview();
  }

  const thumbs = new Map<string, string>();
  const thumbKey = (i: number) => `${state.start}|${state.fps}|${aspect().toFixed(4)}|${state.cropX}|${state.cropY}|${i}`;
  let previewRun = 0;

  async function renderPreview() {
    const run = ++previewRun;
    const s = spec();
    if (validateSpec(s)) return;
    const layout = computeLayout(s);
    const n = frameCount();
    const pages = pageCount(s, n);
    state.page = Math.min(state.page, pages);
    pageLabel.textContent = `Sheet ${state.page} of ${pages}`;
    prev.disabled = state.page <= 1;
    nextPage.disabled = state.page >= pages;

    const draw = async () => {
      const svg = await renderSheetSvg(
        layout,
        { version: s.version ?? LAYOUT_VERSION, projectId: state.projectId, page: state.page, pages, spec: s, fps: state.fps, frameCount: n },
        state.style,
        state.video?.file.name,
        (i) => thumbs.get(thumbKey(i)),
      );
      if (run === previewRun) sheet.replaceChildren(svg);
    };
    await draw();

    const v = state.video;
    if (!v) return;
    const first = (state.page - 1) * framesPerPage(s);
    const wanted = [...Array(Math.min(framesPerPage(s), n - first, 60)).keys()].map((k) => first + k);
    const missing = wanted.filter((i) => !thumbs.has(thumbKey(i)));
    if (!missing.length) return;
    await new Promise((r) => setTimeout(r, 200)); // settle while things move
    if (run !== previewRun) return;
    const grab = await frameGrabber(v, state.start, state.fps, crop(), 240);
    for (const i of missing) {
      if (run !== previewRun) return;
      thumbs.set(thumbKey(i), await grab.dataUrl(i));
    }
    await draw();
  }

  // --- updates ---
  /** `from` says which part was touched, so the view can follow. */
  function changed(from?: View) {
    const v = state.video;
    if (!v) return;
    if (from) show(from);
    const s = spec();
    const n = frameCount();
    const pages = pageCount(s, n);

    for (const c of [fpsCtl, cropCtl, paperCtl, orientCtl, captureCtl, borderCtl, ...toggles]) c.sync();
    captureHint.textContent =
      state.capture === 'photo'
        ? 'Small squares between the frames keep photos of curved or painted paper in line.'
        : 'Only the four corners get printed. Photos work too, as long as the paper lies flat.';
    cropHint.hidden = state.crop === 'original';
    gridCtl.setOptions(choices().map((c) => ({ value: c.count, label: String(c.count) })));
    frameSizeNote.textContent = `Each frame ${s.frameW} × ${Math.round(s.frameW / s.aspect)} mm`;

    tl.sync();
    rangeLabel.textContent = `${fmtTime(state.start)} – ${fmtTime(state.end)} · ${plural(n, 'frame', 'frames')}`;
    view.set({ video: v, start: state.start, end: state.end, fps: state.fps, crop: crop() });

    const err = validateSpec(s);
    download.disabled = !!err || state.busy;
    summary.className = err ? 'warn' : 'hint';
    summary.textContent =
      err ?? `${plural(n, 'frame', 'frames')} on ${plural(pages, 'sheet', 'sheets')} · ${PAPERS[s.paper].name} ${s.landscape ? 'landscape' : 'portrait'}`;
    if (last && last.key !== pdfKey()) pdfNote.textContent = '';
    if (state.view === 'sheets') void renderPreview();
  }

  async function createPdf() {
    const v = state.video;
    const s = spec();
    if (!v || validateSpec(s) || state.busy) return;
    const key = pdfKey();
    if (last?.key === key) return saveFile(last.url, last.name);
    // a new PDF is a new project, so sheets of two runs can't get mixed up
    if (last) {
      state.projectId = newProjectId();
      if (state.view === 'sheets') void renderPreview();
    }
    state.busy = true;
    download.disabled = true;
    pdfNote.className = 'hint';
    const n = frameCount();
    const id = state.projectId;
    try {
      const grab = await frameGrabber(v, state.start, state.fps, crop(), (s.frameW / 25.4) * 300); // ~300 dpi
      const bytes = await buildSheetsPdf({
        spec: s,
        style: state.style,
        projectId: id,
        fps: state.fps,
        frameCount: n,
        title: v.file.name,
        start: state.start,
        getFrame: (i) => grab.jpeg(i),
        onProgress: (done, total) => (download.textContent = `Preparing frame ${done} of ${total}`),
      });
      if (last) URL.revokeObjectURL(last.url);
      last = { key, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })), name: `papr-${id}.pdf` };
      saveFile(last.url, last.name);
      pdfNote.textContent = `${last.name} · ${mb(bytes.length)}. Print at 100 % or fit to page.`;
      printed.set(id, { video: v, start: state.start });
    } catch (e) {
      pdfNote.className = 'warn';
      pdfNote.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      state.busy = false;
      download.textContent = 'Download PDF';
      download.disabled = false;
    }
  }

  const page = el('section', { class: 'page' }, intake, work);
  dropTarget(page, 'video/*', false, (f) => void open(f[0]));
  return { el: page, open, state };
}

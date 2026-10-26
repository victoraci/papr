// Print: videos → printable sheets, in two steps. 1 Video: drop videos, cut
// them together on the timeline, pick the frame rate and crop. 2 Paper:
// everything about the sheets, then download the PDF. Both steps can be
// opened at any time.

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
import { clipLength, frameAt, frameCount as countFrames, history, insert, newClip, sequenceGrabber, setCrop, type Clip } from './sequence.ts';
import { timeline } from './timeline.ts';
import { dropTarget, el, field, filePicker, group, hint, mb, more, options, plural, saveFile, sidebar, steps, toggleRow, type Control } from './ui.ts';
import { loadVideo } from './video.ts';
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

export function printPanel() {
  const state = {
    fps: 12,
    crop: 'original',
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
  /** The edit, with undo. While a clip edge is dragged, `draft` shows the edit in progress. */
  const edit = history();
  let draft: Clip[] | null = null;
  const clips = () => draft ?? edit.get();

  // --- derived ---
  const aspect = () => {
    const c = CROPS.find((x) => x.value === state.crop);
    if (c) return c.ratio;
    const first = clips()[0];
    return first ? first.video.width / first.video.height : 16 / 9;
  };
  const version = () => (state.capture === 'photo' ? PHOTO_LAYOUT : LAYOUT_VERSION);
  const gap = () => gapForBorder(BORDERS[state.border], version());
  const choices = (): GridChoice[] => spread(gridChoices(state.paper, state.landscape, aspect(), gap(), 20, version()), MAX_GRID_OPTIONS);
  const choice = (): GridChoice => {
    const list = choices();
    return list.reduce((best, c) => (Math.abs(c.count - state.count) < Math.abs(best.count - state.count) ? c : best), list[0]);
  };
  const spec = (): SheetSpec => specForGrid(state.paper, state.landscape, aspect(), gap(), choice(), version());
  const frameCount = () => Math.max(1, countFrames(clips(), state.fps));
  const pdfKey = () =>
    JSON.stringify([clips().map((c) => [c.video.url, c.from, c.to, c.cropX, c.cropY]), state.fps, aspect(), spec(), state.style]);
  const videoNames = () => [...new Set(clips().map((c) => c.video.file.name))];
  const title = () => {
    const names = videoNames();
    return names.length > 1 ? `${names[0]} + ${names.length - 1} more` : names[0];
  };

  // --- before a video is in ---
  const picker = filePicker('video/*', true, (f) => void addVideos(f));
  const intakeNote = el('p', { class: 'hint' });
  const intake = el(
    'div',
    { class: 'intake' },
    el('h1', { textContent: 'Drop a video here' }),
    el('button', { class: 'primary', textContent: 'Choose a video', onclick: picker.open }),
    intakeNote,
  );

  // --- view: video or sheets ---
  const view = videoView({
    clips,
    fps: () => state.fps,
    aspect,
    onCrop(id, x, y, done) {
      const next = setCrop(edit.get(), id, x, y);
      draft = done ? null : next;
      if (done) edit.push(next);
      if (done) changed('video');
    },
    onTime: () => tl.tick(),
    onPlay: () => tl.sync(),
  });
  const tl = timeline({
    clips,
    fps: () => state.fps,
    commit(next) {
      draft = null;
      edit.push(next);
      edited();
    },
    preview(next) {
      draft = next;
      edited();
    },
    undo: () => edit.undo() && edited(),
    redo: () => edit.redo() && edited(),
    canUndo: edit.canUndo,
    canRedo: edit.canRedo,
    time: () => view.time(),
    seek(t) {
      view.seek(t);
      tl.sync();
    },
    playing: () => view.playing(),
    togglePlay() {
      view.toggle();
      tl.sync();
    },
    pickVideos: () => picker.open(),
    dropVideos: (files, at) => void addVideos(files, at),
  });
  const videoPane = el('div', { class: 'video-pane' }, view.el, tl.el);

  function edited() {
    view.refresh();
    changed('video');
  }

  const sheet = el('div', { class: 'sheet' });
  const pageLabel = el('span');
  const prev = el('button', { class: 'link', textContent: 'Previous', onclick: () => turn(-1) });
  const nextPage = el('button', { class: 'link', textContent: 'Next', onclick: () => turn(1) });
  const sheetPane = el('div', { class: 'sheet-pane', hidden: true }, sheet, el('div', { class: 'pager' }, prev, pageLabel, nextPage));

  const stepCtl = steps<View>(
    [
      { value: 'video', label: 'Video' },
      { value: 'sheets', label: 'Paper' },
    ],
    () => state.view,
    (v) => show(v),
  );

  /** Opens a step: its settings on the side, its picture in the view. */
  function show(v: View) {
    if (v === state.view) return;
    state.view = v;
    stepCtl.sync();
    videoPane.hidden = v !== 'video';
    sheetPane.hidden = v !== 'sheets';
    for (const part of videoParts) part.hidden = v !== 'video';
    for (const part of paperParts) part.hidden = v !== 'sheets';
    if (v === 'video') view.refresh();
    else {
      view.pause();
      void renderPreview();
    }
    tl.sync();
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
      edit.replace(edit.get().map((c) => ({ ...c, cropX: 0.5, cropY: 0.5 })));
      view.refresh();
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
  const next = el('button', { class: 'primary wide', textContent: 'Next: Paper', onclick: () => show('sheets') });
  const videoSummary = hint();

  // each step has its own settings and button; the other step's are hidden
  const part = (...children: (HTMLElement | null)[]) => el('div', { class: 'step-part' }, ...children);
  const videoParts = [
    part(
      el('div', { class: 'file' }, fileName, el('button', { class: 'link', textContent: 'Add video', onclick: picker.open })),
      fileNote,
      group('Video', field('Frames per second', fpsCtl.el, hint('Animation on paper usually runs at 8 or 12.')), field('Crop', cropCtl.el, cropHint)),
    ),
    part(next, videoSummary),
  ];
  const paperParts = [
    part(
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
    ),
    part(download, summary, pdfNote),
  ];
  for (const p of paperParts) p.hidden = true;
  const controls = sidebar([videoParts[0], paperParts[0]], [videoParts[1], paperParts[1]]);

  const work = el(
    'div',
    { class: 'work', hidden: true },
    controls,
    el('div', { class: 'view' }, el('div', { class: 'view-head' }, stepCtl.el), videoPane, sheetPane),
  );

  /** New videos go to the end of the edit, or where they were dropped on the timeline. */
  async function addVideos(files: File[], at?: number) {
    const first = !edit.get().length;
    const note = first ? intakeNote : fileNote;
    note.className = 'hint';
    note.textContent = files.length > 1 ? `Opening ${files.length} videos…` : 'Opening…';
    const added: Clip[] = [];
    const errors: string[] = [];
    for (const f of files) {
      try {
        added.push(newClip(await loadVideo(f)));
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    note.className = errors.length ? 'warn' : 'hint';
    note.textContent = errors.join(' ');
    if (!added.length) return;
    const next = insert(edit.get(), at ?? edit.get().length, added);
    if (first) {
      edit.reset(next);
      state.crop = 'original';
      state.landscape = added[0].video.width >= added[0].video.height;
      state.page = 1;
      thumbs.clear();
      view.seek(0);
    } else edit.push(next);
    intake.hidden = true;
    work.hidden = false;
    show('video');
    tl.fit();
    edited();
  }

  // --- keyboard, like in an editor ---
  document.addEventListener('keydown', (e) => {
    // editing keys belong to the video step
    if (page.hidden || work.hidden || state.busy || state.view !== 'video') return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const step = (d: number) => view.seek(Math.max(0, view.time() + d));
    if (k === ' ') view.toggle();
    else if ((k === 's' && !mod) || (mod && (k === 'b' || k === 'k'))) tl.split();
    else if (k === 'backspace' || k === 'delete') tl.deleteSelected();
    else if (mod && k === 'z') (e.shiftKey ? edit.redo() : edit.undo()) && edited();
    else if (mod && k === 'y') edit.redo() && edited();
    else if (k === 'arrowleft') step(-(e.shiftKey ? 1 : 1 / state.fps));
    else if (k === 'arrowright') step(e.shiftKey ? 1 : 1 / state.fps);
    else if (k === 'home') view.seek(0);
    else if (k === 'end') view.seek(Math.max(0, frameCount() - 1) / state.fps);
    else if (k === '+' || k === '=') tl.zoomBy(1.6);
    else if (k === '-') tl.zoomBy(1 / 1.6);
    else return;
    e.preventDefault();
    tl.sync();
  });

  // --- sheet preview ---
  function turn(d: number) {
    state.page = Math.max(1, Math.min(pageCount(spec(), frameCount()), state.page + d));
    void renderPreview();
  }

  const thumbs = new Map<string, string>();
  const thumbKey = (i: number) => {
    const { clip, source } = frameAt(clips(), state.fps, i);
    return `${clip.video.url}|${source.toFixed(3)}|${aspect().toFixed(4)}|${clip.cropX}|${clip.cropY}`;
  };
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
        title(),
        (i) => thumbs.get(thumbKey(i)),
      );
      if (run === previewRun) sheet.replaceChildren(svg);
    };
    await draw();

    if (!clips().length) return;
    const first = (state.page - 1) * framesPerPage(s);
    const wanted = [...Array(Math.min(framesPerPage(s), n - first, 60)).keys()].map((k) => first + k);
    const missing = wanted.filter((i) => !thumbs.has(thumbKey(i)));
    if (!missing.length) return;
    await new Promise((r) => setTimeout(r, 200)); // settle while things move
    if (run !== previewRun) return;
    const grab = await sequenceGrabber(clips(), state.fps, aspect(), 240);
    for (const i of missing) {
      if (run !== previewRun) return;
      thumbs.set(thumbKey(i), await grab.dataUrl(i));
    }
    await draw();
  }

  // --- updates ---
  /** `from` says which part was touched, so the view can follow. */
  function changed(from?: View) {
    if (work.hidden) return;
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
    const names = videoNames();
    fileName.textContent = names.length > 1 ? `${names.length} videos` : (names[0] ?? 'No video');
    fileName.title = names.join(', ');

    const err = clips().length ? validateSpec(s) : 'Add a video to make sheets.';
    download.disabled = !!err || state.busy;
    next.disabled = !clips().length;
    videoSummary.textContent = clips().length
      ? `${plural(n, 'frame', 'frames')} · ${(n / state.fps).toFixed(1)} s at ${state.fps} fps`
      : 'Add a video to start.';
    summary.className = err ? 'warn' : 'hint';
    summary.textContent =
      err ?? `${plural(n, 'frame', 'frames')} on ${plural(pages, 'sheet', 'sheets')} · ${PAPERS[s.paper].name} ${s.landscape ? 'landscape' : 'portrait'}`;
    if (last && last.key !== pdfKey()) pdfNote.textContent = '';
    if (state.view === 'sheets') void renderPreview();
  }

  async function createPdf() {
    const list = edit.get();
    const s = spec();
    if (!list.length || validateSpec(s) || state.busy) return;
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
      const grab = await sequenceGrabber(list, state.fps, aspect(), (s.frameW / 25.4) * 300); // ~300 dpi
      const bytes = await buildSheetsPdf({
        spec: s,
        style: state.style,
        projectId: id,
        fps: state.fps,
        frameCount: n,
        title: title(),
        // the QR code can only say where one uncut piece starts in its video
        start: list.length === 1 ? list[0].from : undefined,
        getFrame: (i) => grab.jpeg(i),
        onProgress: (done, total) => (download.textContent = `Preparing frame ${done} of ${total}`),
      });
      if (last) URL.revokeObjectURL(last.url);
      last = { key, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })), name: `papr-${id}.pdf` };
      saveFile(last.url, last.name);
      pdfNote.textContent = `${last.name} · ${mb(bytes.length)}. Print at 100 % or fit to page.`;
      printed.set(id, { pieces: list.map((c) => ({ file: c.video.file, start: c.from, length: clipLength(c) })) });
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
  dropTarget(page, 'video/*', true, (f) => void addVideos(f));
  return { el: page, open: (f: File) => addVideos([f]), addVideos, state, clips };
}

// Print panel: video → sheets, one step at a time, with the sheet as preview.

import {
  computeLayout,
  FRAME_MIN,
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
import type { SheetStyle } from '../core/sheet.ts';
import { renderSheetSvg } from './preview.ts';
import { cards, dropZone, el, mb, plural, segmented, slider, stepper, toggleRow, type Control } from './ui.ts';
import { frameGrabber, loadVideo, type LoadedVideo } from './video.ts';

const RATIOS: { value: string; label: string; ratio: number }[] = [
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  { value: '4:3', label: '4:3', ratio: 4 / 3 },
  { value: '1:1', label: '1:1', ratio: 1 },
  { value: '4:5', label: '4:5', ratio: 4 / 5 },
  { value: '9:16', label: '9:16', ratio: 9 / 16 },
  { value: '2.39:1', label: '2.39:1', ratio: 2.39 },
];
const GAP_UI_MAX = 20;
const FRAME_UI_MIN = 20;

function ratioName(r: number): string {
  const near = RATIOS.find((a) => Math.abs(a.ratio - r) < 0.01);
  return near ? near.label : `${r.toFixed(2)}:1`;
}

export function printPanel() {
  const state = {
    video: null as LoadedVideo | null,
    paper: 'A4' as PaperId,
    landscape: true,
    shape: 'video' as 'video' | 'other',
    ratio: '1:1',
    frameW: 60,
    gap: 8,
    fps: 12,
    start: 0,
    end: 0,
    style: { borders: false, frameNumbers: true, sheetNumber: true, fileName: true } as SheetStyle,
    projectId: newProjectId(),
    step: 0,
    page: 1,
    pdfUrl: '',
  };

  const aspect = () => {
    if (state.shape === 'other') return RATIOS.find((r) => r.value === state.ratio)!.ratio;
    return state.video ? state.video.width / state.video.height : 16 / 9;
  };
  const spec = (): SheetSpec => makeSpec(state.paper, state.landscape, aspect(), state.frameW, state.gap);
  // without a video the preview shows one full sheet of empty frames
  const frameCount = () => (state.video ? Math.max(1, Math.floor((state.end - state.start) * state.fps + 1e-6)) : framesPerPage(spec()));
  const maxW = () => maxFrameWidth(state.paper, state.landscape, aspect(), state.gap);

  /** Biggest frames that still give at least 9 per sheet. */
  const defaultFrameWidth = () => {
    for (let w = maxW(); w > FRAME_MIN; w--) {
      const s = makeSpec(state.paper, state.landscape, aspect(), w, state.gap);
      if (s.cols * s.rows >= 9) return w;
    }
    return maxW();
  };
  const refit = () => {
    state.frameW = defaultFrameWidth();
    state.page = 1;
  };

  // --- step 1: video ---
  const drop = dropZone('Drop a video here or click to choose one', 'video/*', false, (f) => void open(f[0]));
  const videoInfo = el('p', { class: 'muted' });
  const player = el('video', { controls: true, muted: true, loop: true, playsInline: true, hidden: true });
  const startCtl = slider(
    'Start',
    { min: () => 0, max: () => +(state.video?.duration ?? 1).toFixed(1), step: 0.1 },
    () => state.start,
    (v) => {
      state.start = Math.min(v, state.end - 0.1);
      changed();
    },
    () => `${state.start.toFixed(1)} s`,
  );
  const endCtl = slider(
    'End',
    { min: () => 0, max: () => +(state.video?.duration ?? 1).toFixed(1), step: 0.1 },
    () => state.end,
    (v) => {
      state.end = Math.max(v, state.start + 0.1);
      changed();
    },
    () => `${state.end.toFixed(1)} s`,
  );
  const section = el('div', { class: 'stack', hidden: true }, startCtl.el, endCtl.el);

  async function open(file: File) {
    videoInfo.className = 'muted';
    videoInfo.textContent = 'Opening…';
    try {
      const v = await loadVideo(file);
      if (state.video) URL.revokeObjectURL(state.video.url);
      state.video = v;
      state.start = 0;
      state.end = +v.duration.toFixed(1);
      state.shape = 'video';
      state.landscape = v.width >= v.height;
      refit();
      thumbs.clear();
      videoInfo.textContent = `${file.name} · ${v.duration.toFixed(1)} s`;
      drop.label.textContent = 'Choose another video';
      player.src = v.url;
      player.hidden = false;
      section.hidden = false;
      shapeCtl = buildShapeCards();
      shapeSlot.replaceChildren(shapeCtl.el);
      changed();
    } catch (e) {
      videoInfo.className = 'warn';
      videoInfo.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  // --- step 2: paper ---
  const paperCtl = cards(
    (Object.keys(PAPERS) as PaperId[])
      .sort((a, b) => ['A4', 'A3', 'A5', 'LT'].indexOf(a) - ['A4', 'A3', 'A5', 'LT'].indexOf(b))
      .map((id) => ({ value: id, title: PAPERS[id].name, hint: id === 'LT' ? '8.5 × 11 in' : `${PAPERS[id].w} × ${PAPERS[id].h} mm` })),
    () => state.paper,
    (v) => {
      state.paper = v;
      refit();
      changed();
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
      refit();
      changed();
    },
  );

  // --- step 3: frame shape ---
  const ratioCtl = segmented(
    RATIOS.map((r) => ({ value: r.value, label: r.label })),
    () => state.ratio,
    (v) => {
      state.ratio = v;
      refit();
      changed();
    },
  );
  ratioCtl.el.classList.add('grid3');
  const ratioWrap = el('div', { hidden: true }, ratioCtl.el);
  const buildShapeCards = () =>
    cards(
      [
        { value: 'video' as const, title: 'Same as the video', hint: state.video ? ratioName(state.video.width / state.video.height) : 'Keeps the original shape' },
        { value: 'other' as const, title: 'Another shape', hint: 'The video gets cropped to fit' },
      ],
      () => state.shape,
      (v) => {
        state.shape = v;
        refit();
        changed();
      },
    );
  let shapeCtl = buildShapeCards();
  const shapeSlot = el('div', {}, shapeCtl.el);

  // --- step 4: size and speed ---
  const fpsCtl = stepper('Frames per second', { min: 1, max: 30 }, () => state.fps, (v) => ((state.fps = v), changed()), () =>
    state.video ? plural(frameCount(), 'frame', 'frames') + ' in total' : '',
  );
  const sizeCtl = slider(
    'Frame size',
    { min: () => Math.min(FRAME_UI_MIN, maxW()), max: maxW, step: 1 },
    () => state.frameW,
    (v) => ((state.frameW = v), changed()),
    () => `${state.frameW} mm wide · ${framesPerPage(spec())} per sheet`,
  );
  const gapCtl = slider(
    'Space between frames',
    { min: () => GAP_MIN, max: () => GAP_UI_MAX, step: 1 },
    () => state.gap,
    (v) => {
      state.gap = v;
      state.frameW = Math.min(state.frameW, maxW());
      changed();
    },
    () => `${state.gap} mm`,
  );

  // --- step 5: extras ---
  const extras: Control[] = [
    toggleRow('Frame borders', () => state.style.borders, (v) => ((state.style.borders = v), changed())),
    toggleRow('Frame numbers', () => state.style.frameNumbers, (v) => ((state.style.frameNumbers = v), changed())),
    toggleRow('Sheet number', () => state.style.sheetNumber, (v) => ((state.style.sheetNumber = v), changed())),
    toggleRow('File name', () => state.style.fileName, (v) => ((state.style.fileName = v), changed())),
  ];

  // --- step 6: print ---
  const summary = el('div', { class: 'summary' });
  const pdfLink = el('a', { class: 'button primary wide', hidden: true });
  const pdfNote = el('p', { class: 'muted' });

  const steps: { title: string; body: Node[]; ready?: () => boolean }[] = [
    { title: 'Pick a video', body: [drop.el, videoInfo, player, section], ready: () => !!state.video },
    { title: 'Choose your paper', body: [paperCtl.el, orientCtl.el] },
    { title: 'Choose a frame shape', body: [shapeSlot, ratioWrap] },
    { title: 'Set size and speed', body: [fpsCtl.el, sizeCtl.el, gapCtl.el] },
    { title: 'Choose what else is printed', body: [el('div', { class: 'toggles' }, ...extras.map((c) => c.el))] },
    { title: 'Print your sheets', body: [summary, pdfLink, pdfNote] },
  ];

  // --- sidebar shell ---
  const title = el('h2');
  const body = el('div', { class: 'step-body' });
  const progress = el('div', { class: 'progress' });
  const segs = steps.map((_, i) =>
    el('button', {
      ariaLabel: `Step ${i + 1}`,
      onclick: () => {
        if (state.video || i === 0) go(i);
      },
    }),
  );
  progress.append(...segs);
  const back = el('button', { textContent: 'Back', onclick: () => go(state.step - 1) });
  const next = el('button', { class: 'primary', textContent: 'Next' });
  next.onclick = () => (state.step === steps.length - 1 ? void createPdf() : go(state.step + 1));

  function go(i: number) {
    state.step = Math.max(0, Math.min(steps.length - 1, i));
    renderStep();
  }

  function renderStep() {
    const s = steps[state.step];
    title.textContent = s.title;
    body.replaceChildren(...s.body);
    segs.forEach((b, i) => b.classList.toggle('done', i <= state.step));
    back.disabled = state.step === 0;
    next.textContent = state.step === steps.length - 1 ? 'Create PDF' : 'Next';
    next.disabled = !(s.ready?.() ?? true);
  }

  // --- stage: sheet preview ---
  const sheet = el('div', { class: 'sheet' });
  const pageLabel = el('span', { class: 'muted' });
  const prev = el('button', { class: 'round', textContent: '‹', ariaLabel: 'Previous sheet', onclick: () => turn(-1) });
  const nextPage = el('button', { class: 'round', textContent: '›', ariaLabel: 'Next sheet', onclick: () => turn(1) });
  const pager = el('div', { class: 'pager' }, prev, pageLabel, nextPage);

  function turn(d: number) {
    state.page = Math.max(1, Math.min(pageCount(spec(), frameCount()), state.page + d));
    void renderPreview();
  }

  const thumbs = new Map<string, string>();
  const thumbKey = (i: number) => `${state.start}|${state.fps}|${aspect().toFixed(4)}|${i}`;
  let previewRun = 0;

  async function renderPreview() {
    const run = ++previewRun;
    const s = spec();
    if (validateSpec(s)) return;
    const layout = computeLayout(s);
    const n = frameCount();
    const pages = pageCount(s, n);
    state.page = Math.min(state.page, pages);
    pageLabel.textContent = `${state.page} / ${pages}`;
    prev.disabled = state.page <= 1;
    nextPage.disabled = state.page >= pages;

    const draw = async () => {
      const svg = await renderSheetSvg(
        layout,
        { version: LAYOUT_VERSION, projectId: state.projectId, page: state.page, pages, spec: s, fps: state.fps, frameCount: n },
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
    await new Promise((r) => setTimeout(r, 200)); // settle while sliders move
    if (run !== previewRun) return;
    const grab = await frameGrabber(v, state.start, state.fps, aspect(), 240);
    for (const i of missing) {
      if (run !== previewRun) return;
      thumbs.set(thumbKey(i), await grab.dataUrl(i));
    }
    await draw();
  }

  // --- updates ---
  function changed() {
    for (const c of [startCtl, endCtl, paperCtl, orientCtl, ratioCtl, shapeCtl, fpsCtl, sizeCtl, gapCtl, ...extras]) c.sync();
    ratioWrap.hidden = state.shape !== 'other';
    const s = spec();
    const n = frameCount();
    const pages = pageCount(s, n);
    const err = validateSpec(s);
    summary.replaceChildren(
      ...(err
        ? [el('p', { class: 'warn', textContent: err })]
        : [
            el('p', { textContent: `${plural(n, 'frame', 'frames')} on ${plural(pages, 'sheet', 'sheets')}` }),
            el('p', {
              class: 'muted',
              textContent: `${PAPERS[s.paper].name} ${s.landscape ? 'landscape' : 'portrait'} · frames ${s.frameW} mm wide · ${state.fps} frames per second`,
            }),
          ]),
    );
    pdfLink.hidden = true;
    pdfNote.textContent = '';
    renderStep();
    void renderPreview();
  }

  async function createPdf() {
    const v = state.video;
    const s = spec();
    if (!v || validateSpec(s)) return;
    next.disabled = true;
    pdfLink.hidden = true;
    const n = frameCount();
    const id = state.projectId;
    try {
      const grab = await frameGrabber(v, state.start, state.fps, s.aspect, (s.frameW / 25.4) * 300); // ~300 dpi
      const bytes = await buildSheetsPdf({
        spec: s,
        style: state.style,
        projectId: id,
        fps: state.fps,
        frameCount: n,
        title: v.file.name,
        getFrame: (i) => grab.jpeg(i),
        onProgress: (done, total) => (pdfNote.textContent = `Preparing frame ${done} of ${total}`),
      });
      if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
      state.pdfUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      pdfLink.href = state.pdfUrl;
      pdfLink.download = `rotopaper-${id}.pdf`;
      pdfLink.textContent = `Download PDF · ${mb(bytes.length)}`;
      pdfLink.hidden = false;
      pdfNote.textContent = 'Print at 100 % or fit to page.';
      // a new PDF is a new project, so sheets of two runs can't get mixed up
      state.projectId = newProjectId();
    } catch (e) {
      pdfNote.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      next.disabled = false;
    }
  }

  const panel = el(
    'div',
    { class: 'panel' },
    el('aside', { class: 'side' }, el('div', { class: 'side-scroll' }, title, body), el('div', { class: 'side-foot' }, progress, el('div', { class: 'nav' }, back, next))),
    el('div', { class: 'stage' }, sheet, pager),
  );
  changed();
  return { el: panel, open, state };
}

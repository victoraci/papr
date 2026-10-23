// Print panel: video → sheets in five steps. The stage on the right shows
// what the current step is about: the moving video, the crop, or the sheet.

import {
  BORDERS,
  computeLayout,
  gapForBorder,
  gridChoices,
  LAYOUT_VERSION,
  PAPERS,
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
import { cropView } from './cropview.ts';
import { printed } from './session.ts';
import { renderSheetSvg } from './preview.ts';
import { steppedPlayer } from './stepped.ts';
import { timeline } from './timeline.ts';
import { cards, chips, dropZone, el, mb, plural, segmented, toggleRow, type Control } from './ui.ts';
import { frameGrabber, loadVideo, type Crop, type LoadedVideo } from './video.ts';

const FPS_CHOICES = [6, 8, 12, 15, 24];
const CROPS: { value: string; ratio: number }[] = [
  { value: '1:1', ratio: 1 },
  { value: '4:5', ratio: 4 / 5 },
  { value: '9:16', ratio: 9 / 16 },
  { value: '16:9', ratio: 16 / 9 },
  { value: '4:3', ratio: 4 / 3 },
];
const MAX_GRID_OPTIONS = 8;

/** Up to `max` options, spread evenly over the list. */
function spread<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  return [...new Set([...Array(max).keys()].map((i) => Math.round((i * (list.length - 1)) / (max - 1))))].map((i) => list[i]);
}

function ratioIcon(ratio: number) {
  const box = el('span', { class: 'ratio-icon' });
  const r = el('span');
  // fit a 22 × 22 box
  r.style.width = `${ratio >= 1 ? 22 : 22 * ratio}px`;
  r.style.height = `${ratio >= 1 ? 22 / ratio : 22}px`;
  box.append(r);
  return box;
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
    count: 9,
    border: 'none' as BorderId,
    style: { borders: false, frameNumbers: true, fileName: true } as SheetStyle,
    projectId: newProjectId(),
    step: 0,
    page: 1,
    pdfUrl: '',
  };

  // --- derived ---
  const aspect = () => {
    const c = CROPS.find((x) => x.value === state.crop);
    if (c) return c.ratio;
    return state.video ? state.video.width / state.video.height : 16 / 9;
  };
  const crop = (): Crop => ({ aspect: aspect(), x: state.cropX, y: state.cropY });
  const gap = () => gapForBorder(BORDERS[state.border]);
  const choices = (): GridChoice[] => spread(gridChoices(state.paper, state.landscape, aspect(), gap()), MAX_GRID_OPTIONS);
  const choice = (): GridChoice => {
    const list = choices();
    return list.reduce((best, c) => (Math.abs(c.count - state.count) < Math.abs(best.count - state.count) ? c : best), list[0]);
  };
  const spec = (): SheetSpec => specForGrid(state.paper, state.landscape, aspect(), gap(), choice());
  // without a video the preview shows one full sheet of empty frames
  const frameCount = () => (state.video ? Math.max(1, Math.floor((state.end - state.start) * state.fps + 1e-6)) : framesPerPage(spec()));

  // --- step 1: video ---
  const drop = dropZone('Drop a video here or click to choose one', 'video/*', false, (f) => void open(f[0]));
  const videoName = el('p', { class: 'muted' });
  const fpsCtl = chips(
    FPS_CHOICES.map((f) => ({ value: f, label: String(f) })),
    () => state.fps,
    (v) => ((state.fps = v), changed()),
    5,
  );
  const fpsBlock = el(
    'div',
    { class: 'stack', hidden: true },
    el('span', { textContent: 'Frames per second' }),
    fpsCtl.el,
    el('p', { class: 'muted small', textContent: 'Animation on paper usually runs at 8 or 12.' }),
  );
  const videoSummary = el('p', { class: 'muted' });

  const player = steppedPlayer((t) => tl.setPlayhead(t));
  const tl = timeline(
    () => ({ start: state.start, end: state.end }),
    (r) => {
      state.start = r.start;
      state.end = r.end;
      changed();
    },
    () => 2 / state.fps,
  );
  const tlLabel = el('div', { class: 'tl-label' });
  const videoStage = el('div', { class: 'video-stage' }, player.el, tl.el, tlLabel);
  const videoEmpty = el('p', { class: 'muted', textContent: 'Your video shows up here.' });

  async function open(file: File) {
    videoName.className = 'muted';
    videoName.textContent = 'Opening…';
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
      videoName.textContent = file.name;
      drop.label.textContent = 'Choose another video';
      fpsBlock.hidden = false;
      tl.load(v);
      changed();
      renderStage();
    } catch (e) {
      videoName.className = 'warn';
      videoName.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  // --- step 2: crop ---
  const cropCtl = chips(
    [
      { value: 'original', label: 'Original', icon: () => ratioIcon(state.video ? state.video.width / state.video.height : 16 / 9) },
      ...CROPS.map((c) => ({ value: c.value, label: c.value, icon: () => ratioIcon(c.ratio) })),
    ],
    () => state.crop,
    (v) => {
      state.crop = v;
      state.cropX = state.cropY = 0.5;
      changed();
    },
    3,
  );
  const cropHint = el('p', { class: 'muted small', textContent: 'Drag the picture to choose what stays in the frame.' });
  const cropper = cropView(crop, (c) => {
    state.cropX = c.x;
    state.cropY = c.y;
    changed();
  });

  // --- step 3: paper ---
  const paperCtl = cards(
    (['A4', 'A3', 'A5', 'LT'] as PaperId[]).map((id) => ({
      value: id,
      title: PAPERS[id].name,
      hint: id === 'LT' ? '8.5 × 11 in' : `${PAPERS[id].w} × ${PAPERS[id].h} mm`,
    })),
    () => state.paper,
    (v) => ((state.paper = v), changed()),
  );
  const orientCtl = segmented(
    [
      { value: 'P', label: 'Portrait' },
      { value: 'L', label: 'Landscape' },
    ],
    () => (state.landscape ? 'L' : 'P'),
    (v) => ((state.landscape = v === 'L'), changed()),
  );
  orientCtl.el.classList.add('grid2');

  // --- step 4: layout ---
  const gridCtl = chips([], () => choice().count, (v) => ((state.count = v), changed()), 4);
  const frameSizeNote = el('p', { class: 'muted small' });
  const borderCtl = segmented(
    [
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large' },
    ],
    () => state.border,
    (v) => ((state.border = v), changed()),
  );
  borderCtl.el.classList.add('grid3');
  const outlineCtl = toggleRow('Thin line around each frame', () => state.style.borders, (v) => ((state.style.borders = v), changed()));

  // --- step 5: print ---
  const summary = el('div', { class: 'summary' });
  const labels: Control[] = [
    toggleRow('Frame numbers', () => state.style.frameNumbers, (v) => ((state.style.frameNumbers = v), changed())),
    toggleRow('Video file name', () => state.style.fileName, (v) => ((state.style.fileName = v), changed())),
  ];
  const pdfLink = el('a', { class: 'button primary wide', hidden: true });
  const pdfNote = el('p', { class: 'muted' });

  const label = (t: string) => el('span', { textContent: t });
  const steps: { title: string; hint?: () => string; body: Node[]; stage: 'video' | 'crop' | 'sheet' }[] = [
    { title: 'Video', body: [drop.el, videoName, fpsBlock, videoSummary], stage: 'video' },
    { title: 'Crop', hint: () => 'The shape your frames get on paper and in the finished video.', body: [cropCtl.el, cropHint], stage: 'crop' },
    { title: 'Paper', body: [paperCtl.el, orientCtl.el], stage: 'sheet' },
    {
      title: 'Layout',
      body: [
        el('div', { class: 'stack' }, label('Frames per sheet'), gridCtl.el, frameSizeNote),
        el(
          'div',
          { class: 'stack' },
          label('White border'),
          borderCtl.el,
          el('p', { class: 'muted small', textContent: 'Blank paper around each frame to paint past the edge. You can keep it in the finished video.' }),
        ),
        outlineCtl.el,
      ],
      stage: 'sheet',
    },
    { title: 'Print', body: [summary, el('div', { class: 'stack' }, label('Printed next to the frames'), el('div', { class: 'toggles' }, ...labels.map((c) => c.el))), pdfLink, pdfNote], stage: 'sheet' },
  ];

  // --- sidebar shell ---
  const title = el('h2');
  const stepHint = el('p', { class: 'muted small' });
  const body = el('div', { class: 'step-body' });
  const progress = el('div', { class: 'progress' });
  const segs = steps.map((_, i) => el('button', { ariaLabel: `Step ${i + 1}`, onclick: () => state.video && go(i) }));
  progress.append(...segs);
  const back = el('button', { textContent: 'Back', onclick: () => go(state.step - 1) });
  const next = el('button', { class: 'primary', textContent: 'Next' });
  next.onclick = () => (state.step === steps.length - 1 ? void createPdf() : go(state.step + 1));

  function go(i: number) {
    state.step = Math.max(0, Math.min(steps.length - 1, i));
    renderStep();
    renderStage();
  }

  function renderStep() {
    const s = steps[state.step];
    title.textContent = s.title;
    stepHint.textContent = s.hint?.() ?? '';
    body.replaceChildren(...s.body);
    segs.forEach((b, i) => b.classList.toggle('done', i <= state.step));
    back.disabled = state.step === 0;
    next.textContent = state.step === steps.length - 1 ? 'Create PDF' : 'Next';
    next.disabled = !state.video;
  }

  // --- stage ---
  const stage = el('div', { class: 'stage' });
  const sheet = el('div', { class: 'sheet' });
  const pageLabel = el('span', { class: 'muted' });
  const prev = el('button', { class: 'round', textContent: '‹', ariaLabel: 'Previous sheet', onclick: () => turn(-1) });
  const nextPage = el('button', { class: 'round', textContent: '›', ariaLabel: 'Next sheet', onclick: () => turn(1) });
  const pager = el('div', { class: 'pager' }, prev, pageLabel, nextPage);

  function renderStage() {
    const kind = steps[state.step].stage;
    if (kind === 'video') stage.replaceChildren(state.video ? videoStage : videoEmpty);
    else if (kind === 'crop' && state.video) {
      stage.replaceChildren(cropper.el);
      void cropper.load(state.video, state.start);
    } else {
      stage.replaceChildren(sheet, pager);
      void renderPreview();
    }
  }

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
  function changed() {
    const v = state.video;
    const s = spec();
    const n = frameCount();
    const pages = pageCount(s, n);

    fpsCtl.sync();
    cropCtl.sync();
    cropHint.hidden = state.crop === 'original' && !!v && Math.abs(aspect() - v.width / v.height) < 0.001;
    paperCtl.sync();
    orientCtl.sync();
    borderCtl.sync();
    outlineCtl.sync();
    labels.forEach((c) => c.sync());
    gridCtl.setOptions(choices().map((c) => ({ value: c.count, label: String(c.count) })));
    frameSizeNote.textContent = `Each frame ${s.frameW} × ${Math.round(s.frameW / s.aspect)} mm`;

    if (v) {
      videoSummary.textContent = `${fmtTime(state.end - state.start)} · ${plural(n, 'frame', 'frames')} to print`;
      tl.sync();
      tlLabel.replaceChildren(
        el('span', { class: 'muted', textContent: `${fmtTime(state.start)} – ${fmtTime(state.end)}` }),
        el('span', { class: 'muted', textContent: 'Drag the edges to pick the part you want' }),
      );
      player.set({ video: v, start: state.start, end: state.end, fps: state.fps, crop: crop() });
      cropper.sync();
    }

    const err = validateSpec(s);
    summary.replaceChildren(
      ...(err
        ? [el('p', { class: 'warn', textContent: err })]
        : [
            el('p', { textContent: `${plural(n, 'frame', 'frames')} on ${plural(pages, 'sheet', 'sheets')}` }),
            el('p', {
              class: 'muted',
              textContent: `${PAPERS[s.paper].name} ${s.landscape ? 'landscape' : 'portrait'} · ${framesPerPage(s)} per sheet · ${state.fps} frames per second`,
            }),
          ]),
    );
    pdfLink.hidden = true;
    pdfNote.textContent = '';
    renderStep();
    if (steps[state.step].stage === 'sheet') void renderPreview();
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
        onProgress: (done, total) => (pdfNote.textContent = `Preparing frame ${done} of ${total}`),
      });
      if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
      state.pdfUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      pdfLink.href = state.pdfUrl;
      pdfLink.download = `rotopaper-${id}.pdf`;
      pdfLink.textContent = `Download PDF · ${mb(bytes.length)}`;
      pdfLink.hidden = false;
      pdfNote.textContent = 'Print at 100 % or fit to page.';
      printed.set(id, { video: v, start: state.start });
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
    el(
      'aside',
      { class: 'side' },
      el('div', { class: 'side-scroll' }, el('div', { class: 'step-head' }, title, stepHint), body),
      el('div', { class: 'side-foot' }, progress, el('div', { class: 'nav' }, back, next)),
    ),
    stage,
  );
  changed();
  renderStage();
  return { el: panel, open, state };
}

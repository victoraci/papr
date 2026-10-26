// Print: videos → printable sheets, in two steps. 1 Video: drop videos, cut
// them together on the timeline, pick the frame rate and crop. 2 Paper:
// everything about the sheets, then download the PDF. Both steps can be
// opened at any time.
//
// Besides the animation: copies of one picture (a frame of the video or a
// picture of your own) over a whole sheet, without anything to scan.

import {
  BORDERS,
  computeLayout,
  copiesCells,
  copiesGap,
  copiesMaxWidth,
  gapForBorder,
  gridChoices,
  LAYOUT_VERSION,
  PAPERS,
  pageSize,
  PHOTO_LAYOUT,
  specForGrid,
  validateSpec,
  type BorderId,
  type GridChoice,
  type PaperId,
  type SheetSpec,
} from '../core/layout.ts';
import { framesPerPage, newProjectId } from '../core/payload.ts';
import { buildCopiesPdf, buildSheetsPdf, pageCount, type FrameImage } from '../core/pdf.ts';
import type { SheetStyle } from '../core/sheet.ts';
import { loadPicture, pictureImage, pictureView, type Picture } from './pictureview.ts';
import { renderCopiesSvg, renderSheetSvg } from './preview.ts';
import { printed } from './session.ts';
import { frameAt, frameCount as countFrames, history, insert, newClip, sequenceGrabber, setCrop, soundPieces, type Clip, type Edit } from './sequence.ts';
import { tc, timeline } from './timeline.ts';
import { dropTarget, el, field, filePicker, group, hint, mb, more, options, plural, saveFile, sidebar, slider, steps, toggleRow, type Control } from './ui.ts';
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
/** What the sheets hold: every frame to animate, or copies of one picture. */
type Make = 'animation' | 'copies';
/** How the painted sheets come back in; photos get a sheet with more to hold on to. */
type Capture = 'scanner' | 'photo';

/** The grid closest to `count` pictures per sheet. */
function nearest(list: GridChoice[], count: number): GridChoice | undefined {
  return list.reduce<GridChoice | undefined>((best, c) => (!best || Math.abs(c.count - count) < Math.abs(best.count - count) ? c : best), undefined);
}

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
    make: 'animation' as Make,
    border: 'none' as BorderId,
    /** copies have their own sheet, so the frames they start from stay as printed; null = as for the frames */
    copy: { paper: null as PaperId | null, landscape: null as boolean | null, border: 'none' as BorderId, width: null as number | null },
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
  let draft: Edit | null = null;
  const current = () => draft ?? edit.get();
  const clips = () => current().clips;
  /** a picture of your own for copies; without one, copies show the frame under the playhead */
  let picture: Picture | null = null;
  const copies = () => state.make === 'copies';
  const usesPicture = () => copies() && !!picture;

  // --- derived ---
  /** the frames of the animation */
  const videoAspect = () => {
    const c = CROPS.find((x) => x.value === state.crop);
    if (c) return c.ratio;
    const first = clips()[0];
    if (first) return first.video.width / first.video.height;
    return picture ? picture.width / picture.height : 16 / 9;
  };
  /** what's shown and printed now: the frames, or the copy */
  const aspect = () => {
    if (!copies() || CROPS.some((x) => x.value === state.crop)) return videoAspect();
    if (usesPicture()) return picture!.width / picture!.height;
    const clip = view.current();
    return clip ? clip.video.width / clip.video.height : videoAspect();
  };
  const version = () => (state.capture === 'photo' ? PHOTO_LAYOUT : LAYOUT_VERSION);
  const gap = () => gapForBorder(BORDERS[state.border], version());
  const choices = (): GridChoice[] => spread(gridChoices(state.paper, state.landscape, videoAspect(), gap(), 20, version()), MAX_GRID_OPTIONS);
  const choice = (): GridChoice => nearest(choices(), state.count)!;
  const copyPaper = () => state.copy.paper ?? state.paper;
  const copyLandscape = () => state.copy.landscape ?? state.landscape;
  const copyGap = () => copiesGap(BORDERS[state.copy.border]);
  /** a copy the size of the frames on the animation sheets (fitted inside one if its shape differs) */
  const sameAsFrames = () => {
    const s = spec();
    return Math.min(s.frameW, (s.frameW / s.aspect) * aspect());
  };
  const copyMax = () => copiesMaxWidth(copyPaper(), copyLandscape(), aspect());
  const copyMin = () => Math.min(sameAsFrames(), copyMax());
  /** width of each copy, mm: the frames' size unless made bigger */
  const copyW = () => Math.min(copyMax(), Math.max(copyMin(), state.copy.width ?? sameAsFrames()));
  const copyCells = () => copiesCells(copyPaper(), copyLandscape(), aspect(), copyGap(), copyW());
  /** the frame under the playhead */
  const copyFrame = () => Math.min(frameCount() - 1, Math.round(view.time() * state.fps));
  const spec = (): SheetSpec => specForGrid(state.paper, state.landscape, videoAspect(), gap(), choice(), version());
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
  const picturePicker = filePicker('image/*', false, (f) => void usePicture(f[0]));
  const intakeNote = el('p', { class: 'hint' });
  const intake = el(
    'div',
    { class: 'intake' },
    el('h1', { textContent: 'Drop a video here' }),
    el('button', { class: 'primary', textContent: 'Choose a video', onclick: picker.open }),
    el('button', { class: 'link', textContent: 'Print copies of a picture', onclick: picturePicker.open }),
    intakeNote,
  );

  // --- view: video or sheets ---
  const view = videoView({
    edit: current,
    fps: () => state.fps,
    aspect,
    onCrop(id, x, y, done) {
      const next = { ...edit.get(), clips: setCrop(edit.get().clips, id, x, y) };
      draft = done ? null : next;
      if (done) edit.push(next);
      if (done) changed('video');
    },
    onTime: () => (tl.tick(), copies() && syncVideoSummary()),
    onPlay: () => tl.sync(),
  });
  const picView = pictureView({
    picture: () => picture,
    aspect,
    onCrop(x, y, done) {
      if (!picture) return;
      picture = { ...picture, cropX: x, cropY: y };
      if (done) changed('video');
    },
  });
  const picturePane = el('div', { class: 'video-pane', hidden: true }, picView.el);
  const tl = timeline({
    edit: current,
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
      if (copies()) syncVideoSummary();
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
  const pager = el('div', { class: 'pager' }, prev, pageLabel, nextPage);
  const sheetPane = el('div', { class: 'sheet-pane', hidden: true }, sheet, pager);

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
    for (const part of videoParts) part.hidden = v !== 'video';
    for (const part of paperParts) part.hidden = v !== 'sheets';
    syncPanes();
    if (v === 'sheets') void renderPreview();
  }

  /** The view: video and timeline, the picture of your own, or the sheets. */
  function syncPanes() {
    const video = state.view === 'video';
    videoPane.hidden = !video || usesPicture();
    picturePane.hidden = !video || !usesPicture();
    sheetPane.hidden = video;
    if (videoPane.hidden) view.pause();
    else view.refresh();
    if (!picturePane.hidden) picView.refresh();
    tl.sync();
  }

  // --- controls ---
  const fileName = el('span', { class: 'file-name' });
  const fileNote = el('p', { class: 'hint' });
  const fpsCtl = options(
    FPS_CHOICES.map((f) => ({ value: f, label: String(f) })),
    () => state.fps,
    (v) => {
      // the playhead stays at the same time, not the same frame number
      const t = view.time();
      state.fps = v;
      view.seek(t);
      changed('video');
    },
  );
  const cropCtl = options(
    [{ value: 'original', label: 'Original' }, ...CROPS.map((c) => ({ value: c.value, label: c.value }))],
    () => state.crop,
    (v) => {
      state.crop = v;
      edit.replace({ ...edit.get(), clips: edit.get().clips.map((c) => ({ ...c, cropX: 0.5, cropY: 0.5 })) });
      if (picture) picture = { ...picture, cropX: 0.5, cropY: 0.5 };
      view.refresh();
      picView.refresh();
      changed('video');
    },
  );
  const makeCtl = options<Make>(
    [
      { value: 'animation', label: 'Animation' },
      { value: 'copies', label: 'Copies' },
    ],
    () => state.make,
    (v) => {
      state.make = v;
      syncPanes();
      changed('video');
    },
  );
  const makeHint = hint();
  const sourceNote = hint();
  const usePictureBtn = el('button', { class: 'link', textContent: 'Use a picture', onclick: picturePicker.open });
  const useFrameBtn = el('button', {
    class: 'link',
    textContent: 'Use the video instead',
    onclick: () => {
      picture = null;
      syncPanes();
      changed('video');
    },
  });
  const sourceField = field('Copies of', sourceNote, el('div', { class: 'links' }, usePictureBtn, useFrameBtn));
  const fpsField = field('Frames per second', fpsCtl.el, hint('Animation on paper usually runs at 8 or 12.'));
  const cropHint = hint('Drag the picture to choose what stays in the frame.');
  const paperCtl = options(
    (['A4', 'A3', 'A5', 'LT'] as PaperId[]).map((id) => ({ value: id, label: PAPERS[id].name })),
    () => (copies() ? copyPaper() : state.paper),
    (v) => (copies() ? (state.copy.paper = v) : (state.paper = v), changed('sheets')),
  );
  const orientCtl = options(
    [
      { value: 'P', label: 'Portrait' },
      { value: 'L', label: 'Landscape' },
    ],
    () => ((copies() ? copyLandscape() : state.landscape) ? 'L' : 'P'),
    (v) => (copies() ? (state.copy.landscape = v === 'L') : (state.landscape = v === 'L'), changed('sheets')),
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
  const sizeCtl = slider(
    'Size of each copy',
    { min: () => Math.floor(copyMin()), max: () => Math.floor(copyMax()), step: 1 },
    () => copyW(),
    (v) => {
      state.copy.width = v <= Math.floor(copyMin()) ? null : v;
      changed('sheets');
    },
    () => `${Math.round(copyW())} × ${Math.round(copyW() / aspect())} mm`,
  );
  const sizeNote = hint();
  const sameSize = el('button', {
    class: 'link',
    textContent: 'Back to the size of the frames',
    onclick: () => {
      state.copy.width = null;
      changed('sheets');
    },
  });
  const frameSizeNote = hint();
  const borderCtl = options<BorderId>(
    [
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large' },
    ],
    () => (copies() ? state.copy.border : state.border),
    (v) => (copies() ? (state.copy.border = v) : (state.border = v), changed('sheets')),
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
  const videoGroup = group('Video', fpsField, field('Crop', cropCtl.el, cropHint));
  const scanField = field('Scan with', captureCtl.el, captureHint);
  const gridField = field('Frames per sheet', gridCtl.el, frameSizeNote);
  const sizeField = el('div', { class: 'field' }, sizeCtl.el, sizeNote, sameSize);
  const borderHint = hint();
  const outlineHint = hint('The thin line helps photos line up when your video is white at the edges.');
  const videoParts = [
    part(
      el('div', { class: 'file' }, fileName, el('button', { class: 'link', textContent: 'Add video', onclick: picker.open })),
      fileNote,
      group('What to print', makeCtl.el, makeHint, sourceField),
      videoGroup,
    ),
    part(next, videoSummary),
  ];
  const paperParts = [
    part(
      group(
        'Paper',
        field('Size', paperCtl.el),
        field('Orientation', orientCtl.el),
        scanField,
        gridField,
        sizeField,
      ),
      more(field('White border', borderCtl.el, borderHint), el('div', { class: 'toggles' }, ...toggles.map((t) => t.el)), outlineHint),
    ),
    part(download, summary, pdfNote),
  ];
  for (const p of paperParts) p.hidden = true;
  const controls = sidebar([videoParts[0], paperParts[0]], [videoParts[1], paperParts[1]]);

  const work = el(
    'div',
    { class: 'work', hidden: true },
    controls,
    el('div', { class: 'view' }, el('div', { class: 'view-head' }, stepCtl.el), videoPane, picturePane, sheetPane),
  );

  /** Dropped files: videos go into the edit, a picture becomes the one for copies. */
  function addFiles(files: File[], at?: number) {
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    const videos = files.filter((f) => !f.type.startsWith('image/'));
    if (pictures.length) void usePicture(pictures[0]);
    if (videos.length) void addVideos(videos, at);
  }

  async function usePicture(file: File) {
    const fresh = work.hidden;
    const note = fresh ? intakeNote : fileNote;
    try {
      picture = await loadPicture(file);
    } catch (e) {
      note.className = 'warn';
      note.textContent = `${file.name}: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    note.textContent = '';
    state.make = 'copies';
    if (fresh) {
      state.crop = 'original';
      state.landscape = picture.width >= picture.height;
    }
    intake.hidden = true;
    work.hidden = false;
    show('video');
    syncPanes();
    changed('video');
  }

  /** New videos go to the end of the edit, or where they were dropped on the timeline. */
  async function addVideos(files: File[], at?: number) {
    const first = !edit.get().clips.length;
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
    const now = edit.get();
    const next = { ...now, clips: insert(now.clips, at ?? now.clips.length, added) };
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
    if (page.hidden || work.hidden || state.busy || state.view !== 'video' || usesPicture()) return;
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

  let copyThumb: { key: string; url: string } | null = null;
  /** what the copies show: the picture or the frame, cropped */
  const copyImageKey = () =>
    usesPicture()
      ? `${picture!.file.name}|${picture!.file.size}|${picture!.cropX}|${picture!.cropY}|${aspect().toFixed(4)}`
      : clips().length
        ? thumbKey(copyFrame())
        : '';
  const copyKey = () => JSON.stringify(['copies', copyImageKey(), copyPaper(), copyLandscape(), copyGap(), copyW(), state.style.borders]);

  /** The copy at `width` px (at most its own size). */
  async function copyImage(width: number): Promise<FrameImage> {
    if (usesPicture()) return pictureImage(picture!, aspect(), width);
    const k = copyFrame();
    const grab = await sequenceGrabber(clips(), state.fps, aspect(), width, [k]);
    return grab.jpeg(k, 0.92);
  }

  async function renderCopies(run: number) {
    if (!copyImageKey()) return void sheet.replaceChildren();
    const { w, h } = pageSize(copyPaper(), copyLandscape());
    const cells = copyCells();
    const key = copyImageKey();
    const draw = () => sheet.replaceChildren(renderCopiesSvg(w, h, cells, copyThumb?.key === key ? copyThumb.url : undefined, state.style.borders));
    draw();
    if (copyThumb?.key === key) return;
    const img = await copyImage(480);
    if (run !== previewRun) return;
    if (copyThumb) URL.revokeObjectURL(copyThumb.url);
    copyThumb = { key, url: URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type === 'png' ? 'image/png' : 'image/jpeg' })) };
    draw();
  }

  async function renderPreview() {
    const run = ++previewRun;
    pager.hidden = copies();
    if (copies()) return renderCopies(run);
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
    const grab = await sequenceGrabber(clips(), state.fps, aspect(), 240, missing);
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

    for (const c of [makeCtl, fpsCtl, cropCtl, paperCtl, orientCtl, captureCtl, borderCtl, sizeCtl, ...toggles]) c.sync();
    syncMode();
    captureHint.textContent =
      state.capture === 'photo'
        ? 'Small squares between the frames keep photos of curved or painted paper in line.'
        : 'Only the four corners get printed. Photos work too, as long as the paper lies flat.';
    cropHint.hidden = state.crop === 'original';
    gridCtl.setOptions(choices().map((c) => ({ value: c.count, label: String(c.count) })));
    frameSizeNote.textContent = `Each frame ${s.frameW} × ${Math.round(s.frameW / s.aspect)} mm`;
    const bigger = Math.round((copyW() / copyMin() - 1) * 100);
    sizeNote.textContent =
      sameAsFrames() > copyMax() + 1e-6
        ? `The frames are ${Math.round(sameAsFrames())} mm wide, too big for this paper.`
        : bigger > 0
          ? `${bigger} % bigger than the frames on your animation sheets.`
          : clips().length
            ? 'The same size as the frames on your animation sheets.'
            : 'The size frames get on animation sheets.';
    sameSize.hidden = state.copy.width === null;
    const cells = copyCells();

    tl.sync();
    const names = videoNames();
    fileName.textContent = names.length > 1 ? `${names.length} videos` : (names[0] ?? (picture ? 'No video yet' : 'No video'));
    fileName.title = names.join(', ');

    const paperName = copies()
      ? `${PAPERS[copyPaper()].name} ${copyLandscape() ? 'landscape' : 'portrait'}`
      : `${PAPERS[state.paper].name} ${state.landscape ? 'landscape' : 'portrait'}`;
    const err = copies()
      ? !copyImageKey()
        ? 'Add a video or a picture first.'
        : !cells.length
          ? 'This picture doesn’t fit on the sheet.'
          : null
      : clips().length
        ? validateSpec(s)
        : 'Add a video to make sheets.';
    download.disabled = !!err || state.busy;
    next.disabled = copies() ? !copyImageKey() : !clips().length;
    syncVideoSummary();
    summary.className = err ? 'warn' : 'hint';
    summary.textContent =
      err ??
      (copies() ? `${plural(cells.length, 'copy', 'copies')} on one sheet · ${paperName}` : `${plural(n, 'frame', 'frames')} on ${plural(pages, 'sheet', 'sheets')} · ${paperName}`);
    if (last && last.key !== (copies() ? copyKey() : pdfKey())) pdfNote.textContent = '';
    if (state.view === 'sheets') void renderPreview();
  }

  /** Settings that only one of the two kinds of sheet has. */
  function syncMode() {
    const c = copies();
    makeHint.textContent = c
      ? 'One picture repeated over the sheet, without codes. For stencils and cut-outs.'
      : 'Every frame of the video, to paint and scan back in.';
    sourceField.hidden = !c;
    sourceNote.textContent = picture && c ? picture.file.name : 'The frame under the playhead. Move it on the timeline to pick another one.';
    usePictureBtn.textContent = picture ? 'Use another picture' : 'Use a picture';
    useFrameBtn.hidden = !picture || !clips().length;
    fpsField.hidden = c;
    videoGroup.querySelector('.group-title')!.textContent = usesPicture() ? 'Picture' : 'Video';
    scanField.hidden = c;
    gridField.hidden = c;
    sizeField.hidden = !c;
    toggles[0].el.firstElementChild!.textContent = c ? 'Thin line around each copy' : 'Thin line around each frame';
    toggles[1].el.hidden = c;
    toggles[2].el.hidden = c;
    outlineHint.hidden = c;
    borderHint.textContent = c
      ? 'Blank paper around each copy.'
      : 'Blank paper around each frame to paint past the edge. You can keep it in the finished video.';
  }

  function syncVideoSummary() {
    const n = frameCount();
    if (copies()) {
      const clip = view.current();
      videoSummary.textContent = usesPicture()
        ? `${picture!.width} × ${picture!.height} px`
        : clip
          ? `Frame ${tc(view.time(), state.fps)} of ${clip.video.file.name}`
          : 'Add a video or a picture to start.';
    } else
      videoSummary.textContent = clips().length ? `${plural(n, 'frame', 'frames')} · ${(n / state.fps).toFixed(1)} s at ${state.fps} fps` : 'Add a video to start.';
  }

  /** What the Scan side needs to put the sound back under the scans. */
  function remember(id: string) {
    const pieces = soundPieces(edit.get()).map((p) => ({ file: p.video.file, start: p.from, length: p.to - p.from, at: p.at }));
    printed.set(id, { pieces });
  }

  async function createCopiesPdf() {
    const cells = copyCells();
    if (!cells.length || !copyImageKey() || state.busy) return;
    const key = copyKey();
    if (last?.key === key) return saveFile(last.url, last.name);
    state.busy = true;
    download.disabled = true;
    download.textContent = 'Preparing the picture…';
    pdfNote.className = 'hint';
    try {
      const name = usesPicture() ? picture!.file.name : (view.current()?.video.file.name ?? 'video');
      const { w, h } = pageSize(copyPaper(), copyLandscape());
      const bytes = await buildCopiesPdf({
        pageW: w,
        pageH: h,
        cells,
        image: await copyImage((copyW() / 25.4) * 300), // ~300 dpi
        outline: state.style.borders,
        title: name,
      });
      const slug = name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40);
      if (last) URL.revokeObjectURL(last.url);
      last = { key, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })), name: `papr-copies-${slug}.pdf` };
      saveFile(last.url, last.name);
      pdfNote.textContent = `${last.name} · ${mb(bytes.length)}. Print at 100 % or fit to page.`;
    } catch (e) {
      pdfNote.className = 'warn';
      pdfNote.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      state.busy = false;
      download.textContent = 'Download PDF';
      download.disabled = false;
    }
  }

  async function createPdf() {
    if (copies()) return createCopiesPdf();
    const list = edit.get().clips;
    const s = spec();
    if (!list.length || validateSpec(s) || state.busy) return;
    const key = pdfKey();
    if (last?.key === key) {
      remember(state.projectId); // the sound may have changed since
      return saveFile(last.url, last.name);
    }
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
      // ~300 dpi, decoded in the order the sheets ask for them
      const grab = await sequenceGrabber(list, state.fps, aspect(), (s.frameW / 25.4) * 300, [...Array(n).keys()]);
      const bytes = await buildSheetsPdf({
        spec: s,
        style: state.style,
        projectId: id,
        fps: state.fps,
        frameCount: n,
        title: title(),
        // the QR code can only say where one uncut piece with its own sound starts in its video
        start: list.length === 1 && !list[0].muted && !edit.get().sounds.length ? list[0].from : undefined,
        getFrame: (i) => grab.jpeg(i),
        onProgress: (done, total) => (download.textContent = `Preparing frame ${done} of ${total}`),
      });
      if (last) URL.revokeObjectURL(last.url);
      last = { key, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })), name: `papr-${id}.pdf` };
      saveFile(last.url, last.name);
      pdfNote.textContent = `${last.name} · ${mb(bytes.length)}. Print at 100 % or fit to page.`;
      remember(id);
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
  dropTarget(page, 'video/*,image/*', true, (f) => addFiles(f));
  return { el: page, open: (f: File) => addVideos([f]), addVideos, state, clips, edit: current };
}

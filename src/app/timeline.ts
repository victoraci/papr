// Edit timeline: the clips back to back on one track, like a small video
// editor. Click or drag in the ruler to move the playhead, click a clip to
// select it, drag it to move it, drag its edges to trim, cut at the
// playhead, delete, undo. No effects, on purpose.
//
// Ruler, clips and playhead are drawn on one canvas the size of the visible
// part; a wide empty element behind it gives the native scrollbar.

import { clipAt, clipLength, duration, split as splitClips, starts, thumbAt, thumbsOf, type Clip } from './sequence.ts';
import { el } from './ui.ts';

export interface TimelineHost {
  clips(): Clip[];
  fps(): number;
  /** a finished edit, one undo step */
  commit(next: Clip[]): void;
  /** live while dragging; commit or cancel follows */
  preview(next: Clip[] | null): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** playhead, s */
  time(): number;
  seek(t: number): void;
  playing(): boolean;
  togglePlay(): void;
  pickVideos(): void;
  dropVideos(files: File[], index: number): void;
}

const RULER = 26;
const TRACK_Y = 36;
const TRACK_H = 64;
const HEIGHT = TRACK_Y + TRACK_H + 12;
const PAD_L = 14;
const PAD_R = 120;
const ADD = 64; // the "+" tile after the last clip
const EDGE = 9; // grab zone for trimming, px
const SNAP = 8; // px

const ICONS = {
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/>',
  pause: '<path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor"/>',
  undo: '<path d="M6 4 3 7l3 3M3.5 7h6a3.5 3.5 0 0 1 0 7H7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  redo: '<path d="m10 4 3 3-3 3M12.5 7h-6a3.5 3.5 0 0 0 0 7H9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  split:
    '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.9 10.1 11 2.5M10.1 10.1 5 2.5"/></g>',
  trash:
    '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/></g>',
  add: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  minus: '<path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  fit: '<path d="M2.5 8h11M5 5.5 2.5 8 5 10.5M11 5.5l2.5 2.5-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
};

function iconButton(icon: keyof typeof ICONS, title: string, onclick: () => void, label?: string) {
  const b = el('button', { class: label ? 'tl-btn labelled' : 'tl-btn', title, ariaLabel: title, onclick });
  b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[icon]}</svg>`;
  if (label) b.append(el('span', { textContent: label }));
  return b;
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'press'; id: number; x0: number; t: number }
  | { kind: 'move'; id: number; grab: number; x: number; index: number }
  | { kind: 'trim'; id: number; side: 'from' | 'to'; x0: number; base: Clip[]; start: number; shift: number };

export function timeline(host: TimelineHost) {
  const canvas = el('canvas', { class: 'tl-canvas' });
  const spacer = el('div', { class: 'tl-spacer' });
  const scroller = el('div', { class: 'tl-scroll' }, canvas, spacer);
  const ctx = canvas.getContext('2d')!;

  // --- toolbar ---
  const playBtn = iconButton('play', 'Play / pause (Space)', () => host.togglePlay());
  const timecode = el('span', { class: 'tl-time' });
  const undoBtn = iconButton('undo', 'Undo (⌘Z)', () => host.undo());
  const redoBtn = iconButton('redo', 'Redo (⇧⌘Z)', () => host.redo());
  const splitBtn = iconButton('split', 'Cut at the playhead (S)', () => split(), 'Cut');
  const deleteBtn = iconButton('trash', 'Delete the selected clip (⌫)', () => deleteSelected(), 'Delete');
  const addBtn = iconButton('add', 'Add videos', () => host.pickVideos(), 'Add video');
  const zoom = el('input', { type: 'range', min: '0', max: '1000', value: '0', className: 'tl-zoom', title: 'Zoom (⌘ + scroll)' });
  const zoomOut = iconButton('minus', 'Zoom out', () => zoomBy(1 / 1.6));
  const zoomIn = iconButton('plus', 'Zoom in', () => zoomBy(1.6));
  const fitBtn = iconButton('fit', 'Show everything', () => fitAll());
  const bar = el(
    'div',
    { class: 'tl-bar' },
    el('div', { class: 'tl-group' }, playBtn, timecode),
    el('div', { class: 'tl-group tl-tools' }, undoBtn, redoBtn, el('span', { class: 'tl-sep' }), splitBtn, deleteBtn, el('span', { class: 'tl-sep' }), addBtn),
    el('div', { class: 'tl-group tl-zooms' }, zoomOut, zoom, zoomIn, fitBtn),
  );
  const root = el('div', { class: 'tl' }, bar, scroller);

  let pps = 100; // px per second
  let fitMode = true;
  let selected: number | null = null;
  let drag: Drag | null = null;
  let dropAt: number | null = null; // insertion index while files are dragged over
  let viewW = 0;
  let frame = 0;

  const clips = () => host.clips();
  const total = () => duration(clips());
  const minLen = () => 1 / host.fps();
  const fitPps = () => Math.max(1, (viewW - PAD_L - PAD_R) / Math.max(total(), 0.5));
  const maxPps = () => Math.max(fitPps() * 1.01, host.fps() * 56);
  const xOf = (t: number) => PAD_L + t * pps - scroller.scrollLeft;
  const tOf = (x: number) => (x + scroller.scrollLeft - PAD_L) / pps;

  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => ((frame = 0), render()));
  }

  // --- zoom ---
  function setPps(next: number, anchorX = viewW / 2) {
    const t = tOf(anchorX);
    pps = Math.min(maxPps(), Math.max(fitPps(), next));
    fitMode = pps <= fitPps() + 1e-6;
    layoutWidth();
    scroller.scrollLeft = Math.max(0, PAD_L + t * pps - anchorX);
    syncZoom();
    schedule();
  }
  function zoomBy(f: number) {
    const ph = xOf(host.time());
    setPps(pps * f, ph >= 0 && ph <= viewW ? ph : viewW / 2);
  }
  function fitAll() {
    fitMode = true;
    pps = fitPps();
    layoutWidth();
    scroller.scrollLeft = 0;
    syncZoom();
    schedule();
  }
  function syncZoom() {
    const lo = Math.log(fitPps());
    const hi = Math.log(maxPps());
    zoom.value = String(Math.round(hi > lo ? ((Math.log(pps) - lo) / (hi - lo)) * 1000 : 0));
  }
  zoom.oninput = () => {
    const lo = Math.log(fitPps());
    const hi = Math.log(maxPps());
    const ph = xOf(host.time());
    setPps(Math.exp(lo + (Number(zoom.value) / 1000) * (hi - lo)), ph >= 0 && ph <= viewW ? ph : viewW / 2);
  };
  function layoutWidth() {
    spacer.style.width = `${PAD_L + total() * pps + ADD + PAD_R}px`;
  }

  // --- layout while dragging ---
  /** x position (s) of every clip as drawn right now. */
  function placed(): { clip: Clip; start: number }[] {
    const list = clips();
    const s = starts(list);
    if (drag?.kind === 'move') {
      const d = drag;
      const moving = list.find((c) => c.id === d.id)!;
      const rest = list.filter((c) => c.id !== d.id);
      const out: { clip: Clip; start: number }[] = [];
      let t = 0;
      rest.forEach((c, i) => {
        if (i === d.index) t += clipLength(moving);
        out.push({ clip: c, start: t });
        t += clipLength(c);
      });
      return out;
    }
    if (drag?.kind === 'trim' && drag.side === 'from') {
      // the left edge follows the pointer; the gap closes on release
      const d = drag;
      const i = list.findIndex((c) => c.id === d.id);
      return list.map((c, k) => ({ clip: c, start: s[k] + (k >= i ? d.shift : 0) }));
    }
    return list.map((c, k) => ({ clip: c, start: s[k] }));
  }

  /** Insertion index for a drop or move at time t, among `list`. */
  function slotAt(list: Clip[], t: number): number {
    const s = starts(list);
    for (let i = 0; i < list.length; i++) if (t < s[i] + clipLength(list[i]) / 2) return i;
    return list.length;
  }

  // --- drawing ---
  function render() {
    const dpr = window.devicePixelRatio || 1;
    const w = viewW;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${HEIGHT}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);
    drawRuler(w);

    // track bed
    ctx.fillStyle = '#121212';
    roundRect(0, TRACK_Y - 4, w, TRACK_H + 8, 0);
    ctx.fill();

    const items = placed();
    for (const { clip, start } of items) drawClip(clip, start, false);
    const all = clips();
    const end = total();
    drawAddTile(xOf(drag?.kind === 'trim' && drag.side === 'from' ? end + drag.shift : end) + 6);

    if (drag?.kind === 'move') {
      const d = drag;
      const moving = all.find((c) => c.id === d.id);
      if (moving) {
        const rest = all.filter((c) => c.id !== d.id);
        const s = starts(rest);
        const at = d.index < rest.length ? s[d.index] : duration(rest);
        marker(xOf(at));
        drawClip(moving, tOf(d.x - d.grab), true);
      }
    }
    if (dropAt !== null) {
      const s = starts(all);
      marker(xOf(dropAt < all.length ? s[dropAt] : end));
    }
    drawPlayhead();
  }

  function drawRuler(w: number) {
    const fps = host.fps();
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, RULER);
    // a labelled tick at least every 74 px
    const steps = [1 / fps, 2 / fps, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * pps >= 74) ?? 600;
    const minor = major <= 2 / fps ? 1 / fps : major / (major >= 1 && major % 5 === 0 ? 5 : 2);
    const t0 = Math.max(0, Math.floor(tOf(0) / minor) * minor);
    const t1 = tOf(w);
    ctx.font = '500 10px "Inter Variable", Inter, Arial, sans-serif';
    ctx.textBaseline = 'top';
    for (let t = t0; t <= t1 + minor; t += minor) {
      const x = Math.round(xOf(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.fillStyle = isMajor ? '#5a5a5a' : '#2e2e2e';
      ctx.fillRect(x, isMajor ? RULER - 9 : RULER - 5, 1, isMajor ? 9 : 5);
      if (isMajor) {
        ctx.fillStyle = '#7a7a7a';
        ctx.fillText(rulerLabel(t, major, fps), x + 4, 6);
      }
    }
    ctx.fillStyle = '#1f1f1f';
    ctx.fillRect(0, RULER - 0.5, w, 1);
  }

  function drawClip(clip: Clip, start: number, lifted: boolean) {
    const x = xOf(start);
    const w = Math.max(2, clipLength(clip) * pps);
    if (x > viewW + 4 || x + w < -4) return;
    const y = TRACK_Y;
    const isSel = clip.id === selected;
    ctx.save();
    if (lifted) {
      ctx.globalAlpha = 0.85;
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 4;
    }
    roundRect(x, lifted ? y - 4 : y, w, TRACK_H, 6);
    ctx.fillStyle = '#1e1e1e';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();

    // film strip: one picture per slot, picked from the precomputed thumbs
    const thumbs = thumbsOf(clip.video, schedule);
    const th = TRACK_H;
    const tw = Math.max(24, Math.round((th * clip.video.width) / clip.video.height));
    const first = Math.max(0, Math.floor(-x / tw));
    const last = Math.min(Math.ceil(w / tw), Math.ceil((viewW - x) / tw));
    for (let k = first; k < last; k++) {
      const img = thumbAt(thumbs, clip.from + ((k + 0.5) * tw) / pps);
      if (img) ctx.drawImage(img, x + k * tw, lifted ? y - 4 : y, tw, th);
    }
    // label
    const label = `${clip.video.file.name}  ${fmtLength(clipLength(clip))}`;
    ctx.font = '500 11px "Inter Variable", Inter, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    const lw = Math.min(w - 12, ctx.measureText(label).width + 12);
    if (lw > 24) {
      ctx.fillStyle = 'rgba(13,13,13,0.72)';
      roundRect(x + 5, (lifted ? y - 4 : y) + 5, lw, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#f5f5f5';
      ctx.fillText(label, x + 11, (lifted ? y - 4 : y) + 14, lw - 12);
    }
    ctx.restore();

    // outline, handles when selected
    ctx.save();
    roundRect(x + 0.5, (lifted ? y - 4 : y) + 0.5, w - 1, TRACK_H - 1, 6);
    ctx.lineWidth = isSel ? 2 : 1;
    ctx.strokeStyle = isSel ? '#f5f5f5' : 'rgba(255,255,255,0.14)';
    ctx.stroke();
    if (isSel && !lifted && w > 26) {
      for (const hx of [x, x + w - 8]) {
        ctx.fillStyle = '#f5f5f5';
        roundRect(hx, y, 8, TRACK_H, hx === x ? [6, 0, 0, 6] : [0, 6, 6, 0]);
        ctx.fill();
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(hx + 3.5, y + TRACK_H / 2 - 7, 1, 14);
      }
    }
    ctx.restore();
  }

  function drawAddTile(x: number) {
    if (x > viewW || x + ADD < 0) return;
    ctx.save();
    roundRect(x + 0.5, TRACK_Y + 0.5, ADD - 1, TRACK_H - 1, 6);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#3a3a3a';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#8a8a8a';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    const cx = x + ADD / 2;
    const cy = TRACK_Y + TRACK_H / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy);
    ctx.lineTo(cx + 7, cy);
    ctx.moveTo(cx, cy - 7);
    ctx.lineTo(cx, cy + 7);
    ctx.stroke();
    ctx.restore();
  }

  function marker(x: number) {
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(Math.round(x) - 1, TRACK_Y - 6, 2, TRACK_H + 12);
  }

  function drawPlayhead() {
    const x = Math.round(xOf(host.time())) + 0.5;
    if (x < -10 || x > viewW + 10) return;
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(x - 0.5, 4, 1, HEIGHT - 8);
    // head on the ruler
    ctx.beginPath();
    ctx.moveTo(x - 6, 3);
    ctx.lineTo(x + 6, 3);
    ctx.lineTo(x + 6, 12);
    ctx.lineTo(x, 18);
    ctx.lineTo(x - 6, 12);
    ctx.closePath();
    ctx.fill();
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number | number[]) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  // --- hit testing ---
  type Hit = { kind: 'ruler' } | { kind: 'add' } | { kind: 'clip'; clip: Clip; start: number; edge: 'from' | 'to' | null } | { kind: 'empty' };
  function hit(x: number, y: number): Hit {
    if (y < RULER + 4) return { kind: 'ruler' };
    const end = total();
    const ax = xOf(end) + 6;
    if (x >= ax && x <= ax + ADD && y >= TRACK_Y && y <= TRACK_Y + TRACK_H) return { kind: 'add' };
    if (y < TRACK_Y - 6 || y > TRACK_Y + TRACK_H + 6) return { kind: 'empty' };
    const s = starts(clips());
    for (let i = 0; i < clips().length; i++) {
      const c = clips()[i];
      const x0 = xOf(s[i]);
      const x1 = xOf(s[i] + clipLength(c));
      if (x < x0 - (i === 0 ? EDGE : 0) || x > x1 + EDGE) continue;
      const w = x1 - x0;
      const zone = Math.min(EDGE, w / 3);
      // the edge between two clips: right edge of the left one unless the pointer is past it
      if (x <= x0 + zone && x >= x0 - EDGE) return { kind: 'clip', clip: c, start: s[i], edge: 'from' };
      if (x >= x1 - zone && x <= x1 + EDGE) {
        const next = clips()[i + 1];
        if (next && x > x1 + 1) continue;
        return { kind: 'clip', clip: c, start: s[i], edge: 'to' };
      }
      if (x >= x0 && x <= x1) return { kind: 'clip', clip: c, start: s[i], edge: null };
    }
    return { kind: 'empty' };
  }

  const local = (e: PointerEvent | DragEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // --- pointer ---
  canvas.onpointermove = (e) => {
    const { x, y } = local(e);
    if (!drag) {
      const h = hit(x, y);
      canvas.style.cursor =
        h.kind === 'clip' ? (h.edge ? 'ew-resize' : 'grab') : h.kind === 'add' || h.kind === 'ruler' ? 'pointer' : 'default';
      return;
    }
    autoscroll(x);
    if (drag.kind === 'scrub') host.seek(clampT(tOf(x)));
    else if (drag.kind === 'press') {
      if (Math.abs(x - drag.x0) > 5) {
        const list = clips();
        const c = list.find((k) => k.id === (drag as { id: number }).id)!;
        const s = starts(list)[list.indexOf(c)];
        const grab = drag.x0 - xOf(s);
        const rest = list.filter((k) => k.id !== c.id);
        drag = { kind: 'move', id: c.id, grab, x, index: slotAt(rest, tOf(x - grab) + clipLength(c) / 2) };
        canvas.style.cursor = 'grabbing';
      }
    } else if (drag.kind === 'move') {
      const list = clips();
      const c = list.find((k) => k.id === (drag as { id: number }).id)!;
      const rest = list.filter((k) => k.id !== c.id);
      drag.x = x;
      drag.index = slotAt(rest, tOf(x - drag.grab) + clipLength(c) / 2);
    } else if (drag.kind === 'trim') trimTo(x);
    schedule();
  };

  canvas.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    const h = hit(x, y);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone; the drag still works while it stays on the canvas
    }
    if (h.kind === 'add') {
      host.pickVideos();
      return;
    }
    if (h.kind === 'ruler' || h.kind === 'empty') {
      drag = { kind: 'scrub' };
      host.seek(clampT(tOf(x)));
      schedule();
      return;
    }
    if (h.kind === 'clip') {
      selected = h.clip.id;
      if (h.edge) {
        drag = { kind: 'trim', id: h.clip.id, side: h.edge, x0: x, base: clips(), start: h.start, shift: 0 };
      } else drag = { kind: 'press', id: h.clip.id, x0: x, t: clampT(tOf(x)) };
      sync();
    }
  };

  canvas.onpointerup = () => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === 'press') host.seek(d.t);
    else if (d.kind === 'move') {
      const list = clips();
      const rest = list.filter((c) => c.id !== d.id);
      const at = d.index;
      const from = list.findIndex((c) => c.id === d.id);
      if (at !== from) host.commit([...rest.slice(0, at), list[from], ...rest.slice(at)]);
    } else if (d.kind === 'trim') {
      const next = clips();
      host.preview(null);
      if (next !== d.base) host.commit(next);
      // keep the playhead on the same picture where possible
      host.seek(clampT(host.time()));
    }
    canvas.style.cursor = 'default';
    schedule();
  };
  canvas.onpointercancel = () => {
    if (drag?.kind === 'trim') host.preview(null);
    drag = null;
    schedule();
  };

  function trimTo(x: number) {
    if (drag?.kind !== 'trim') return;
    const d = drag;
    const c0 = d.base.find((c) => c.id === d.id)!;
    let dt = (x - d.x0) / pps;
    const ph = host.time();
    if (d.side === 'from') {
      // left edge on the timeline is start + dt; snap it to the playhead
      if (Math.abs((d.start + dt - ph) * pps) < SNAP) dt = ph - d.start;
      const from = Math.max(0, Math.min(c0.from + dt, c0.to - minLen()));
      d.shift = from - c0.from;
      host.preview(d.base.map((c) => (c.id === d.id ? { ...c, from } : c)));
    } else {
      const end = d.start + clipLength(c0) + dt;
      if (Math.abs((end - ph) * pps) < SNAP) dt = ph - (d.start + clipLength(c0));
      const to = Math.min(c0.video.duration, Math.max(c0.to + dt, c0.from + minLen()));
      host.preview(d.base.map((c) => (c.id === d.id ? { ...c, to } : c)));
    }
    layoutWidth();
  }

  function autoscroll(x: number) {
    if (!drag || drag.kind === 'press') return;
    if (x < 30) scroller.scrollLeft -= 12;
    else if (x > viewW - 30) scroller.scrollLeft += 12;
  }

  const clampT = (t: number) => Math.max(0, Math.min(total() - minLen() / 2, t));

  // wheel: ⌘/ctrl (and trackpad pinch) zooms around the pointer, plain wheel scrolls sideways
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setPps(pps * Math.exp(-e.deltaY * 0.01), local(e).x);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scroller.scrollWidth > scroller.clientWidth) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      }
    },
    { passive: false },
  );
  scroller.addEventListener('scroll', schedule);

  // files dropped on the timeline go where they land
  scroller.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dropAt = slotAt(clips(), tOf(local(e).x));
    schedule();
  });
  scroller.addEventListener('dragleave', () => {
    dropAt = null;
    schedule();
  });
  scroller.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name));
    const at = dropAt ?? clips().length;
    dropAt = null;
    schedule();
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    host.dropVideos(files, at);
  });

  new ResizeObserver(() => {
    viewW = scroller.clientWidth;
    if (fitMode) pps = fitPps();
    else pps = Math.min(maxPps(), Math.max(fitPps(), pps));
    layoutWidth();
    syncZoom();
    render();
  }).observe(scroller);

  // --- commands ---
  function split() {
    const t = host.time();
    const next = splitClips(clips(), t, minLen());
    if (!next) return;
    host.commit(next);
    // the part right of the cut
    selected = clipAt(next, t)?.clip.id ?? null;
    sync();
  }

  function deleteSelected() {
    const list = clips();
    if (selected === null || !list.some((c) => c.id === selected)) return;
    const s = starts(list)[list.findIndex((c) => c.id === selected)];
    host.commit(list.filter((c) => c.id !== selected));
    selected = null;
    host.seek(Math.min(s, Math.max(0, duration(clips()) - minLen())));
    sync();
  }

  /** Keeps the playhead in view while playing. */
  function follow() {
    const x = xOf(host.time());
    if (x > viewW - 40 || x < 0) scroller.scrollLeft = Math.max(0, PAD_L + host.time() * pps - 40);
  }

  function sync() {
    const list = clips();
    if (selected !== null && !list.some((c) => c.id === selected)) selected = null;
    if (fitMode && !drag) pps = fitPps();
    layoutWidth();
    syncZoom();
    const fps = host.fps();
    timecode.innerHTML = '';
    timecode.append(el('strong', { textContent: tc(host.time(), fps) }), ` / ${tc(total(), fps)}`);
    playBtn.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[host.playing() ? 'pause' : 'play']}</svg>`;
    undoBtn.disabled = !host.canUndo();
    redoBtn.disabled = !host.canRedo();
    deleteBtn.disabled = selected === null;
    schedule();
  }

  return {
    el: root,
    sync,
    split,
    deleteSelected,
    follow,
    /** playhead moved: redraw and update the time */
    tick() {
      const fps = host.fps();
      const strong = timecode.firstElementChild;
      if (strong) strong.textContent = tc(host.time(), fps);
      if (host.playing()) follow();
      schedule();
    },
    select(id: number | null) {
      selected = id;
      sync();
    },
    fit: fitAll,
    zoomBy,
  };
}

/** mm:ss:ff at the print frame rate. */
export function tc(t: number, fps: number): string {
  const f = Math.round(t * fps);
  const ff = f % Math.round(fps);
  const s = Math.floor(f / Math.round(fps));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

function rulerLabel(t: number, step: number, fps: number): string {
  const s = Math.floor(t + 1e-6);
  const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (step >= 1) return mmss;
  return `${mmss}:${String(Math.round((t - s) * fps)).padStart(2, '0')}`;
}

function fmtLength(s: number): string {
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

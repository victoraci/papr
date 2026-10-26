// The edit at the print frame rate, i.e. exactly the frames that end up on
// paper, with the crop of the clip on screen on top: drag the picture to move
// that crop, click it to play or pause. Playing runs the videos themselves,
// sound included, and the picture only changes when the next printed frame is
// due. Standing still seeks to the exact printed frame.

import { frameAt, frameCount, starts, type Clip } from './sequence.ts';
import { el } from './ui.ts';
import { cropRect, seek, videoElement } from './video.ts';

const LONG_SIDE = 720;
const CACHE = 90; // still frames kept, oldest go first
/** a clip that starts where the one before ends, in the same video, is played through */
const JOIN = 0.05; // s
/** where a clip's first frame is taken, a hair past its start (as in frameAt) */
const NUDGE = 0.001;
/** the next clip's player gets ready this long before the cut; earlier would cost the one playing frames */
const PREP = 2.5; // s
/** a paused video takes a moment to get going, so the next clip starts (silent) this much before the cut */
const LEAD = 0.08; // s

export interface ViewHost {
  clips(): Clip[];
  fps(): number;
  aspect(): number;
  /** the crop of a clip was dragged; done when the pointer is released */
  onCrop(id: number, x: number, y: number, done: boolean): void;
  /** another frame is on screen; t = timeline time, s */
  onTime(t: number): void;
  /** playing started or stopped */
  onPlay(): void;
}

interface Player {
  clip: Clip;
  el: HTMLVideoElement;
}

const carriesOn = (a: Clip, b: Clip) => a.video.url === b.video.url && Math.abs(b.from - a.to) < JOIN;

export function videoView(host: ViewHost) {
  const canvas = el('canvas');
  const box = el('div', { class: 'crop-box' });
  const wrap = el('div', { class: 'picture' }, canvas, box);
  // holder takes the free space; the picture is fitted into it
  const holder = el('div', { class: 'picture-holder' }, wrap);
  const ctx = canvas.getContext('2d')!;

  const cache = new Map<string, ImageBitmap>();
  let playing = false;
  let run = 0; // goes up on every play, pause and seek, so late async steps can tell they're stale
  let k = 0; // frame on screen (or wanted)
  let shown = '';
  let size = { w: 0, h: 0, a: 16 / 9 };
  /** the player on screen */
  let active: Player | null = null;
  /** the player for the next clip, waiting at its first frame (el once it's there) */
  let after: { clip: Clip; ready: Promise<HTMLVideoElement>; el?: HTMLVideoElement; early?: boolean } | null = null;
  let switching = false;

  const count = () => frameCount(host.clips(), host.fps());
  const keyOf = (i: number) => {
    const { clip, source } = frameAt(host.clips(), host.fps(), i);
    return { clip, source, key: `${clip.video.url}|${source.toFixed(3)}` };
  };

  // two players per video at most: the one on screen, and one waiting at the
  // start of the next clip when that clip is from the same video
  const pool = new Map<string, Promise<HTMLVideoElement>[]>();
  const slot = (url: string, i: number) => {
    let list = pool.get(url);
    if (!list) pool.set(url, (list = []));
    return (list[i] ??= videoElement(url));
  };
  async function player(url: string, busy?: HTMLVideoElement) {
    const first = await slot(url, 0);
    return first === busy ? slot(url, 1) : first;
  }

  function fit() {
    const w = Math.min(holder.clientWidth, holder.clientHeight * size.a);
    wrap.style.width = `${Math.floor(w)}px`;
    wrap.style.height = `${Math.floor(w / size.a)}px`;
  }
  new ResizeObserver(fit).observe(holder);

  /** Canvas sized to the video of the clip on screen. */
  function sizeFor(clip: Clip) {
    const v = clip.video;
    const s = LONG_SIDE / Math.max(v.width, v.height);
    const w = Math.round(v.width * s);
    const h = Math.round(v.height * s);
    if (w !== size.w || h !== size.h) {
      size = { w, h, a: w / h };
      canvas.width = w;
      canvas.height = h;
      holder.style.setProperty('--ar', `${w} / ${h}`); // phones size the holder by it
      fit();
      shown = '';
    }
  }

  function paint(src: CanvasImageSource, clip: Clip, key: string) {
    sizeFor(clip);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    shown = key;
    syncCrop();
  }

  const current = (): Clip | null => (count() ? keyOf(Math.min(k, count() - 1)).clip : null);
  const movable = (clip: Clip) => {
    const c = cropRect(clip.video, { aspect: host.aspect(), x: clip.cropX, y: clip.cropY });
    return c.sw < clip.video.width - 1 || c.sh < clip.video.height - 1;
  };

  function syncCrop() {
    const clip = current();
    if (!clip) return;
    const v = clip.video;
    const c = cropRect(v, { aspect: host.aspect(), x: clip.cropX, y: clip.cropY });
    box.hidden = !movable(clip);
    box.style.left = `${(c.sx / v.width) * 100}%`;
    box.style.top = `${(c.sy / v.height) * 100}%`;
    box.style.width = `${(c.sw / v.width) * 100}%`;
    box.style.height = `${(c.sh / v.height) * 100}%`;
    wrap.classList.toggle('movable', movable(clip));
    wrap.title = movable(clip) ? 'Drag to move the crop, click to play or pause' : 'Click to play or pause';
  }

  // --- standing still: the exact printed frame ---

  let stillBusy = false;
  /** Shows frame k, seeking for it unless it's cached. While scrubbing, every frame that arrives is shown. */
  async function still() {
    if (stillBusy) return;
    stillBusy = true;
    try {
      while (!playing && count()) {
        const { clip, source, key } = keyOf(Math.min(k, count() - 1));
        if (key === shown) break;
        const hit = cache.get(key);
        if (hit) {
          paint(hit, clip, key);
          continue;
        }
        const v = active?.clip.video.url === clip.video.url ? active.el : await player(clip.video.url);
        if (playing) break;
        await seek(v, source);
        if (playing) break;
        const s = LONG_SIDE / Math.max(clip.video.width, clip.video.height);
        const bmp = await createImageBitmap(v, { resizeWidth: Math.round(clip.video.width * s), resizeHeight: Math.round(clip.video.height * s) });
        cache.set(key, bmp);
        while (cache.size > CACHE) {
          const oldest = cache.keys().next().value!;
          cache.get(oldest)!.close();
          cache.delete(oldest);
        }
        active = { clip, el: v };
        if (!playing) paint(bmp, clip, key);
      }
    } finally {
      stillBusy = false;
    }
  }

  // --- playing ---

  async function go(v: HTMLVideoElement, my: number) {
    v.muted = false;
    try {
      await v.play();
    } catch (e) {
      // no sound allowed yet (no click on the page): play it silent
      if (my !== run || (e as DOMException).name !== 'NotAllowedError') return;
      v.muted = true;
      await v.play().catch(() => {});
    }
  }

  /** The next clip that needs a player of its own; clips that carry on in the same video are played through. */
  function following(list: Clip[], clip: Clip): Clip | null {
    let i = list.findIndex((c) => c.id === clip.id);
    if (i < 0) return null;
    for (let n = 0; n < list.length; n++) {
      const next = list[(i + 1) % list.length];
      if (!carriesOn(list[i], next)) return next;
      i = (i + 1) % list.length;
    }
    return null;
  }

  /** Gets the next clip's player to its first frame early, so the switch has no gap. */
  function prepare() {
    if (!active) return;
    const next = following(host.clips(), active.clip);
    if (after && next && after.clip.id === next.id && after.clip.from === next.from && after.clip.video === next.video) return;
    dropAfter();
    if (!next) return;
    const busy = active.el;
    const waiting: NonNullable<typeof after> = { clip: next, ready: player(next.video.url, busy) };
    waiting.ready = waiting.ready.then(async (v) => {
      v.pause();
      v.muted = true;
      if (Math.abs(v.currentTime - (next.from + NUDGE)) > 0.01) await seek(v, next.from + NUDGE);
      waiting.el = v;
      return v;
    });
    after = waiting;
  }

  function dropAfter() {
    if (after?.early) after.el!.pause();
    after = null;
  }

  async function play() {
    const n = count();
    if (!n || playing) return;
    if (k >= n - 1) k = 0;
    playing = true;
    const my = ++run;
    host.onPlay();
    const { clip, source } = frameAt(host.clips(), host.fps(), k);
    const v = active?.clip.video.url === clip.video.url ? active.el : await player(clip.video.url);
    if (Math.abs(v.currentTime - source) > 1 / host.fps()) await seek(v, source);
    if (my !== run) return;
    active = { clip, el: v };
    await go(v, my);
  }

  /** The clip on screen ran out: on to the next one, or back to the start. */
  async function advance() {
    const my = run;
    const list = host.clips();
    const cur = active!;
    const i = list.findIndex((c) => c.id === cur.clip.id);
    const next = list[(i + 1) % list.length];
    if (carriesOn(list[i], next)) {
      active = { clip: next, el: cur.el };
      return;
    }
    switching = true;
    try {
      cur.el.pause();
      const ready = after && after.clip.id === next.id && after.clip.from === next.from ? after.ready : null;
      if (!ready) dropAfter();
      const v = ready ? await ready : await player(next.video.url, cur.el).then(async (v) => (await seek(v, next.from + NUDGE), v));
      if (my !== run) return;
      cur.el.muted = true;
      active = { clip: next, el: v };
      after = null;
      await go(v, my);
    } finally {
      switching = false;
    }
  }

  function tick() {
    const n = count();
    if (!n && shown !== 'empty') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      box.hidden = true;
      shown = 'empty';
    }
    // hidden (other step or page): no sound from nowhere
    if (playing && !holder.getClientRects().length) pause();
    if (playing && n && active && !switching && !active.el.seeking && (!active.el.paused || active.el.ended)) {
      const list = host.clips();
      const i = list.findIndex((c) => c.id === active!.clip.id);
      if (i >= 0) {
        const clip = (active.clip = list[i]); // same clip, maybe a new crop
        const t = active.el.currentTime;
        if (t >= clip.to - 0.002 || active.el.ended) void advance();
        else {
          if (!after && clip.to - t < PREP) prepare();
          if (after?.el && !after.early && clip.to - t < LEAD && !carriesOn(clip, list[(i + 1) % list.length])) {
            after.early = true;
            void after.el.play().catch(() => {});
          }
          const at = starts(list)[i] + Math.max(0, t - clip.from);
          const kk = Math.min(n - 1, Math.floor(at * host.fps() + 1e-6));
          const { key } = keyOf(kk);
          if (key !== shown) {
            k = kk;
            paint(active.el, clip, key);
            host.onTime(k / host.fps());
          }
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', () => document.hidden && pause());

  // a click plays / pauses, a drag moves the crop
  wrap.onpointerdown = (e) => {
    const clip = current();
    if (!clip) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const r = wrap.getBoundingClientRect();
    const v = clip.video;
    const start = { x: e.clientX, y: e.clientY, cx: clip.cropX, cy: clip.cropY };
    const c = cropRect(v, { aspect: host.aspect(), x: clip.cropX, y: clip.cropY });
    // slack = how far the crop can move, as a share of the shown picture
    const slackX = (v.width - c.sw) / v.width;
    const slackY = (v.height - c.sh) / v.height;
    let dragged = false;
    let last = { x: start.cx, y: start.cy };
    wrap.onpointermove = (m) => {
      if (!dragged && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 4) return;
      dragged = true;
      if (!movable(clip)) return;
      const dx = (m.clientX - start.x) / r.width;
      const dy = (m.clientY - start.y) / r.height;
      last = {
        x: slackX > 0 ? Math.min(1, Math.max(0, start.cx + dx / slackX)) : 0.5,
        y: slackY > 0 ? Math.min(1, Math.max(0, start.cy + dy / slackY)) : 0.5,
      };
      host.onCrop(clip.id, last.x, last.y, false);
      syncCrop();
    };
    wrap.onpointerup = () => {
      wrap.onpointermove = null;
      wrap.onpointerup = null;
      if (dragged) host.onCrop(clip.id, last.x, last.y, true);
      else toggle();
    };
  };

  function pause() {
    if (!playing) return;
    playing = false;
    run++;
    active?.el.pause();
    dropAfter();
    host.onPlay();
    void still();
  }
  function toggle() {
    if (playing) pause();
    else void play();
  }

  return {
    el: holder,
    /** the edit changed: keep playing where possible, else redraw what's under the playhead */
    refresh() {
      const n = count();
      if (n) k = Math.min(k, n - 1);
      if (playing && active) {
        // carry on with the clip that holds the playing spot of the video, now
        const list = host.clips();
        const { el: v, clip: was } = active;
        const t = v.currentTime;
        const at = starts(list);
        const here = list
          .map((c, i) => ({ c, d: Math.abs(at[i] + t - c.from - k / host.fps()) }))
          .filter(({ c }) => c.video.url === was.video.url && c.from - JOIN <= t && t < c.to)
          .sort((a, b) => Number(b.c.id === was.id) - Number(a.c.id === was.id) || a.d - b.d);
        if (here.length) {
          active = { clip: here[0].c, el: v };
          dropAfter();
        } else {
          pause();
          void play();
        }
      } else void still();
      syncCrop();
    },
    seek(t: number) {
      const n = count();
      k = Math.max(0, Math.min(n - 1, Math.floor(t * host.fps() + 1e-6)));
      if (playing) pause();
      else void still();
    },
    time: () => k / host.fps(),
    playing: () => playing,
    play: () => void play(),
    pause,
    toggle,
    /** the clip under the playhead */
    current,
  };
}

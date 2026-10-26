// The edit at the print frame rate, i.e. exactly the frames that end up on
// paper, with the crop of the clip on screen on top: drag the picture to move
// that crop, click it to play or pause. Playing runs the videos themselves
// (silent) and the picture only changes when the next printed frame is due.
// The sound is mixed apart from the picture, the clips' own sound and the
// separated sounds each at their place, and its clock sets the pace.
// Standing still seeks to the exact printed frame.

import { clipAt, duration, frameAt, frameCount, soundPieces, starts, type Clip, type Edit } from './sequence.ts';
import { onSound, soundOf } from './sound.ts';
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
/** a paused video takes a moment to get going, so the next clip starts this much before the cut */
const LEAD = 0.08; // s
/** a video closer than this to the clock is caught up by playing it a little faster or slower; further off, a player is put there */
const NEAR = 0.3; // s

export interface ViewHost {
  edit(): Edit;
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

  const clips = () => host.edit().clips;
  const count = () => frameCount(clips(), host.fps());
  const keyOf = (i: number) => {
    const { clip, source } = frameAt(clips(), host.fps(), i);
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

  // --- the clock and the sound ---

  let audio: AudioContext | null = null;
  let withSound = false; // the sound card's clock, else the system's
  let voices: AudioBufferSourceNode[] = [];
  let t0 = 0; // timeline time at clock time c0
  let c0 = 0;
  const clock = () => (withSound ? audio!.currentTime : performance.now() / 1000);
  /** timeline time being heard right now */
  const now = () => t0 + Math.max(0, clock() - c0 - (withSound ? audio!.outputLatency || audio!.baseLatency || 0 : 0));

  /** Starts the clock (and the sound) at timeline time t. */
  function startAt(t: number) {
    for (const v of voices) v.stop();
    voices = [];
    t0 = t;
    c0 = clock() + (withSound ? 0.04 : 0); // a little room to start the sound on time
    if (!withSound) return;
    const end = duration(clips());
    for (const p of soundPieces(host.edit())) {
      const sound = soundOf(p.video);
      const late = Math.max(0, t - p.at); // part already past
      const length = Math.min(p.to - p.from, end - p.at) - late;
      if (!sound || length <= 0) continue;
      const v = audio!.createBufferSource();
      v.buffer = sound.buffer;
      v.connect(audio!.destination);
      v.start(c0 + Math.max(0, p.at - t), p.from + late, length);
      voices.push(v);
    }
  }
  // a sound read while playing joins in
  onSound(() => playing && c0 && startAt(now()));

  // --- playing ---

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
    const next = following(clips(), active.clip);
    if (after && next && after.clip.id === next.id && after.clip.from === next.from && after.clip.video === next.video) return;
    dropAfter();
    if (!next) return;
    const busy = active.el;
    const waiting: NonNullable<typeof after> = { clip: next, ready: player(next.video.url, busy) };
    waiting.ready = waiting.ready.then(async (v) => {
      v.pause();
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

  /** Puts the player for `clip` on screen, the waiting one if it's this clip. */
  function switchTo(clip: Clip, source: number) {
    const old = active;
    const my = run;
    const ready =
      after && after.clip.id === clip.id && after.clip.from === clip.from
        ? after.ready
        : (dropAfter(), player(clip.video.url, old?.el).then(async (v) => (await seek(v, source), v)));
    after = null;
    switching = true;
    void ready.then((v) => {
      if (my !== run) return;
      switching = false;
      if (old && old.el !== v) {
        old.el.pause();
        old.el.playbackRate = 1;
      }
      active = { clip, el: v };
      if (v.paused) void v.play().catch(() => {});
    });
  }

  /** Keeps a playing video on the clock. */
  function steer(v: HTMLVideoElement, source: number) {
    if (v.seeking) return;
    const off = source - v.currentTime;
    const rate = Math.abs(off) < 0.02 ? 1 : Math.min(1.25, Math.max(0.8, 1 + off * 2));
    if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
    if (v.paused) void v.play().catch(() => {});
  }

  /** Resolves once the video shows a new frame (or after a short while). */
  const moving = (v: HTMLVideoElement) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 400);
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(() => (clearTimeout(t), resolve()));
    });

  async function play() {
    const n = count();
    if (!n || playing) return;
    if (k >= n - 1) k = 0;
    playing = true;
    const my = ++run;
    host.onPlay();
    // the sound needs this click to be allowed to start
    audio ??= new AudioContext();
    const resumed = audio.resume().catch(() => {});
    const { clip, source } = frameAt(clips(), host.fps(), k);
    const v = active?.clip.video.url === clip.video.url ? active.el : await player(clip.video.url);
    if (Math.abs(v.currentTime - source) > 1 / host.fps()) await seek(v, source);
    if (my !== run) return;
    active = { clip, el: v };
    void v.play().catch(() => {});
    // picture and sound start together, once the video is really going
    await Promise.all([moving(v), resumed]);
    if (my !== run) return;
    withSound = audio.state === 'running';
    const start = starts(clips())[clips().findIndex((c) => c.id === clip.id)] ?? 0;
    startAt(start + Math.max(0, v.currentTime - clip.from));
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
    if (playing && n && active && c0) {
      const list = clips();
      const end = duration(list);
      let t = now();
      if (t >= end) {
        // back to the start
        startAt(0);
        t = 0;
      }
      const hit = clipAt(list, t)!;
      const { clip, start } = hit;
      const source = Math.min(clip.from + (t - start), clip.to);
      // the player on screen holds this spot of the video: keep it on the clock, else switch
      const v = active.el;
      if (active.clip.video.url === clip.video.url && Math.abs(v.currentTime - source) < NEAR) {
        active.clip = clip;
        steer(v, source);
      } else if (!switching) switchTo(clip, source);

      // the next clip: get it ready, then going just before the cut
      const left = start + clip.to - clip.from - t;
      if (!after && !switching && left < PREP) prepare();
      if (after?.el && !after.early) {
        const i = list.findIndex((c) => c.id === after!.clip.id);
        const cut = i >= 0 && starts(list)[i] > t ? starts(list)[i] : end;
        if (cut - t < LEAD) {
          after.early = true;
          void after.el.play().catch(() => {});
        }
      }

      const kk = Math.min(n - 1, Math.floor(t * host.fps() + 1e-6));
      const { key } = keyOf(kk);
      if (active.clip.id === clip.id && !v.seeking && key !== shown) {
        k = kk;
        paint(v, clip, key);
        host.onTime(k / host.fps());
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
    c0 = 0;
    switching = false;
    for (const v of voices) v.stop();
    voices = [];
    if (active) {
      active.el.pause();
      active.el.playbackRate = 1;
    }
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
    /** the edit changed: the sound follows right away, the picture on the next frame */
    refresh() {
      const n = count();
      if (n) k = Math.min(k, n - 1);
      if (playing && c0) {
        dropAfter();
        startAt(now());
      } else if (!playing) void still();
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

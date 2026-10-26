// Small DOM building blocks. Every control returns { el, sync } so the
// owner can refresh it from state without rebuilding.

export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
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

export function svgSpan(svg: string, cls: string) {
  const s = el('span', { class: cls });
  s.innerHTML = svg;
  return s;
}

export interface Control {
  el: HTMLElement;
  sync(): void;
}

export interface Option<T> {
  value: T;
  label: string;
}

/** A segmented row of options; the chosen one is filled. */
export function options<T extends string | number>(
  list: Option<T>[],
  get: () => T,
  set: (v: T) => void,
): Control & { setOptions(list: Option<T>[]): void } {
  const wrap = el('div', { class: 'options', role: 'radiogroup' });
  let opts = list;
  let buttons: HTMLButtonElement[] = [];
  const build = () => {
    buttons = opts.map((o) => el('button', { class: 'opt', role: 'radio', textContent: o.label, onclick: () => (set(o.value), sync()) }));
    wrap.replaceChildren(...buttons);
    // long lists become two even rows
    wrap.style.setProperty('--cols', String(opts.length > 5 ? Math.ceil(opts.length / 2) : Math.max(1, opts.length)));
  };
  const sync = () => buttons.forEach((b, i) => b.setAttribute('aria-checked', String(opts[i].value === get())));
  build();
  sync();
  return {
    el: wrap,
    sync,
    setOptions(next) {
      if (next.map((x) => `${x.value}:${x.label}`).join() !== opts.map((x) => `${x.value}:${x.label}`).join()) {
        opts = next;
        build();
      }
      sync();
    },
  };
}

/** Numbered steps; any of them can be opened, there is no forced order. */
export function steps<T extends string>(list: Option<T>[], get: () => T, set: (v: T) => void): Control {
  const buttons = list.map((o, i) =>
    el('button', { class: 'step', onclick: () => set(o.value) }, el('span', { class: 'step-n', textContent: String(i + 1) }), o.label),
  );
  const sync = () => buttons.forEach((b, i) => (list[i].value === get() ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
  sync();
  return { el: el('nav', { class: 'steps' }, ...buttons), sync };
}

/** A label over a control, with an optional quiet line below. */
export function field(label: string, ...children: Child[]) {
  return el('div', { class: 'field' }, el('div', { class: 'field-label', textContent: label }), ...children);
}

/** Settings that belong together, under a short title. */
export function group(title: string, ...children: Child[]) {
  return el('section', { class: 'group' }, el('h2', { class: 'group-title', textContent: title }), ...children);
}

/** The settings column: scrolling settings on top, the main button pinned below. */
export function sidebar(body: Child[], foot: Child[]) {
  return el('aside', { class: 'side' }, el('div', { class: 'side-body' }, ...body), el('div', { class: 'side-foot' }, ...foot));
}

/** Small 16 px icons for the player and editor buttons. */
export const ICONS = {
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
  sound:
    '<path d="M2.5 6.5v3M5 4.5v7M7.5 6v4M10.5 3v10M13 5.5v5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};

export type IconName = keyof typeof ICONS;

export function setIcon(b: HTMLElement, icon: IconName) {
  b.querySelector('svg')?.remove();
  b.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[icon]}</svg>`);
}

export function iconButton(icon: IconName, title: string, onclick: () => void, label?: string) {
  const b = el('button', { class: label ? 'tl-btn labelled' : 'tl-btn', title, ariaLabel: title, onclick });
  setIcon(b, icon);
  if (label) b.append(el('span', { textContent: label }));
  return b;
}

export const hint = (text = '') => el('p', { class: 'hint', textContent: text });

/** On/off row: label left, switch right. The whole row is clickable. */
export function toggleRow(label: string, get: () => boolean, set: (v: boolean) => void): Control {
  const sw = el('span', { class: 'switch' });
  const row = el('button', { class: 'toggle-row', role: 'switch' }, el('span', { textContent: label }), sw);
  const sync = () => row.setAttribute('aria-checked', String(get()));
  row.onclick = () => (set(!get()), sync());
  sync();
  return { el: row, sync };
}

/** Labelled slider with a plain-language readout. */
export function slider(
  label: string,
  attrs: { min: () => number; max: () => number; step: number },
  get: () => number,
  set: (v: number) => void,
  readout: () => string,
): Control {
  const input = el('input', { type: 'range', step: String(attrs.step) });
  const value = el('span', { class: 'muted' });
  const sync = () => {
    input.min = String(attrs.min());
    input.max = String(attrs.max());
    input.value = String(get());
    value.textContent = readout();
  };
  input.oninput = () => {
    set(Number(input.value));
    value.textContent = readout();
  };
  sync();
  return {
    el: el('div', { class: 'field' }, el('div', { class: 'field-label split' }, el('span', { textContent: label }), value), input),
    sync,
  };
}

/** Folded-away settings. */
export function more(...children: Child[]) {
  return el('details', { class: 'more' }, el('summary', { textContent: 'More settings' }), el('div', { class: 'more-body' }, ...children));
}

/** A hidden file input; open() shows the system file dialog. */
export function filePicker(accept: string, multiple: boolean, onFiles: (files: File[]) => void) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true });
  input.onchange = () => {
    const files = matching(input.files, accept);
    input.value = '';
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  document.body.append(input);
  return { open: () => input.click() };
}

/** Makes a whole area accept dropped files. */
export function dropTarget(area: HTMLElement, accept: string, multiple: boolean, onFiles: (files: File[]) => void) {
  // dragenter/leave fire for every child, so count them
  let depth = 0;
  area.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++depth === 1) area.classList.add('over');
  });
  area.addEventListener('dragover', (e) => e.preventDefault());
  area.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) area.classList.remove('over');
  });
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    area.classList.remove('over');
    const files = matching(e.dataTransfer?.files, accept);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  });
}

function matching(list: FileList | null | undefined, accept: string) {
  const rules = accept.split(',').map((a) => a.trim().toLowerCase());
  return [...(list ?? [])].filter((f) =>
    rules.some((a) => (a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a || f.name.toLowerCase().endsWith(a))),
  );
}

/** Hands a finished file to the browser's download. */
export function saveFile(url: string, name: string) {
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

/** A row of plain text options; the chosen one is lit. */
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

/** A label over a control, with an optional quiet line below. */
export function field(label: string, ...children: Child[]) {
  return el('div', { class: 'field' }, el('div', { class: 'field-label', textContent: label }), ...children);
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

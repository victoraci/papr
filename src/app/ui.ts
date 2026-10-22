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

/** Big selectable cards with a title and a quiet second line. */
export function cards<T extends string>(
  options: { value: T; title: string; hint?: string }[],
  get: () => T,
  set: (v: T) => void,
): Control {
  const wrap = el('div', { class: 'cards' });
  const buttons = options.map((o) =>
    el(
      'button',
      { class: 'card', onclick: () => (set(o.value), sync()) },
      el('span', { textContent: o.title }),
      o.hint && el('span', { class: 'hint', textContent: o.hint }),
    ),
  );
  const sync = () => buttons.forEach((b, i) => b.classList.toggle('on', options[i].value === get()));
  wrap.append(...buttons);
  sync();
  return { el: wrap, sync };
}

export function segmented<T extends string>(options: { value: T; label: string }[], get: () => T, set: (v: T) => void): Control {
  const wrap = el('div', { class: 'segmented' });
  const buttons = options.map((o) => el('button', { textContent: o.label, onclick: () => (set(o.value), sync()) }));
  const sync = () => buttons.forEach((b, i) => b.classList.toggle('on', options[i].value === get()));
  wrap.append(...buttons);
  sync();
  return { el: wrap, sync };
}

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
    el: el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('span', { textContent: label }), value), input),
    sync,
  };
}

/** A big number with − and + on either side. */
export function stepper(label: string, attrs: { min: number; max: number }, get: () => number, set: (v: number) => void, readout: () => string): Control {
  const num = el('span', { class: 'big-number' });
  const value = el('span', { class: 'muted' });
  const change = (d: number) => {
    set(Math.min(attrs.max, Math.max(attrs.min, get() + d)));
    sync();
  };
  const minus = el('button', { class: 'round', textContent: '−', ariaLabel: `Less ${label}`, onclick: () => change(-1) });
  const plus = el('button', { class: 'round', textContent: '+', ariaLabel: `More ${label}`, onclick: () => change(1) });
  const sync = () => {
    num.textContent = String(get());
    value.textContent = readout();
    minus.disabled = get() <= attrs.min;
    plus.disabled = get() >= attrs.max;
  };
  sync();
  return {
    el: el(
      'div',
      { class: 'field' },
      el('div', { class: 'field-head' }, el('span', { textContent: label }), value),
      el('div', { class: 'stepper' }, minus, num, plus),
    ),
    sync,
  };
}

/** Click-or-drop area for files. */
export function dropZone(text: string, accept: string, multiple: boolean, onFiles: (files: File[]) => void) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true });
  const label = el('span', { textContent: text });
  const zone = el('button', { class: 'drop', onclick: () => input.click() }, label, input);
  const take = (list: FileList | null | undefined) => {
    const files = [...(list ?? [])].filter((f) => accept.split(',').some((a) => matches(f, a.trim())));
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  input.onchange = () => {
    take(input.files);
    input.value = '';
  };
  zone.ondragover = (e) => {
    e.preventDefault();
    zone.classList.add('over');
  };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    take(e.dataTransfer?.files);
  };
  return { el: zone, label };
}

function matches(f: File, accept: string) {
  if (accept.endsWith('/*')) return f.type.startsWith(accept.slice(0, -1));
  return f.type === accept || f.name.toLowerCase().endsWith(accept.toLowerCase());
}

export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

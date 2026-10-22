import '@fontsource-variable/inter';
import './style.css';
import kauzalSvg from './assets/kauzal.svg?raw';
import logoSvg from './assets/rotopaper.svg?raw';
import { printPanel } from './print.ts';
import { scanPanel } from './scan.ts';
import { el, svgSpan } from './ui.ts';

const print = printPanel();
const scan = scanPanel();

// Print / Scan switch: a pill that slides to the active side
const modes = [
  { name: 'Print', panel: print.el },
  { name: 'Scan', panel: scan.el },
];
const pill = el('span', { class: 'mode-pill' });
const modeButtons = modes.map((m, i) => el('button', { textContent: m.name, onclick: () => setMode(i) }));
const modeSwitch = el('div', { class: 'mode-switch', role: 'tablist' }, pill, ...modeButtons);

function setMode(i: number) {
  modes.forEach((m, k) => {
    m.panel.hidden = k !== i;
    modeButtons[k].classList.toggle('on', k === i);
    modeButtons[k].setAttribute('aria-selected', String(k === i));
  });
  modeSwitch.style.setProperty('--at', String(i));
}

document.getElementById('app')!.append(
  el(
    'header',
    { class: 'top' },
    el(
      'div',
      { class: 'brand' },
      svgSpan(logoSvg, 'logo'),
      el('a', { class: 'by', href: 'https://kauzal.com', target: '_blank', rel: 'noopener' }, el('span', { textContent: 'by' }), svgSpan(kauzalSvg, 'kauzal')),
    ),
    modeSwitch,
    el('div'),
  ),
  print.el,
  scan.el,
);
setMode(0);

// dev hook so the flow can be driven without a file dialog
if (import.meta.env.DEV) Object.assign(window, { rotopaper: { openVideo: print.open, addScans: scan.add, state: print.state, setMode } });

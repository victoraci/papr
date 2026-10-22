import '@fontsource-variable/inter';
import './style.css';
import kauzalSvg from './assets/kauzal.svg?raw';
import logoSvg from './assets/rotopaper.svg?raw';
import { homePage } from './home.ts';
import { printPanel } from './print.ts';
import { scanPanel } from './scan.ts';
import { el, svgSpan } from './ui.ts';

const home = homePage();
const print = printPanel();
const scan = scanPanel();

// routes: #/ (home), #/print, #/scan
const views = { home: home.el, print: print.el, scan: scan.el };
type Route = keyof typeof views;
const route = (): Route => {
  const r = location.hash.replace(/^#\/?/, '');
  return r === 'print' || r === 'scan' ? r : 'home';
};

// Print / Scan switch: a pill that slides to the active side
const pill = el('span', { class: 'mode-pill' });
const modeButtons = (['print', 'scan'] as const).map((r) =>
  el('button', { textContent: r === 'print' ? 'Print' : 'Scan', onclick: () => (location.hash = `#/${r}`) }),
);
const modeSwitch = el('div', { class: 'mode-switch', role: 'tablist' }, pill, ...modeButtons);

function show() {
  const r = route();
  for (const [name, view] of Object.entries(views)) view.hidden = name !== r;
  modeSwitch.hidden = r === 'home';
  modeButtons.forEach((b, i) => {
    const on = (i === 0 ? 'print' : 'scan') === r;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  modeSwitch.style.setProperty('--at', r === 'scan' ? '1' : '0');
}
window.addEventListener('hashchange', show);

document.getElementById('app')!.append(
  el(
    'header',
    { class: 'top' },
    el(
      'div',
      { class: 'brand' },
      el('a', { class: 'logo', href: '#/', ariaLabel: 'Rotopaper home' }, svgSpan(logoSvg, 'logo-svg')),
      el('a', { class: 'by', href: 'https://kauzal.com', target: '_blank', rel: 'noopener' }, el('span', { textContent: 'by' }), svgSpan(kauzalSvg, 'kauzal')),
    ),
    modeSwitch,
    el('div'),
  ),
  home.el,
  print.el,
  scan.el,
);
show();

// dev hook so the flow can be driven without a file dialog
if (import.meta.env.DEV)
  Object.assign(window, {
    rotopaper: { openVideo: print.open, addScans: scan.add, state: print.state, go: (r: Route) => (location.hash = `#/${r}`) },
  });

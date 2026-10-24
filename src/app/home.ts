// Start page: one line on what PAPR does, the three steps, two ways in.

import { el } from './ui.ts';

export function homePage() {
  const step = (n: number, text: string) => el('li', {}, el('span', { class: 'muted', textContent: String(n) }), el('span', { textContent: text }));
  const page = el(
    'section',
    { class: 'home' },
    el(
      'div',
      { class: 'home-inner' },
      el('h1', { class: 'claim', textContent: 'Paint on your video, frame by frame.' }),
      el(
        'ol',
        { class: 'how' },
        step(1, 'Pick a video and print its frames on paper.'),
        step(2, 'Draw, paint, cut or glue on the sheets.'),
        step(3, 'Scan or photograph them and get your animation back as a video.'),
      ),
      el(
        'div',
        { class: 'actions' },
        el('a', { class: 'button primary', href: '#/print', textContent: 'Start with a video' }),
        el('a', { class: 'button', href: '#/scan', textContent: 'Add finished sheets' }),
      ),
      el('p', { class: 'hint', textContent: 'Free. Runs in your browser, nothing gets uploaded.' }),
    ),
  );
  return { el: page };
}

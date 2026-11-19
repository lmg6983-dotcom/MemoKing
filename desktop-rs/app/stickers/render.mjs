// 스티커 그림(art.html · art.css)을 PNG 로 굽는다 — 앱은 웹뷰 없이 이 PNG 를 바로 그린다 (src/sticker_win.rs)
//   4배로 구워 두고 앱이 화면 배율에 맞춰 줄인다. 그림을 고치면: node desktop-rs/app/stickers/render.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const dir = path.dirname(fileURLToPath(import.meta.url));
const SIZE = { crown: [64, 52], tape: [96, 30] };
const browser = await chromium.launch();
for (const [kind, dark, hover] of [['crown', false, false], ['crown', false, true], ['tape', false, false], ['tape', false, true], ['tape', true, false], ['tape', true, true]]) {
  const [width, height] = SIZE[kind];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 4, colorScheme: dark ? 'dark' : 'light' });
  await page.goto(`file://${dir}/art.html`);
  await page.evaluate(([k, h]) => {
    document.head.insertAdjacentHTML('beforeend', '<style>*{transition:none!important;animation:none!important}</style>');
    for (const s of document.querySelectorAll('.sticker')) s.toggleAttribute('hidden', s.id !== k);
    document.getElementById(k).classList.toggle('hover', h);
  }, [kind, hover]);
  const name = `${kind}${dark ? '-dark' : ''}${hover ? '-hover' : ''}.png`;
  await page.screenshot({ path: path.join(dir, name), omitBackground: true });
  console.log(name);
}
await browser.close();

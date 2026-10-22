#!/usr/bin/env node
// carousel.html 의 .slide 를 한 장씩 PNG 로 (1080x1350) → marketing/sns/cards/
//   사용법: node marketing/sns/render.mjs   (Playwright 필요: npm i -g playwright 또는 PLAYWRIGHT 경로)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs'));
}
const dir = import.meta.dirname;
const out = join(dir, 'cards');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1500 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(dir, 'carousel.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForLoadState('networkidle');
const ids = await page.$$eval('.slide', (s) => s.map((x) => x.id));
for (const id of ids) await page.locator(`#${id}`).screenshot({ path: join(out, `${id}.png`) });
await browser.close();
console.log(`${ids.length}장 → ${out}`);

// 약속: 메모킹 창은 모두 테두리 없이 뜬다 (main.rs window · decorations(false)) — 옮길 수 있는 창이면 화면이 창 끌기 영역을 정해야 한다.
//   새 창 · 새 덮는 화면을 만들며 잊기 쉬워(PDF로 저장 · 단축키 창 · PDF 보기 · 사진 보기가 그랬다) 사람이 일일이 보지 않고 여기서 잡는다.
//   실제 화면에서 찍어 보는 점검은 desktop-rs/app/smoke.js (창 위쪽 띠 · 덮는 화면)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = new URL('../app/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, app), 'utf8');
const readCss = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, ''); // 주석 속 글자에 속지 않게
const DRAG = /app-region:\s*drag/;

// 사람이 옮기지 않는 창 — 다른 창을 따라다니거나(말풍선 · 스티커 · 끌기 그림자) 화면 전체이거나(캡처) 숨은 창(인쇄)
const NOT_MOVABLE = new Set(['bubble.html', 'capture.html', 'ghost.html', 'hud.html', 'sticker.html', 'print.html']);

test('옮길 수 있는 창은 모두 창 끌기 영역이 있다', () => {
  const pages = fs.readdirSync(app).filter((f) => f.endsWith('.html') && !NOT_MOVABLE.has(f));
  assert.ok(pages.length >= 4, '창 페이지를 찾지 못했어요');
  const missing = pages.filter((page) => {
    const html = read(page);
    const css = [...html.matchAll(/href="(styles\/[^"]+\.css)"/g)].map((m) => readCss(m[1]));
    return !css.some((c) => DRAG.test(c));
  });
  assert.deepEqual(missing, [], `창 끌기 영역(-webkit-app-region: drag)이 없는 창: ${missing.join(', ')} — 옮기지 않는 창이면 NOT_MOVABLE 에 이유와 함께`);
});

test('창 전체를 덮으며 끌기를 끄는 화면은 스스로 끌기 영역을 둔다', () => {
  const missing = [];
  for (const file of fs.readdirSync(new URL('styles/', app)).filter((f) => f.endsWith('.css'))) {
    const css = readCss(`styles/${file}`);
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/position:\s*fixed/.test(body) || !/inset:\s*0[;\s]/.test(body) || !/app-region:\s*no-drag/.test(body)) continue;
      // .mk-pdf-view → .mk-pdf- 로 시작하는 다른 규칙 중 하나가 drag (위 막대 · 머리줄)
      const cls = selector.trim().split(/\s*,\s*/).pop().trim().match(/^\.([\w-]+)/)?.[1];
      const prefix = cls?.replace(/-[^-]+$/, '-');
      const own = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(([, s, b]) => s.includes(`.${prefix}`) && DRAG.test(b));
      if (!own) missing.push(`${file} ${selector.trim()}`);
    }
  }
  assert.deepEqual(missing, [], `창을 덮는데 창 끌기 영역이 없는 화면: ${missing.join(', ')} — 위 막대(머리줄)에 drag, 그 안 단추에 no-drag`);
});

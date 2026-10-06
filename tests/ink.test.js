import test from 'node:test';
import assert from 'node:assert/strict';
import { getStroke } from '../app/vendor/perfect-freehand.js';
import { isInk, inkAlt, bgOfAlt, inkToSvg, parseInkSvg, inkBounds, strokesHit, anchorStroke, placeStroke, findAnchor, normalizeInk, point, inkForDark, inkTone, INK_LIGHT } from '../app/js/core/ink.js';

const line = (x0, y0, x1, y1, extra = {}) => ({ tool: 'pen', color: '#1f1f1c', size: 4, pts: Array.from({ length: 11 }, (_, i) => point(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10, 0.5)), ...extra });

test('손 메모 알아보기: SVG + "손 메모" 이름, 바탕은 이름에', () => {
  assert.ok(isInk('attachments/a.svg', '손 메모'));
  assert.ok(isInk('attachments/a.svg?v=2', '손 메모 · 흰 바탕'));
  assert.ok(!isInk('attachments/a.png', '손 메모'));
  assert.ok(!isInk('attachments/logo.svg', '로고'));
  assert.equal(inkAlt('black'), '손 메모 · 검은 바탕');
  assert.equal(bgOfAlt('손 메모 · 흰 바탕'), 'white');
  assert.equal(bgOfAlt('손 메모'), 'none');
});

test('SVG 로 저장 → 다시 읽기: 크기는 그린 곳 둘레 + 여백, 자료는 그대로', () => {
  const doc = { bg: 'white', strokes: [line(100, 50, 300, 80), line(120, 120, 140, 200, { tool: 'highlighter', color: '#ffd43b', size: 20 })] };
  const svg = inkToSvg(doc, getStroke, { pad: 10 });
  const vb = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/).slice(1).map(Number);
  assert.ok(vb[0] <= 100 - 10 && vb[0] >= 100 - 14, `x ${vb[0]}`);
  assert.ok(vb[2] >= 200 && vb[2] <= 230, `w ${vb[2]}`); // 300-100 + 굵기 + 여백
  assert.ok(vb[3] >= 150 && vb[3] <= 185, `h ${vb[3]}`); // 50~200 + 형광펜 굵기 + 여백
  assert.match(svg, /<rect [^>]*fill="#ffffff"/);
  assert.match(svg, /fill-opacity="0.4"/);
  assert.equal((svg.match(/<path /g) ?? []).length, 2);
  const back = parseInkSvg(svg);
  assert.equal(back.bg, 'white');
  assert.deepEqual(back.strokes, normalizeInk(doc).strokes);
  assert.equal(inkToSvg({ strokes: [] }, getStroke), null);
  assert.equal(parseInkSvg('<svg><path d="M0 0"/></svg>'), null);
});

test('손으로 고친 자료도 안전하게', () => {
  const ink = normalizeInk({ bg: 'pink', strokes: [{ tool: 'x', color: 'red', size: 999, pts: [[1, 2, 7], ['a', 3], [4, 5]] }, { pts: [] }] });
  assert.equal(ink.bg, 'none');
  assert.equal(ink.strokes.length, 1);
  assert.deepEqual(ink.strokes[0], { tool: 'pen', color: '#1f1f1c', size: 80, pen: false, pts: [[1, 2, 1], [4, 5, 0.5]] });
});

test('지우개: 닿은 획만', () => {
  const strokes = [line(0, 0, 100, 0), line(0, 50, 100, 50)];
  assert.deepEqual(strokesHit(strokes, 50, 3, 4), [0]);
  assert.deepEqual(strokesHit(strokes, 50, 25, 4), []);
  assert.deepEqual(inkBounds([]), null);
});

test('주석: 획은 그 아래 문단을 따라가고, 폭이 달라지면 같은 비율로', () => {
  const blocks = [{ top: 0, text: '# 회의' }, { top: 40, text: '예산 검토가 필요해요' }, { top: 90, text: '일정' }];
  const s = anchorStroke(line(100, 60, 200, 70), blocks, 500); // 두 번째 문단 위
  assert.deepEqual(s.anchor, { b: 1, f: '예산 검토가 필요해요' });
  assert.equal(s.pts[0][0], 200); // 100px / 500px * 1000
  assert.equal(s.pts[0][1], 40); // (60 - 40) * 2
  // 위에 문단이 하나 생겨 아래로 밀려도, 폭이 1000px 로 넓어져도 그 문단을 따라간다
  const moved = [{ top: 0, text: '# 회의' }, { top: 40, text: '새 줄' }, { top: 80, text: '예산 검토가 필요해요' }, { top: 140, text: '일정' }];
  assert.equal(findAnchor(moved, s.anchor), 2);
  const p = placeStroke(s, moved, 1000);
  assert.deepEqual(p.pts[0].slice(0, 2), [200, 120]);
  assert.equal(p.size, 8);
  // 그 문단이 없어지면 원래 번호 (끝을 넘으면 마지막)
  assert.equal(findAnchor([{ top: 0, text: 'x' }], s.anchor), 0);
});

test('어두운 화면용: 검은 펜 ↔ 흰 펜만 바꾸고 색 펜·형광펜은 그대로', () => {
  const doc = { bg: 'none', strokes: [
    { tool: 'pen', color: '#1F1F1C', size: 4, pts: [[0, 0, 0.5], [10, 10, 0.5]] },
    { tool: 'pen', color: '#ffffff', size: 4, pts: [[0, 0, 0.5]] },
    { tool: 'pen', color: '#2f6fdf', size: 4, pts: [[0, 0, 0.5]] },
    { tool: 'highlighter', color: '#ffd43b', size: 20, pts: [[0, 0, 0.5]] },
  ] };
  const dark = inkForDark(doc);
  assert.deepEqual(dark.strokes.map((s) => s.color), [INK_LIGHT, '#1f1f1c', '#2f6fdf', '#ffd43b']);
  assert.deepEqual(doc.strokes.map((s) => inkTone(s)), ['ink-k', 'ink-w', '', '']);
  assert.equal(inkForDark({ strokes: [doc.strokes[2], doc.strokes[3]] }), null);
  // 둘레는 그대로 → 어두운 그림도 같은 크기
  assert.equal(inkToSvg(dark, getStroke).match(/viewBox="[^"]+"/)[0], inkToSvg(doc, getStroke).match(/viewBox="[^"]+"/)[0]);
});

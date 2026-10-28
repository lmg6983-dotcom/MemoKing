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

test('주석 획을 글자에 붙이기: 글자 왼쪽 위에서 글자 크기 단위 → 화면 폭 · 글자 크기가 바뀌어도 그 글자를 따라감', async () => {
  const { anchorStrokeToChar, placeStrokeAtChar, findChar } = await import('../app/js/core/ink.js');
  const text = '오늘 회의에서 정한 과녁 낱말을 적어요';
  const c = text.indexOf('과녁');
  const ring = { tool: 'pen', color: '#1f1f1c', size: 3, pts: [[300, 40, 0.5], [340, 44, 0.5], [300, 52, 0.5]] };
  const a = anchorStrokeToChar(ring, { b: 2, text, c, left: 290, top: 36, font: 16 });
  assert.equal(a.anchor.t, 'c');
  assert.equal(a.anchor.c, c);
  assert.equal(a.anchor.w, text.slice(c, c + 12));
  assert.deepEqual(a.pts[0].slice(0, 2), [10, 4], '글자 왼쪽 위에서 (16px 기준 단위)');
  // 다른 기기: 같은 글자가 다른 줄 · 다른 자리 (줄바꿈이 다름), 글자 크기 20px
  const p = placeStrokeAtChar(a, { left: 40, top: 120, font: 20 });
  assert.deepEqual(p.pts[0].slice(0, 2), [52.5, 125], '그 글자 자리에서 같은 모양 (글자 크기만큼 커짐)');
  assert.equal(p.size, 3.75);
  // 글을 조금 고쳐도 그 낱말을 다시 찾는다
  assert.equal(findChar(text, a.anchor), c);
  assert.equal(findChar(`아침에 ${text}`, a.anchor), c + 4, '앞에 글이 생겨 밀려도');
  assert.equal(findChar(text.replace('적어요', '적어 둬요'), a.anchor), c, '뒤가 고쳐져도');
  assert.equal(findChar('짧은 글', a.anchor), 3, '그 낱말이 사라지면 끝에 맞춤');
  assert.equal(findChar('', a.anchor), -1);
});

test('주석 자료: 글자에 붙인 획(t: c)의 자리는 저장 · 불러오기에서 그대로, 예전 획은 그대로 문단에', () => {
  const doc = normalizeInk({ strokes: [
    { pts: [[1, 2]], anchor: { b: 1, f: 'abc', t: 'c', c: 7, w: 'x'.repeat(40) } },
    { pts: [[1, 2]], anchor: { b: 0, f: 'old' } },
  ] });
  assert.deepEqual(doc.strokes[0].anchor, { b: 1, f: 'abc', t: 'c', c: 7, w: 'x'.repeat(12) });
  assert.deepEqual(doc.strokes[1].anchor, { b: 0, f: 'old' });
});

test('주석 묶기: 가까운 획끼리 한 묶음 (같은 글자에 함께 붙여 줄바꿈에도 흩어지지 않게), 먼 획은 따로', async () => {
  const { groupStrokes } = await import('../app/js/core/ink.js');
  const s = (pts) => ({ tool: 'pen', color: '#1f1f1c', size: 3, pts: pts.map(([x, y]) => [x, y, 0.5]) });
  const ring = s([[100, 40], [140, 44], [100, 52]]);
  const arrow = s([[150, 48], [200, 48]]); // 동그라미 옆 10px — 같은 그림
  const tick = s([[205, 40], [210, 52]]); // 화살표 끝에 닿음 — 이어서 같은 그림
  const far = s([[100, 300], [160, 300]]); // 몇 줄 아래 밑줄 — 다른 그림
  assert.deepEqual(groupStrokes([ring, arrow, far, tick]), [[0, 1, 3], [2]]);
  assert.deepEqual(groupStrokes([ring, far], 24), [[0], [1]]);
  assert.deepEqual(groupStrokes([]), []);
});

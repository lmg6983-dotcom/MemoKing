import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHighlightBox } from '../app/js/core/selection-highlight.js';

const WHITE = [255, 255, 255];
const BLUE = [215, 232, 204]; // 강조색 (BGR 순서로 둬도 견주기만 하므로 상관없음)
const INK = [30, 30, 30];

function image(w, h, fill = WHITE) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...fill, 255], i * 4);
  return { width: w, height: h, data };
}
function rect(img, x0, y0, x1, y1, c) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([...c, 255], (y * img.width + x) * 4);
}
// 글 줄: 강조 바탕 위에 글자(점)들
function line(img, x0, x1, y, h, selected) {
  if (selected) rect(img, x0, y, x1, y + h, BLUE);
  for (let x = x0 + 2; x < x1 - 2; x += 7) rect(img, x, y + 5, x + 3, y + h - 5, INK);
}

test('여러 줄 선택: 끈 시작·끝 점으로 강조색 영역 전체를 찾는다', () => {
  const img = image(400, 300);
  line(img, 20, 380, 26, 20, false); // 선택 안 된 윗줄
  line(img, 120, 380, 50, 22, true); // 첫 줄은 중간부터
  line(img, 20, 380, 72, 22, true);
  line(img, 20, 200, 94, 22, true); // 마지막 줄은 중간까지
  line(img, 20, 380, 130, 20, false);
  const box = findHighlightBox(img, { x: 121, y: 60 }, { x: 199, y: 104 });
  assert.deepEqual(box, { x: 20, y: 50, width: 360, height: 66 });
});

test('아래에서 위로 끌어도 같다', () => {
  const img = image(400, 300);
  line(img, 120, 380, 50, 22, true);
  line(img, 20, 200, 72, 22, true);
  assert.deepEqual(findHighlightBox(img, { x: 199, y: 82 }, { x: 121, y: 60 }), { x: 20, y: 50, width: 360, height: 44 });
});

test('한 줄 선택', () => {
  const img = image(400, 200);
  line(img, 60, 240, 80, 22, true);
  assert.deepEqual(findHighlightBox(img, { x: 61, y: 90 }, { x: 239, y: 90 }), { x: 60, y: 80, width: 180, height: 22 });
});

test('강조가 보이지 않으면(바탕과 같은 색) 찾지 못함', () => {
  const img = image(400, 300);
  line(img, 20, 380, 50, 22, false);
  line(img, 20, 380, 72, 22, false);
  assert.equal(findHighlightBox(img, { x: 40, y: 60 }, { x: 300, y: 82 }), null);
});

test('찾을 범위(앞 창) 밖의 같은 색은 넣지 않는다', () => {
  const img = image(500, 200);
  line(img, 60, 240, 80, 22, true);
  rect(img, 420, 80, 480, 102, BLUE); // 다른 창의 같은 색 단추
  assert.deepEqual(findHighlightBox(img, { x: 61, y: 90 }, { x: 239, y: 90 }, { within: { x: 0, y: 0, width: 400, height: 200 } }), { x: 60, y: 80, width: 180, height: 22 });
});

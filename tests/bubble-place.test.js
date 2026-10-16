import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeBubble, BUBBLE_SIZE } from '../desktop/bubble-place.js';

const area = { x: 0, y: 0, width: 1600, height: 1000 };

test('상태 말풍선 자리: 위에 자리가 있으면 창 위 바깥, 꼬리는 상태 줄 글 쪽', () => {
  const r = placeBubble({ x: 400, y: 400, width: 300, height: 400 }, area, 450);
  assert.equal(r.place, 'above');
  assert.equal(r.bounds.y + BUBBLE_SIZE.height, 398); // 창 위 가장자리 바로 위
  assert.equal(r.ax, 450 - r.bounds.x + 10);
  assert.equal(r.avoid, null);
});

test('상태 말풍선 자리: 위 스티커가 있으면 비킬 자리를 알려 줌', () => {
  const sticker = { x: 518, y: 374, width: 64, height: 52 };
  const r = placeBubble({ x: 400, y: 400, width: 300, height: 400 }, area, 450, 36, sticker);
  assert.deepEqual(r.avoid, { left: 518 - r.bounds.x, right: 582 - r.bounds.x, rise: 28 });
});

test('상태 말풍선 자리: 화면 맨 위면 옆(오른쪽 → 왼쪽), 사방에 자리가 없을 때만 윗막대 위', () => {
  const top = placeBubble({ x: 400, y: 0, width: 300, height: 400 }, area, 450);
  assert.equal(top.place, 'right');
  assert.equal(top.bounds.x, 702);
  const edge = placeBubble({ x: 1300, y: 0, width: 300, height: 400 }, area, 1350);
  assert.equal(edge.place, 'left');
  assert.equal(edge.bounds.x + BUBBLE_SIZE.width, 1298);
  const full = placeBubble({ x: 0, y: 0, width: 1600, height: 1000 }, area, 50);
  assert.equal(full.place, 'over');
});

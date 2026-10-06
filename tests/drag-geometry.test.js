import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warpDrag, slotGain, placeBadge, inflate, EASE_PX, STEP_PX, MAX_GAIN } from '../app/js/core/drag-geometry.js';

// 칸 100px 셋 (사진 줄), 칸 30px 셋 (글 줄)
const big = { tops: [0, 100, 200], slots: [100, 100, 100] };
const small = { tops: [0, 30, 60], slots: [30, 30, 30] };

test('손가락 보정: 칸 배율은 낮은 칸 1배, 높은 칸은 STEP_PX 로 지나가게 (상한 있음)', () => {
  assert.equal(slotGain(30), 1);
  assert.equal(slotGain(100), 100 / STEP_PX);
  assert.equal(slotGain(1000), MAX_GAIN);
});

test('손가락 보정: 큰 사진 칸도 손가락 약 40px 면 한 칸', () => {
  // 첫 칸 가운데(50)에서 손가락 40px → 둘째 칸 가운데 근처 (처음 10px 은 1배라 조금 덜 감)
  const c = warpDrag(50, 40, big.tops, big.slots);
  assert.ok(c > 130 && c < 150, String(c));
  // 손가락 50px 이면 넉넉히 둘째 칸 가운데를 넘는다
  assert.ok(warpDrag(50, 50, big.tops, big.slots) > 150);
  // 위로도 같게
  const up = warpDrag(250, -40, big.tops, big.slots);
  assert.ok(up < 170 && up > 150, String(up));
});

test('손가락 보정: 짧은 글 줄은 손가락 그대로 (1배)', () => {
  assert.equal(warpDrag(15, 30, small.tops, small.slots), 45);
  assert.equal(warpDrag(45, -20, small.tops, small.slots), 25);
});

test('손가락 보정: 처음 조금은 1배 (들어 올리는 순간 출렁이지 않게)', () => {
  assert.equal(warpDrag(50, 6, big.tops, big.slots), 56);
  assert.equal(warpDrag(50, EASE_PX, big.tops, big.slots), 50 + EASE_PX);
  assert.equal(warpDrag(50, 0, big.tops, big.slots), 50);
});

test('손가락 보정: 줄들 밖으로는 1배, 큰 칸 → 작은 칸으로 이어서', () => {
  assert.equal(warpDrag(290, 60, big.tops, big.slots), 290 + EASE_PX + (300 - 290 - EASE_PX) + (60 - EASE_PX));
  const mixed = { tops: [0, 100, 130], slots: [100, 30, 30] };
  // 사진 칸 가운데(50)에서: 10px 1배(→60) + 40px 를 16px 로(→100) + 글 칸 1배
  const c = warpDrag(50, 10 + 16 + 20, mixed.tops, mixed.slots);
  assert.ok(Math.abs(c - 120) < 0.01, String(c));
});

test('틀: 사방으로 넓히기', () => {
  assert.deepEqual(inflate({ left: 10, top: 20, width: 100, height: 50 }, 6), { left: 4, top: 14, width: 112, height: 62, right: 116, bottom: 76 });
});

const bounds = { left: 0, top: 0, right: 400, bottom: 800 };

test('안내 캡슐: 틀 오른쪽 바깥, 세로 가운데', () => {
  const spot = placeBadge({ frame: { left: 30, top: 100, right: 150, bottom: 200 }, bw: 80, bh: 20, bounds });
  assert.deepEqual(spot, { x: 158, y: 140, side: 'right' });
});

test('안내 캡슐: 오른쪽에 자리가 없으면(화면 폭 줄) 틀 오른쪽 위 모서리에 걸쳐서', () => {
  const spot = placeBadge({ frame: { left: 20, top: 100, right: 380, bottom: 140 }, bw: 80, bh: 20, bounds });
  assert.equal(spot.side, 'corner');
  assert.equal(spot.x + 80, 380 - 12);
  assert.equal(spot.y, 90);
});

test('안내 캡슐: 손가락에 가리면 몰래 비킨다 (손가락 피하기가 먼저)', () => {
  const frame = { left: 30, top: 100, right: 150, bottom: 200 };
  const spot = placeBadge({ frame, bw: 80, bh: 20, bounds, finger: { x: 190, y: 150, r: 34 } });
  assert.notEqual(spot.y, 140); // 가운데는 손가락 자리
  const hit = 190 > spot.x - 34 && 190 < spot.x + 80 + 34 && 150 > spot.y - 34 * 1.8 && 150 < spot.y + 20 + 34;
  assert.equal(hit, false, JSON.stringify(spot));
  // 들고 있는 내용(avoid)도 되도록 피한다
  const away = placeBadge({ frame, bw: 80, bh: 20, bounds, avoid: [{ left: 150, top: 130, right: 260, bottom: 170 }] });
  assert.equal(away.side, 'right');
  assert.ok(away.y + 20 <= 130 || away.y >= 170, JSON.stringify(away));
});

test('안내 캡슐: 화면 밖으로 나가지 않는다', () => {
  const spot = placeBadge({ frame: { left: 20, top: -30, right: 380, bottom: 10 }, bw: 80, bh: 20, bounds });
  assert.ok(spot.y >= 6 && spot.x >= 6 && spot.x + 80 <= 394);
});

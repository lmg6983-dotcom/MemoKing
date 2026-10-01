import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTables, normalizeTable, sameTables, COL_MIN, COL_MAX } from '../app/js/core/table-sizes.js';

test('열 너비·행 높이·머리글 강조를 그대로 둔다', () => {
  assert.deepEqual(normalizeTable({ cols: [120, 0, 200], rows: [0, 48], accent: true }), { cols: [120, 0, 200], rows: [0, 48], accent: true });
});

test('기본 모양(모두 0·강조 없음)은 빈 객체', () => {
  assert.deepEqual(normalizeTable({ cols: [0, 0], rows: [0], accent: false }), {});
  assert.deepEqual(normalizeTable(null), {});
});

test('너비는 정수로, 범위 안으로', () => {
  assert.deepEqual(normalizeTable({ cols: [10.6, 99999, 'x', -5, 80.4] }).cols, [COL_MIN, COL_MAX, 0, 0, 80]);
});

test('표 목록: 끝의 기본 모양 표는 빼고, 모두 기본이면 []', () => {
  assert.deepEqual(normalizeTables([{}, { accent: true }, {}, { cols: [0] }]), [{}, { accent: true }]);
  assert.deepEqual(normalizeTables([{}, {}]), []);
  assert.deepEqual(normalizeTables('abc'), []);
});

test('같은 모양인지 (기본 값 차이는 무시)', () => {
  assert.equal(sameTables([{ cols: [100] }, {}], [{ cols: [100] }]), true);
  assert.equal(sameTables([{ cols: [100] }], [{ cols: [101] }]), false);
  assert.equal(sameTables([], [{}]), true);
});

test('병합한 칸 [행, 열, 행 수, 열 수] — 맞지 않는 값은 뺀다', () => {
  assert.deepEqual(normalizeTable({ merges: [[1, 0, 2, 1], [0, 1, 1, 2], [0, 0, 1, 1], [-1, 0, 2, 2], 'x', [1, 2]] }), { merges: [[1, 0, 2, 1], [0, 1, 1, 2]] });
  assert.deepEqual(normalizeTables([{}, { merges: [[0, 0, 1, 1]] }]), []);
});

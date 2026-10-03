import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageSize, keepRatio, ratioLabel, pdfFileName, mmToPx, clampMm, MIN_MM, MAX_MM } from '../app/js/core/pdf-page.js';

test('종이 크기: 세로·가로', () => {
  assert.deepEqual(pageSize({ kind: 'paper', paper: 'a4' }), { width: 210, height: 297 });
  assert.deepEqual(pageSize({ kind: 'paper', paper: 'a4', orientation: 'landscape' }), { width: 297, height: 210 });
  assert.deepEqual(pageSize({ kind: 'paper', paper: 'a5', orientation: 'portrait' }), { width: 148, height: 210 });
  assert.deepEqual(pageSize({ kind: 'paper', paper: 'b5' }), { width: 182, height: 257 });
  assert.deepEqual(pageSize({ kind: 'paper', paper: 'letter', orientation: 'landscape' }), { width: 279.4, height: 215.9 });
});

test('종이 크기: 모르는 종이는 A4', () => {
  assert.deepEqual(pageSize({ kind: 'paper', paper: '??' }), { width: 210, height: 297 });
});

test('카드 비율: 긴 변 길이에 맞춰 비율 그대로', () => {
  assert.deepEqual(pageSize({ kind: 'ratio', ratio: '16:9', long: 160 }), { width: 160, height: 90 });
  assert.deepEqual(pageSize({ kind: 'ratio', ratio: '9:16', long: 160 }), { width: 90, height: 160 });
  assert.deepEqual(pageSize({ kind: 'ratio', ratio: '4:3', long: 200 }), { width: 200, height: 150 });
  assert.deepEqual(pageSize({ kind: 'ratio', ratio: '1:1', long: 120 }), { width: 120, height: 120 });
});

test('카드 비율: 방향은 비율에 들어 있으므로 가로/세로 선택을 따르지 않는다', () => {
  assert.deepEqual(pageSize({ kind: 'ratio', ratio: '16:9', long: 160, orientation: 'portrait' }), { width: 160, height: 90 });
});

test('직접: 50~1200mm 로 제한, 방향은 입력 그대로', () => {
  assert.deepEqual(pageSize({ kind: 'custom', width: 30, height: 2000 }), { width: MIN_MM, height: MAX_MM });
  assert.deepEqual(pageSize({ kind: 'custom', width: 300, height: 100, orientation: 'portrait' }), { width: 300, height: 100 });
  assert.equal(clampMm('abc'), MIN_MM);
  assert.equal(clampMm(123.456), 123.5);
});

test('비율 고정: 한 변을 바꾸면 다른 변이 따라온다', () => {
  assert.deepEqual(keepRatio('width', 60, { width: 100, height: 150 }), { width: 60, height: 90 });
  assert.deepEqual(keepRatio('height', 300, { width: 100, height: 150 }), { width: 200, height: 300 });
});

test('비율 고정: 다른 변이 범위를 넘으면 바꾼 변을 맞춰 비율을 지킨다', () => {
  assert.deepEqual(keepRatio('width', 1000, { width: 100, height: 150 }), { width: 800, height: 1200 });
  assert.deepEqual(keepRatio('height', 60, { width: 200, height: 100 }), { width: 120, height: 60 });
  assert.deepEqual(keepRatio('width', 40, { width: 200, height: 100 }), { width: 100, height: 50 });
});

test('비율 이름', () => {
  assert.equal(ratioLabel(160, 90), '16:9');
  assert.equal(ratioLabel(90, 160), '9:16');
  assert.equal(ratioLabel(100, 100), '1:1');
  assert.equal(ratioLabel(210, 297), '1:1.41');
  assert.equal(ratioLabel(297, 210), '1.41:1');
  assert.equal(ratioLabel(200, 100), '2:1');
});

test('mm → 화면 px (96dpi)', () => {
  assert.equal(Math.round(mmToPx(25.4)), 96);
  assert.equal(Math.round(mmToPx(210)), 794);
});

test('PDF 파일 이름: 쓸 수 없는 글자는 빼고, 비면 "메모"', () => {
  assert.equal(pdfFileName('회의록: 3/4분기?'), '회의록 3 4분기.pdf');
  assert.equal(pdfFileName(''), '메모.pdf');
  assert.equal(pdfFileName('***'), '메모.pdf');
  assert.equal(pdfFileName('가'.repeat(100)), `${'가'.repeat(80)}.pdf`);
});

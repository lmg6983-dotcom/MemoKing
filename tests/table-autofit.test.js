import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoFitTable, columnKind, CELL_PAD, MIN_COL } from '../app/js/core/table-autofit.js';

const measure = (text) => [...text].length * 10; // 한 글자 10px

test('열 종류: 번호·숫자·날짜·글', () => {
  assert.equal(columnKind('번호', ['1', '2', '3']), 'index');
  assert.equal(columnKind('항목', ['1', '2', '3']), 'index'); // 1부터 이어지는 정수
  assert.equal(columnKind('금액', ['1,200', '35,000원', '7.5%']), 'number');
  assert.equal(columnKind('날짜', ['2026-10-01', '2026.10.02', '10월 3일']), 'date');
  assert.equal(columnKind('시간', ['09:30', '오후 2:15']), 'date');
  assert.equal(columnKind('내용', ['회의 자료 정리', '예산 검토']), 'text');
  assert.equal(columnKind('비고', []), 'text');
});

test('본문 폭 안에 들어가면 내용에 맞춘 너비 (줄바꿈 없음), 정렬은 종류대로', () => {
  const grid = [['번호', '날짜', '금액', '내용'], ['1', '2026-10-01', '12,000', '점심'], ['2', '2026-10-02', '3,500', '커피']];
  const r = autoFitTable(grid, { available: 800, measure });
  assert.equal(r.fits, true);
  assert.deepEqual(r.widths, [Math.max(MIN_COL, 20 + CELL_PAD), 100 + CELL_PAD, 60 + CELL_PAD, Math.max(MIN_COL, 20 + CELL_PAD)]);
  assert.deepEqual(r.align, ['center', 'center', 'right', 'left']);
});

test('넘치면 본문 폭에 맞추고, 번호·날짜는 한 줄로 좁게, 긴 설명 열에 공간을 준다', () => {
  const long = '긴 설명이 들어가는 칸이라서 여러 줄로 나뉘어도 괜찮은 내용이에요 이것저것 적어요';
  const grid = [['번호', '날짜', '설명', '담당'], ['1', '2026-10-01', long, '김대리'], ['2', '2026-10-02', long, '박과장']];
  const available = 500;
  const r = autoFitTable(grid, { available, measure });
  assert.equal(r.fits, false);
  assert.ok(r.widths.reduce((a, b) => a + b, 0) <= available);
  assert.equal(r.widths[0], MIN_COL); // 번호: 좁게
  assert.equal(r.widths[1], 100 + CELL_PAD); // 날짜: 한 줄
  assert.equal(r.widths[3], 30 + CELL_PAD); // 담당: 한 줄 (낱말이 하나)
  assert.ok(r.widths[2] > 250, `설명 열이 가장 넓게: ${r.widths}`);
});

test('긴 내용이 있는 열에 공간을 몰아줘 표 전체 줄 수를 줄인다', () => {
  // 두 글 열: A 는 짧은 글이 많은 칸, B 는 아주 긴 글 한 칸 → B 에 공간
  const a = '짧은 글 조금';
  const b = '아주 긴 글이 들어가는 칸 '.repeat(6).trim();
  const grid = [['A', 'B'], [a, b], [a, '짧음']];
  const r = autoFitTable(grid, { available: 400, measure });
  assert.ok(r.widths[1] > r.widths[0], `${r.widths}`);
  assert.ok(r.widths[0] >= measure(a) + CELL_PAD || r.widths[0] >= 60, `${r.widths}`);
});

test('의도적인 줄바꿈은 줄마다 따로 잰다 (가장 긴 줄 너비)', () => {
  const grid = [['항목', '메모'], ['예산', '첫 줄\n둘째 줄이 조금 더 길어요']];
  const r = autoFitTable(grid, { available: 800, measure });
  assert.equal(r.widths[1], measure('둘째 줄이 조금 더 길어요') + CELL_PAD);
});

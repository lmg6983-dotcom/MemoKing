import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableBarState, tableCommandFor } from '../app/js/core/table-bar.js';
import { UI } from '../app/js/core/ui-text.js';

const base = { header: false, rows: 3, cols: 3, canMerge: false, merged: false, canSplit: false, canJoin: false, accent: false };

test('보통 칸: 행 · 열 삭제, 병합은 칸을 골라야', () => {
  const s = tableBarState(base);
  assert.deepEqual(s.delRow, { disabled: false, whole: false, label: '삭제', title: UI.rowDelete });
  assert.deepEqual(s.delCol, { disabled: false, whole: false, label: '삭제', title: UI.colDelete });
  assert.equal(s.merge.disabled, true);
  assert.equal(s.merge.title, UI.mergePick);
  assert.equal(s.split.disabled, true);
  assert.equal(s.join.title, UI.joinWhen);
});

test('머리글 행은 아래 행이 남아 있으면 삭제할 수 없다', () => {
  const s = tableBarState({ ...base, header: true, rows: 3 });
  assert.equal(s.delRow.disabled, true);
  assert.equal(s.delRow.whole, false);
});

test('머리글 행만 남았거나 열이 하나면 표 삭제', () => {
  const row = tableBarState({ ...base, header: true, rows: 1 });
  assert.equal(row.delRow.disabled, false);
  assert.equal(row.delRow.whole, true);
  assert.equal(row.delRow.label, '표 삭제');
  const col = tableBarState({ ...base, cols: 1 });
  assert.equal(col.delCol.whole, true);
  assert.equal(col.delCol.label, '표 삭제');
});

test('병합 · 병합 풀기 · 나누기 · 합치기', () => {
  assert.equal(tableBarState({ ...base, canMerge: true }).merge.label, '병합');
  assert.equal(tableBarState({ ...base, canMerge: true }).merge.disabled, false);
  const merged = tableBarState({ ...base, merged: true });
  assert.equal(merged.merge.label, '병합 풀기');
  assert.equal(merged.merge.disabled, false);
  const s = tableBarState({ ...base, canSplit: true, canJoin: true, accent: 1 });
  assert.deepEqual(s.split, { disabled: false, title: UI.splitHere });
  assert.deepEqual(s.join, { disabled: false, title: UI.joinBelow });
  assert.equal(s.accent, true);
});

test('마지막 남은 행 · 열 삭제는 표 삭제 명령으로', () => {
  assert.equal(tableCommandFor('delRow', true), 'delTable');
  assert.equal(tableCommandFor('delCol', true), 'delTable');
  assert.equal(tableCommandFor('delRow', false), 'delRow');
  assert.equal(tableCommandFor('merge', true), 'merge');
});

test('PC 메모 창과 휴대폰 메모 화면이 같은 표 막대 · 색판 · 연결 목록 코드를 쓴다', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['app/js/note.js', 'android/web/js/note-view.js']) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /note-shared\.js/, f);
    assert.match(src, /paintTableBar\(/, f);
    assert.match(src, /createPalette\(/, f);
    assert.doesNotMatch(src, /wholeTable/, `${f}: 표 막대 상태는 note-shared.js 에서만`);
    assert.doesNotMatch(src, /function openPalette/, `${f}: 색판은 note-shared.js 에서만`);
  }
});

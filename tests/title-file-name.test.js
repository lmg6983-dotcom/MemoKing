// 제목 → 메모 파일 이름 (memo-file.js titleToFileName — Rust title_to_file_name 과 같게)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleToFileName } from '../app/js/core/memo-file.js';

test('파일 이름: 60자에서 자를 때 그림 글자를 반만 남기지 않는다', () => {
  const name = titleToFileName(`${'가'.repeat(59)}😀 끝`);
  assert.equal(name, '가'.repeat(59));
  assert.ok(name.isWellFormed());
  assert.equal(titleToFileName(`${'가'.repeat(58)}😀`), `${'가'.repeat(58)}😀`);
  assert.equal(titleToFileName('a/b: c?'), 'a b c');
});

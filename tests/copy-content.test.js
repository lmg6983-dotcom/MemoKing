// 저장 단추가 쓰는 파일 이름 (copy-content.js fileNameOf)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileNameOf } from '../app/js/copy-content.js';

test('파일 이름: 못 쓰는 글자는 빈칸, 앞 30자, 크기 표시는 뺀다', () => {
  assert.equal(fileNameOf('보고서: 2026/11 "최종"?'), '보고서 2026 11 최종');
  assert.equal(fileNameOf('가'.repeat(50)), '가'.repeat(30));
  assert.equal(fileNameOf('바다 사진|50%'), '바다 사진');
  assert.equal(fileNameOf('  ', '표'), '표');
});

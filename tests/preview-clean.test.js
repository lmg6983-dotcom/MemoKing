import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPreview } from '../app/js/core/memo-file.js';

test('목록 미리보기: 글을 지운 빈 항목("- [ ]" · "2." · "-")과 글자 참조(&#x20;)는 기호로 보이지 않음', () => {
  assert.equal(extractPreview('# 체크\n\n- [ ] 하나\n- [ ]\n- [x]\n2.\n-\n'), '하나');
  assert.equal(extractPreview('# t\n\n&#x20; 들여 쓴 줄 &amp; 끝\n'), '들여 쓴 줄 & 끝');
  assert.equal(extractPreview('# t\n\n-1도\n2.5배\n'), '-1도 2.5배', '목록 표시가 아닌 글은 그대로');
});

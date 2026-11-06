import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoBodyFromText, appendToBody } from '../app/js/core/memo-text.js';

test('넘긴 글 → 메모 본문: 앞뒤 빈 줄은 빼고 줄바꿈은 그대로', () => {
  assert.equal(memoBodyFromText('\n\n  회의 3시\r\n자료 챙기기  \n\n'), '  회의 3시\n자료 챙기기');
  assert.equal(memoBodyFromText('   '), '');
});

test('덧붙이기: 빈 줄 하나를 두고, 빈 글이면 null', () => {
  assert.equal(appendToBody('# 견적서\n\n첫 줄\n\n\n', '추가 내용\n둘째 줄\n'), '# 견적서\n\n첫 줄\n\n추가 내용\n둘째 줄\n');
  assert.equal(appendToBody('', '새 글'), '새 글\n');
  assert.equal(appendToBody('# 제목', '   \n  '), null);
});

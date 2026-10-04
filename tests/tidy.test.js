import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyText } from '../app/js/tidy-text.js';

test('다듬기: 겹친 띄어쓰기·줄 앞뒤 띄어쓰기', () => {
  assert.equal(tidyText('  가나  다라   마 '), '가나 다라 마');
  assert.equal(tidyText(' 가 ', { atStart: false, atEnd: false }), ' 가 ');
});

test('다듬기: 한글 뒤 문장부호 앞 띄어쓰기, 겹친 쉼표', () => {
  assert.equal(tidyText('합니다 . 그래요 ? 네 ,, 좋아요'), '합니다. 그래요? 네, 좋아요');
  assert.equal(tidyText('a . b'), 'a . b'); // 영어는 그대로
  assert.equal(tidyText('1 . 2'), '1 . 2');
});

test('다듬기: 보이지 않는 글자·NBSP', () => {
  assert.equal(tidyText('가​나 다﻿'), '가나 다');
});

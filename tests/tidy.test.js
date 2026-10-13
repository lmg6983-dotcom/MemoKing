import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyText } from '../app/js/tidy-text.js';

test('다듬기: 줄 끝 띄어쓰기만 — 줄 앞 들여쓰기 · 겹친 띄어쓰기는 그대로 (안내 문구 칸 맞춤)', () => {
  assert.equal(tidyText('  가나  다라   마 '), '  가나  다라   마');
  assert.equal(tidyText(' 가 ', { atEnd: false }), ' 가 ');
  assert.equal(tidyText('\u00a0\u00a0국내사업부 대표'), '\u00a0\u00a0국내사업부 대표');
});

test('다듬기: 한글 뒤 문장부호 앞 띄어쓰기 (말줄임 쉼표·마침표는 그대로)', () => {
  assert.equal(tidyText('합니다 . 그래요 ? 네 , 좋아요'), '합니다. 그래요? 네, 좋아요');
  assert.equal(tidyText('그래,,, 알겠어.. 음,,'), '그래,,, 알겠어.. 음,,');
  assert.equal(tidyText('a . b'), 'a . b'); // 영어는 그대로
  assert.equal(tidyText('1 . 2'), '1 . 2');
});

test('다듬기: 보이지 않는 글자는 빼고 NBSP(줄 앞 들여쓰기)는 그대로', () => {
  assert.equal(tidyText('가\u200b나\u00a0다\ufeff'), '가나\u00a0다');
});

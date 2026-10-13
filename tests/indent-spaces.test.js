import test from 'node:test';
import assert from 'node:assert/strict';
import { keepLeadingSpaces, hasLeadingSpaces, plainSpaces, htmlSpaces, keepIndent, NBSP } from '../app/js/core/indent-spaces.js';

const N = NBSP;

test('줄 앞 띄어쓰기 · 탭은 줄 바꿈 없는 빈칸으로 (마크다운이 지우지 않게)', () => {
  assert.equal(keepLeadingSpaces('  국내사업부 대표'), `${N}${N}국내사업부 대표`);
  assert.equal(keepLeadingSpaces('첫 줄\n    네 칸\n\t탭'), `첫 줄\n${N.repeat(4)}네 칸\n${N.repeat(4)}탭`);
  assert.equal(keepIndent(' \t'), N.repeat(5));
});

test('뜻이 있는 들여쓰기 · 빈 줄 · 코드 블록은 그대로', () => {
  assert.equal(keepLeadingSpaces('- 사과\n  - 풋사과'), '- 사과\n  - 풋사과');
  assert.equal(keepLeadingSpaces('1. 하나\n   2) 둘'), '1. 하나\n   2) 둘');
  assert.equal(keepLeadingSpaces('  > 인용'), '  > 인용');
  assert.equal(keepLeadingSpaces('위\n   \n아래'), '위\n   \n아래');
  assert.equal(keepLeadingSpaces('```\n  code\n```\n  글'), `\`\`\`\n  code\n\`\`\`\n${N}${N}글`);
  assert.equal(keepLeadingSpaces('-1 은 목록이 아님'), '-1 은 목록이 아님');
});

test('앞 빈칸이 있는가', () => {
  assert.equal(hasLeadingSpaces('  안녕'), true);
  assert.equal(hasLeadingSpaces('안녕\n하세요'), false);
  assert.equal(hasLeadingSpaces('- a\n  - b'), false);
  assert.equal(hasLeadingSpaces(''), false);
});

test('복사: 일반 글자는 보통 빈칸, 서식은 이어진 빈칸을 지킴', () => {
  assert.equal(plainSpaces(`${N}${N}국내`), '  국내');
  assert.equal(htmlSpaces('a   b c'), `a${N}${N}${N}b c`);
  assert.equal(htmlSpaces(' a'), ' a');
});

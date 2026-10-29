import test from 'node:test';
import assert from 'node:assert/strict';
import { textToListMd, textToTableMd } from '../app/js/core/paste-as.js';

test('목록으로 붙여넣기: 줄마다 글머리, 빈 줄은 빼고 있던 글머리 · 번호는 떼고', () => {
  assert.equal(textToListMd('사과\n\n  배 \n• 귤\n2. 감\r\n- [ ] 할 일'), '- 사과\n- 배\n- 귤\n- 감\n- 할 일');
  assert.equal(textToListMd('\n\n'), '');
});

test('표로 붙여넣기: 탭(엑셀) · 쉼표(CSV, 따옴표 안 쉼표는 그대로) · 넓은 띄어쓰기', () => {
  assert.equal(textToTableMd('이름\t나이\n철수\t20\n영희'), '| 이름 | 나이 |\n| --- | --- |\n| 철수 | 20 |\n| 영희 |   |');
  assert.equal(textToTableMd('품목,금액\n"사과, 배",3000'), '| 품목 | 금액 |\n| --- | --- |\n| 사과, 배 | 3000 |');
  assert.equal(textToTableMd('A    B\n1    2'), '| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(textToTableMd('한 줄 글\n둘째 줄'), '| 한 줄 글 |\n| --- |\n| 둘째 줄 |', '나눌 기준이 없으면 한 칸 표');
  assert.equal(textToTableMd('a|b\tc'), '| a\\|b | c |\n| --- | --- |', '칸 속 | 는 그대로 글자로');
  assert.equal(textToTableMd('  \n'), '');
});

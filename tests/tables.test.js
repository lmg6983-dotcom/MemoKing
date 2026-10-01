import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridToHtml, parseTsv, CELL_BREAK_HTML } from '../app/js/core/tables.js';

test('칸 안의 의도적인 줄바꿈(엑셀 Alt+Enter)은 <br> 표시로 지킨다', () => {
  const html = gridToHtml([['이름', '메모'], ['김대리', '첫 줄\n둘째 줄']]);
  assert.ok(html.includes(`첫 줄${CELL_BREAK_HTML}둘째 줄`), html);
});

test('엑셀 글자 복사: 따옴표로 감싼 칸 안 줄바꿈은 한 칸에', () => {
  assert.deepEqual(parseTsv('이름\t메모\n김대리\t"첫 줄\n둘째 줄"\n박과장\t한 줄\n'), [['이름', '메모'], ['김대리', '첫 줄\n둘째 줄'], ['박과장', '한 줄']]);
});

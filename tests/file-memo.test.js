import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoBodyFromFile } from '../app/js/core/file-memo.js';

test('끌어다 놓은 파일 → 메모: .md 는 서식대로, 제목이 없으면 파일 이름', () => {
  assert.equal(memoBodyFromFile({ name: '회의.md', kind: 'text', text: '---\ntags: [a]\n---\n# 주간 회의\n\n- 하나\n- 둘\n' }), '# 주간 회의\n\n- 하나\n- 둘\n');
  assert.equal(memoBodyFromFile({ name: '장보기.md', kind: 'text', text: '- 사과\n- 배' }), '# 장보기\n\n- 사과\n- 배\n');
  assert.equal(memoBodyFromFile({ name: '메모.txt', kind: 'text', text: '첫 줄\n둘째 줄' }), '# 메모\n\n첫 줄\n\n둘째 줄\n');
  assert.equal(memoBodyFromFile({ name: '빈 파일.txt', kind: 'text', text: '' }), '# 빈 파일\n\n');
});

test('끌어다 놓은 파일 → 메모: 그림은 한 장, 그 밖의 파일은 파일 칩', () => {
  assert.equal(memoBodyFromFile({ name: '스크린샷 1.png', kind: 'image', rel: 'attachments/a.png' }), '# 스크린샷 1\n\n![스크린샷 1.png](attachments/a.png)\n');
  assert.equal(memoBodyFromFile({ name: '보고서 [최종].pdf', kind: 'file', rel: 'attachments/b.pdf' }), '# 보고서 \\[최종\\]\n\n[보고서 \\[최종\\].pdf](attachments/b.pdf)\n');
});

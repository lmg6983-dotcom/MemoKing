import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPreview, extractTitle } from '../app/js/core/memo-file.js';

test('목록 미리보기: 글을 삭제한 빈 항목("- [ ]" · "2." · "-")과 글자 참조(&#x20;)는 기호로 보이지 않음', () => {
  assert.equal(extractPreview('# 체크\n\n- [ ] 하나\n- [ ]\n- [x]\n2.\n-\n'), '하나');
  assert.equal(extractPreview('# t\n\n&#x20; 들여 쓴 줄 &amp; 끝\n'), '들여 쓴 줄 & 끝');
  assert.equal(extractPreview('# t\n\n-1도\n2.5배\n'), '-1도 2.5배', '목록 표시가 아닌 글은 그대로');
});

test('제목: 낱말 사이 밑줄은 강조가 아니라 그대로 (토큰 · snake_case), 띄어 쓴 _기울임_ · __굵게__ · *별* 은 글자만', () => {
  assert.equal(extractTitle('github_pat_11AB_cdEF\n'), 'github_pat_11AB_cdEF');
  assert.equal(extractTitle('my_var_name 고치기\n'), 'my_var_name 고치기');
  assert.equal(extractTitle('정말 _중요_ 해요\n'), '정말 중요 해요');
  assert.equal(extractTitle('__굵게__ 와 *기울임* 과 **굵게**\n'), '굵게 와 기울임 과 굵게');
  assert.equal(extractTitle('a \\_b_ c\n'), 'a _b_ c', '역슬래시로 막은 밑줄은 글자');
});

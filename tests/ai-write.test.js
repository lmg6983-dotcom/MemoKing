import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, diffEdits, applyEdits, plausibleFix, draftMessages, cleanTitle } from '../app/js/core/ai-write.js';

test('AI 글 도우미: 바뀐 낱말만 고침으로', () => {
  const a = '몇일 뒤에 다시 연락드릴께요.';
  const b = '며칠 뒤에 다시 연락드릴게요.';
  const ops = wordDiff(a, b);
  assert.deepEqual(ops.filter((o) => o.type !== 'same').map((o) => `${o.type}:${o.text}`), ['del:몇일', 'ins:며칠', 'del:연락드릴께요.', 'ins:연락드릴게요.']);
  const edits = diffEdits(ops);
  assert.deepEqual(edits, [{ from: 0, to: 2, text: '며칠' }, { from: 13, to: 14, text: '게' }]); // 낱말 안에서도 바뀐 글자만
  assert.equal(applyEdits(a, edits), b);
});

test('AI 글 도우미: 띄어쓰기 · 덧붙임 · 지움도 그대로 되살린다', () => {
  for (const [a, b] of [['그건 안되요.', '그건 안 돼요.'], ['숙제를 않하고 놀았다.', '숙제를 안 하고 놀았다.'], ['a b c', 'a c'], ['', '새 글'], ['같은 글', '같은 글']]) {
    assert.equal(applyEdits(a, diffEdits(wordDiff(a, b))), b, `${a} → ${b}`);
  }
});

test('AI 글 도우미: 작은 모델의 엉뚱한 답은 버린다', () => {
  assert.ok(plausibleFix('보고서 작성이 다 됬어요.', '보고서 작성이 다 됐어요.'));
  assert.ok(!plausibleFix('회의 정리', ''));
  assert.ok(!plausibleFix('회의 결과 정리', '会议 결과 정리'));
  assert.ok(!plausibleFix('짧은 글이에요', '짧은 글이에요. 그리고 여기에 모델이 마음대로 붙인 아주 긴 설명이 있어요.'));
  assert.ok(!plausibleFix('안건 정리 #업무', '안건 정리'));
  assert.ok(!plausibleFix('자료 https://a.com/x 참고', '자료 참고'));
  // 매직키로 저장한 질문을 답으로 바꾼 일 (v0.69.0 사용자 시험): 길이는 비슷해도 다른 글
  assert.ok(!plausibleFix('새매모로 작동하니 ?', '네, 잘 작동하고 있습니다.'));
  assert.ok(!plausibleFix('오늘 회의 몇 시야?', '오늘 회의는 3시예요.'));
  assert.ok(plausibleFix('새메모로 작동하니?', '새 메모로 작동하니?'), '띄어쓰기만 고친 것은 그대로');
});

test('AI 글 도우미: 초안은 제목 · 쓴 내용 · 부탁을 함께', () => {
  const m = draftMessages({ title: '주간 회의', body: '- 출시일', request: '' });
  assert.match(m[1].content, /주간 회의/);
  assert.match(m[1].content, /출시일/);
  assert.match(m[1].content, /초안/);
});

test('cleanTitle: 한 줄 · 기호 없이 · 30자까지, 한자 섞이면 버림', () => {
  assert.equal(cleanTitle('# "김 부장 견적 미팅".\n설명'), '김 부장 견적 미팅');
  assert.equal(cleanTitle('견적 会议'), '');
  assert.equal(cleanTitle('가'.repeat(31)), '');
  assert.equal(cleanTitle(''), '');
});

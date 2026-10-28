import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, diffEdits, applyEdits, plausibleFix, draftMessages } from '../app/js/core/ai-write.js';

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
});

test('AI 글 도우미: 초안은 제목 · 쓴 내용 · 부탁을 함께', () => {
  const m = draftMessages({ title: '주간 회의', body: '- 출시일', request: '' });
  assert.match(m[1].content, /주간 회의/);
  assert.match(m[1].content, /출시일/);
  assert.match(m[1].content, /초안/);
});

test('AI 글 도우미: 정리 · 지시대로 고치기 — 고를 일을 모델에 그대로 묻는다', async () => {
  const { runWrite } = await import('../app/js/core/ai-write.js');
  const asked = [];
  const chat = async (messages) => (asked.push(messages), '고친 글');
  assert.deepEqual(await runWrite(chat, { task: 'tidy', text: '회의 내일 3시 자료 준비' }), { text: '고친 글' });
  assert.match(asked[0][0].content, /마크다운/);
  assert.equal(asked[0].at(-1).content, '회의 내일 3시 자료 준비');
  await runWrite(chat, { task: 'custom', text: '내일 와', instruction: '더 공손하게' });
  assert.match(asked[1].at(-1).content, /^지시: 더 공손하게\n\n글:\n내일 와$/);
  const spelled = await runWrite(async (m) => (m.at(-1).content === '됬어요' ? '됐어요' : '会议'), { task: 'spell', blocks: ['됬어요', '회의'] });
  assert.deepEqual(spelled, { fixed: ['됐어요', '회의'] }); // 엉뚱한 답은 원래 글로
});

test('AI 글 도우미: 작은 모델이 되풀이한 지시문은 뗀다', async () => {
  const { cleanReply, tidyMessages } = await import('../app/js/core/ai-write.js');
  assert.equal(cleanReply('더 공손하게\n\n글:\n자료를 보내 주세요.', '더 공손하게'), '자료를 보내 주세요.');
  assert.equal(cleanReply('지시: 더 짧게\n짧은 글', '더 짧게'), '짧은 글');
  assert.equal(cleanReply('## 제목\n- 목록'), '## 제목\n- 목록');
  assert.equal(tidyMessages('메모').at(-1).content, '메모'); // 보기 한 쌍 뒤에 사용자 글
});

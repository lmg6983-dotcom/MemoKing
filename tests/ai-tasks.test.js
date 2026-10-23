import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiTasks } from '../app/js/core/ai-tasks.js';
import { createRagStore } from '../app/js/core/rag-store.js';

const memos = [
  { id: 'a', body: '# 주간 회의\n\n출시일은 11월 3일 #업무 #회의' },
  { id: 'b', body: '# 장보기\n\n우유 계란 #장보기' },
];
const tasks = (chat, status = { chat: { state: 'ready' }, embed: { state: 'missing' } }) => createAiTasks({
  ai: { status: () => status, chat, embed: async (texts) => texts.map(() => [1, 0]) },
  memos: () => memos,
  graph: () => [],
  store: createRagStore({ load: async () => null, save: async () => {} }),
});

test('AI 작업: 맞춤법은 믿을 만한 답만, 아니면 원래 글', async () => {
  const t = tasks(async (m) => (m[1].content.includes('엉뚱') ? '会议' : m[1].content.replace('됬', '됐')));
  const r = await t.write({ task: 'spell', blocks: ['다 됬어요', '엉뚱한 문단'] });
  assert.deepEqual(r.fixed, ['다 됐어요', '엉뚱한 문단']);
});

test('AI 작업: 닫은 메모 태그 — AI 가 고른 것, 못 고르면 AI 없이 확실한 것', async () => {
  assert.equal(await tasks(async () => '{"tags":["업무"]}').autoTag('# 내일 일\n\n출시 준비', 'x'), '업무');
  assert.equal(await tasks(async () => { throw new Error('모델 없음'); }).autoTag('# 내일 회의\n\n다음 주 회의 안건을 미리 정리하기', 'x'), '회의');
});

test('AI 작업: 검색 모델 없이도 낱말로 찾아 근거 메모만 주고 답', async () => {
  let asked = '';
  const r = await tasks(async (m) => { asked = m[1].content; return '11월 3일이에요 [1]'; }).ask('출시일');
  assert.equal(r.text, '11월 3일이에요 [1]');
  assert.equal(r.sources[0].id, 'a');
  assert.match(asked, /\[1\] 주간 회의/);
});

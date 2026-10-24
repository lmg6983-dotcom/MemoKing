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

test('AI 작업: 더 달 태그 — 이미 단 태그와 합쳐 3개까지, 모델 오류는 그대로 던짐', async () => {
  const two = tasks(async () => '{"tags":["업무","회의"]}');
  assert.deepEqual(await two.autoTags('# 내일 일\n\n출시 준비', 'x'), ['업무', '회의']);
  assert.deepEqual(await two.autoTags('# 내일 일\n\n출시 준비 #가 #나', 'x'), ['업무']);
  assert.deepEqual(await two.autoTags('# 내일 일 #가 #나 #다', 'x'), []);
  await assert.rejects(tasks(async () => { throw new Error('모델 없음'); }).autoTags('# 내일 회의', 'x'), /모델 없음/);
});

test('AI 작업: 검색 모델 없이도 낱말로 찾아 근거 메모만 주고 답', async () => {
  let asked = '';
  const r = await tasks(async (m) => { asked = m[1].content; return '11월 3일이에요 [1]'; }).ask('출시일');
  assert.equal(r.text, '11월 3일이에요 [1]');
  assert.equal(r.sources[0].id, 'a');
  assert.match(asked, /\[1\] 주간 회의/);
});

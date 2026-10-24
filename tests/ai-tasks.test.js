import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiTasks } from '../app/js/core/ai-tasks.js';

const memos = [
  { id: 'a', body: '# 주간 회의\n\n출시일은 11월 3일 #업무 #회의' },
  { id: 'b', body: '# 장보기\n\n우유 계란 #장보기' },
];
const tasks = (chat) => createAiTasks({
  ai: { status: () => ({ chat: { state: 'ready' } }), chat },
  memos: () => memos,
  graph: () => [],
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

test('AI 검색: 카나나2 가 질문을 넓혀 낱말로 찾고, 근거 메모만 주고 답', async () => {
  const asked = [];
  const chat = async (m, o) => {
    asked.push(m[1].content);
    if (o?.schema) return '{"words":["출시일"]}'; // "언제 내놓아" 를 메모의 낱말로 넓힘
    return '11월 3일이에요 [1]';
  };
  const r = await tasks(chat).ask('언제 내놓아');
  assert.equal(r.text, '11월 3일이에요 [1]');
  assert.equal(r.sources[0].id, 'a');
  assert.match(asked[1], /\[1\] 주간 회의/);
  // 넓히기가 실패해도 질문 낱말로는 찾는다
  const plain = await tasks(async (m, o) => { if (o?.schema) throw new Error('모델 오류'); return '우유요 [1]'; }).ask('우유');
  assert.equal(plain.sources[0].id, 'b');
});

test('AI 작업: 매직키 다듬기 — 문단마다 믿을 만한 맞춤법만, 첫 줄이 길면 맨 위에 제목', async () => {
  const chat = async (m) => (m[0].content.includes('제목')
    ? '김 부장 견적 미팅'
    : m[1].content.includes('엉뚱') ? '会议' : m[1].content.replace('됬', '됐').replace('몇일', '며칠'));
  const long = '내일 3시에 김 부장님이랑 강남역에서 만나서 견적 이야기 하기로 됬음';
  const r = await tasks(chat).polish(`${long}\n\n몇일 걸릴지 엉뚱한 문단`);
  assert.equal(r.body, `# 김 부장 견적 미팅\n\n${long.replace('됬', '됐')}\n\n몇일 걸릴지 엉뚱한 문단`);
  assert.equal(r.fixes, 1);
  assert.equal(r.title, '김 부장 견적 미팅');

  const short = await tasks(chat).polish('우유 사기');
  assert.deepEqual(short, { body: '우유 사기', fixes: 0, title: '' });
});

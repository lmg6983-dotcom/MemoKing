import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiTagRequest, aiTagResult } from '../app/js/core/ai-tags.js';

const memos = [
  { id: 'a', body: '# 주간 회의\n\n프로젝트 일정 회의 안건 정리 #업무 #회의' },
  { id: 'b', body: '# 기획 회의록\n\n출시 일정과 디자인 검토 회의 #업무' },
  { id: 'c', body: '# 장보기\n\n우유 계란 대파 두부 #장보기' },
];

test('AI 태그: 후보는 이 폴더의 기존 태그, 고를 수 있는 것만 (JSON 모양)', () => {
  const { schema, existing, messages } = aiTagRequest('# 내일 회의\n\n디자인 검토 회의 준비', memos);
  const allowed = schema.properties.tags.items.enum;
  assert.deepEqual([...allowed].sort(), ['업무', '장보기', '회의'].sort());
  assert.equal(existing[0].name, '업무'); // 많이 쓴 순
  assert.match(messages[1].content, /디자인 검토/);
});

test('AI 태그: 답을 칩으로 — 이미 단 태그 · 후보 밖은 빼고, 새 태그는 같은 뜻 기존 태그로', () => {
  const { existing } = aiTagRequest('', memos);
  assert.deepEqual(aiTagResult('{"tags":["회의","없는태그"],"new":"미팅"}', existing, '안건 #업무').map((t) => [t.name, t.existing]), [['회의', true]]);
  assert.deepEqual(aiTagResult('{"tags":[],"new":"#여행"}', existing, '제주').map((t) => [t.name, t.existing]), [['여행', false]]);
  assert.deepEqual(aiTagResult('깨진 답', existing, ''), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiTagRequest, aiTagResult } from '../app/js/core/ai-tags.js';
import { suggestTagsFor } from '../app/js/core/tag-suggest.js';

const memos = [
  { id: 'a', body: '# 주간 회의\n\n프로젝트 일정 회의 안건 정리 #업무 #회의' },
  { id: 'b', body: '# 기획 회의록\n\n출시 일정과 디자인 검토 회의 #업무' },
  { id: 'c', body: '# 장보기\n\n우유 계란 대파 두부 #장보기' },
];

test('AI 태그: 기존 태그 중에서만 고르게 하지 않고 내용에서 짓게 (후보 강제 없음), 근거 있는 기존 태그만 알려 줌', () => {
  const { schema, messages, grounded } = aiTagRequest('# 내일 회의\n\n디자인 검토 회의 준비', memos);
  assert.equal(schema.properties.tags.items.enum, undefined, '고를 수 있는 목록(enum)을 강제하지 않는다');
  assert.ok(grounded.has('회의'));
  assert.ok(!grounded.has('장보기'), '근거 없는 기존 태그는 알려 주지도 않는다');
  assert.doesNotMatch(messages[1].content, /장보기/);
  assert.match(messages[1].content, /디자인 검토/);
});

test('AI 태그: 지은 태그 — 기존 태그와 같은 말이면 그 이름으로, 근거 없는 기존 태그는 버리고, 새 태그는 그대로', () => {
  const body = '# 거래처 미팅\n\n다음 주 견적 미팅 준비 #업무';
  const { existing, grounded } = aiTagRequest(body, memos);
  const got = aiTagResult('{"tags":["미팅","장보기","견적서","업무"]}', existing, body, grounded);
  assert.deepEqual(got.map((t) => [t.name, t.existing]), [['회의', true], ['견적서', false]], '미팅 → 회의, 근거 없는 장보기 · 이미 단 업무는 빼고');
  assert.deepEqual(aiTagResult('{"tags":[]}', existing, '안녕하세요'), [], '주제가 없으면 0개');
  assert.deepEqual(aiTagResult('{"tags":["메모","기타"]}', existing, '아무 글'), [], '뜻이 넓은 말은 버림');
  assert.deepEqual(aiTagResult('깨진 답', existing, ''), []);
});

test('태그: 사용자 시험 그대로 — 인사 메일 · 짧은 대답에 #공유 · #ETRI · #임산부 같은 흔한 태그가 붙지 않는다', () => {
  // 공유로 받은 글 · ETRI 자료 · 임산부 정보가 많이 쌓인 폴더
  const vault = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, body: `# 기사 ${i}\n\n공유받은 뉴스 기사 링크 요약 ${i} #공유` })),
    ...Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, body: `# ETRI 과제 ${i}\n\n연구 과제 보고서 일정 정리 ${i} #ETRI` })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, body: `# 임산부 ${i}\n\n임산부 지원 제도 정리 ${i} #임산부` })),
  ];
  const mail = '안녕하세요 제일특허의 이민균 대리입니다.\n일전에 의뢰주신 내요은';
  const reply = '네, 잘 작동하고 있습니다.';
  for (const body of [mail, reply]) {
    const names = suggestTagsFor(body, vault).map((t) => t.name);
    for (const bad of ['공유', 'ETRI', '임산부']) assert.ok(!names.includes(bad), `추천(AI 없이): ${body.slice(0, 12)} → ${names}`);
    const { existing, grounded } = aiTagRequest(body, vault);
    const ai = aiTagResult('{"tags":["공유","ETRI","임산부"]}', existing, body, grounded).map((t) => t.name);
    assert.deepEqual(ai, [], `AI 가 흔한 태그를 골라도 근거가 없으면 버림: ${ai}`);
  }
});

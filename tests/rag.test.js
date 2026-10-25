import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMemo, retrieve, ragMessages, expandResult, finishAnswer, askedPeriod } from '../app/js/core/rag.js';

const memo = (id, title, text) => ({ id, title, text: `${title}\n${text}` });

test('AI 검색: 메모를 조각으로 (첫 조각에 제목)', () => {
  const body = `# 출시 계획\n\n${'가나다라마 '.repeat(100)}\n\n두 번째 줄`;
  const chunks = chunkMemo(body);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].startsWith('출시 계획\n'));
  assert.deepEqual(chunkMemo('# 제목만'), ['제목만']);
});

test('AI 검색: 넓힌 낱말로 찾고, 연결된 메모를 더한다', () => {
  const chunks = [
    memo('a', '주간 회의', '출시일은 11월 3일로 정했어요'),
    memo('b', '장보기', '우유 계란 대파'),
    memo('c', '디자인 시안', '두 번째 시안을 고르기로'),
    memo('d', '배포 일정', '런칭 날짜 공지 초안'),
  ];
  const related = (id) => (id === 'a' ? [{ id: 'c', score: 0.8 }] : []);
  // "언제 내놓아" 만으로는 못 찾고, 넓힌 낱말(출시일 · 런칭)로 a · d, 연결로 c
  assert.deepEqual(retrieve('언제 내놓아', chunks, { related }), []);
  const got = retrieve('언제 내놓아', chunks, { words: ['출시일', '런칭'], related, limit: 2 });
  assert.deepEqual(got.map((m) => m.id).sort(), ['a', 'c', 'd']);
  assert.equal(got.find((m) => m.id === 'c').via, 'graph');
  assert.equal(retrieve('우유', chunks)[0].id, 'b');
});

test('AI 검색: 넓힌 낱말 답 — 엉뚱하면 빈 목록, 6개까지', () => {
  assert.deepEqual(expandResult('{"words":[" 출시일 ","",3]}'), ['출시일', '3']);
  assert.deepEqual(expandResult('엉뚱한 답'), []);
  assert.equal(expandResult(JSON.stringify({ words: Array(9).fill('가') })).length, 6);
});

test('AI 검색: 답은 번호 붙인 메모만 근거로', () => {
  const m = ragMessages('출시일?', [{ title: '주간 회의', texts: ['출시일은 11월 3일'] }]);
  assert.match(m[0].content, /찾지 못했어요/);
  assert.match(m[1].content, /\[1\] 주간 회의\n출시일은 11월 3일/);
  assert.match(m[1].content, /질문: 출시일\?/);
});

test('AI 검색: 두 글자 조각으로 어미 · 줄임이 달라도 찾고, 물음 말은 빼고, 제목 · 물은 때 메모를 앞으로', () => {
  const chunks = [
    memo('a', '주간 회의', '출시일은 11월 3일로 확정했어요'),
    memo('b', '디자인', '출시 포스터 시안'),
    memo('e', '거래처 미팅 메모', '단가는 개당 1,200원으로 합의했고 납기는 12월 말'),
  ];
  assert.ok(retrieve('출시 언제 하기로 했지', chunks).some((m) => m.id === 'a'), '"출시" ↔ "출시일은"');
  assert.equal(retrieve('출시 언제 하기로 했지', chunks.filter((c) => c.id !== 'b'))[0].id, 'a');
  assert.equal(retrieve('합의한 단가 얼마야', chunks)[0].id, 'e');
  assert.deepEqual(retrieve('언제야 뭐였지', chunks), [], '물음 말만으로는 찾지 않는다');
  const now = new Date(2026, 9, 25);
  const dated = [{ ...memo('x', '회의', '안건 정리'), updated: '2026-10-24T10:00:00' }, { ...memo('y', '회의', '안건 정리'), updated: '2026-09-01T10:00:00' }];
  assert.equal(retrieve('어제 회의 안건', dated, { now })[0].id, 'x');
  assert.deepEqual(askedPeriod('지난주 회의', now), { from: new Date(2026, 9, 12), to: new Date(2026, 9, 19) });
});

test('AI 검색: 답 다듬기 — 없는 번호는 지우고, 분명히 찾았는데 물러서면 문장 그대로, 번호 없는 답엔 근거', () => {
  const picked = [{ id: 'a', title: '주간 회의', score: 0.5, via: 'match', texts: ['주간 회의\n출시일은 11월 3일로 확정했어요\n디자인은 B안'] }];
  assert.deepEqual(finishAnswer('메모에서 찾지 못했어요.', '출시일 언제야', picked), { text: '메모에 이렇게 적혀 있어요.\n“출시일은 11월 3일로 확정했어요” [1]', quoted: true });
  assert.deepEqual(finishAnswer('11월 3일이에요 [1][7]', '출시일 언제야', picked), { text: '11월 3일이에요 [1]', quoted: false });
  assert.equal(finishAnswer('11월 3일이에요', '출시일 언제야', picked).text, '11월 3일이에요\n근거: “출시일은 11월 3일로 확정했어요” [1]');
  assert.deepEqual(finishAnswer('메모에서 찾지 못했어요.', '출시일', [{ ...picked[0], score: 0.01 }]), { text: '메모에서 찾지 못했어요.', quoted: false }, '약하게 걸린 메모는 그대로 못 찾았다고');
});

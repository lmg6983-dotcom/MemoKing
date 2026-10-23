import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellOk, hasHan, stripThink, endingRate, stripTags, rankScores, tagScore } from '../scripts/ai-bench/score.js';

test('AI 비교: 맞춤법은 띄어쓰기 차이를 봐줌', () => {
  assert.ok(spellOk('그건 안 돼요.', '그건 안돼요.'));
  assert.ok(!spellOk('그건 안되요.', '그건 안 돼요.'));
});

test('AI 비교: 한자 섞임, 생각 블록 떼기', () => {
  assert.ok(hasHan('회의 結果'));
  assert.ok(!hasHan('회의 결과 OK'));
  assert.equal(stripThink('<think>음…</think>\n고친 글'), '고친 글');
});

test('AI 비교: 어미 맞춤 비율', () => {
  assert.equal(endingRate('3시로 옮겼어요. 자료를 올려 주세요.', '해요체'), 1);
  assert.equal(endingRate('3시로 옮겼습니다. 자료는 오전까지.', '합니다체'), 0.5);
  assert.equal(endingRate('- 일정 미룸', '간결체'), null);
});

test('AI 비교: 태그 지우기 · 태그 점수', () => {
  assert.equal(stripTags('# 회의\n안건 정리 #업무 #회의\n주소 a.com/#x'), '# 회의\n안건 정리  \n주소 a.com/#x');
  assert.deepEqual(tagScore(['업무', '여행'], ['업무', '회의']), { hit: true, precision: 0.5 });
  assert.deepEqual(tagScore([], ['업무']), { hit: false, precision: 0 });
});

test('AI 비교: recall@5 · MRR', () => {
  assert.deepEqual(rankScores([1, 2, 0, 6], 5), { recall: 0.5, mrr: (1 + 0.5 + 1 / 6) / 4 });
});

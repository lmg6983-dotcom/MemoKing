import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarSyllables, isHangul } from '../app/js/core/hangul-similar.js';

test('작은 글씨에서 헷갈리는 한글: 자모 하나만 비슷한 것으로', () => {
  assert.ok(similarSyllables('몰').includes('볼')); // ㅁ ↔ ㅂ
  assert.ok(similarSyllables('볼').includes('몰'));
  assert.ok(similarSyllables('블').includes('볼')); // ㅡ ↔ ㅗ
  assert.ok(similarSyllables('등').includes('동'));
  assert.ok(similarSyllables('에').includes('애')); // ㅔ ↔ ㅐ
  assert.ok(similarSyllables('춰').includes('줘')); // ㅊ ↔ ㅈ
  assert.ok(similarSyllables('밤').includes('밥')); // 받침 ㅁ ↔ ㅂ
});

test('후보에 자기 자신은 없고, 한 번에 자모 하나만 바뀐다', () => {
  for (const ch of ['몰', '볼', '가', '힣', '봤', '줘']) {
    const alts = similarSyllables(ch);
    assert.ok(!alts.includes(ch), ch);
    assert.ok(alts.every(isHangul), ch);
    assert.equal(new Set(alts).size, alts.length, ch);
  }
  assert.ok(similarSyllables('볼').length <= 12);
});

test('한글 완성형이 아니면 후보 없음', () => {
  assert.deepEqual(similarSyllables('a'), []);
  assert.deepEqual(similarSyllables('ㅋ'), []);
  assert.deepEqual(similarSyllables('?'), []);
});

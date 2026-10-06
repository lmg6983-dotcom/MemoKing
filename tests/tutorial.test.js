import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TUTORIAL_STEPS, MOBILE_TUTORIAL_STEPS, TUTORIAL_EVENTS, advanceTutorial, tutorialCounts, tutorialDone } from '../app/js/core/tutorial.js';

for (const [name, steps] of [['PC', TUTORIAL_STEPS], ['휴대폰', MOBILE_TUTORIAL_STEPS]]) {
  test(`${name} 튜토리얼: 단계마다 이모지 · 갈 길이 있음 · 사진 파일이 있음`, () => {
    const ids = steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, '같은 id 없음');
    for (const s of steps) {
      assert.ok(s.emoji, `${s.id} 이모지`);
      assert.ok(['list', 'note'].includes(s.win), s.id);
      if (s.advance) assert.ok(TUTORIAL_EVENTS.includes(s.advance), `${s.id} advance`);
      if (s.advance) assert.ok(s.try, `${s.id} 직접 해 보기 안내`);
      assert.ok(s.next || s.advance, `${s.id}: 다음 단추나 직접 해 보기 중 하나는 있어야 넘어갈 수 있음`);
      if (s.image) assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'app', 'assets', 'tutorial', s.image)), `${s.id} 사진`);
    }
    assert.ok(steps.filter((s) => s.advance).length >= 8, '직접 해 보는 단계가 넉넉히');
  });
}

test('직접 해 보기: 단계 시작 때보다 늘었을 때만', () => {
  const base = tutorialCounts('제목\n\n글', []);
  assert.equal(tutorialDone('styled', base, tutorialCounts('제목\n\n## 글', [])), true);
  assert.equal(tutorialDone('styled', tutorialCounts('제목', []), tutorialCounts('## 제목', [])), true, '첫 줄을 제목으로 바꿔도 셈');
  assert.equal(tutorialDone('styled', tutorialCounts('# 제목', []), tutorialCounts('# 제목\n', [])), false, '처음부터 있던 제목은 세지 않음');
  assert.equal(tutorialDone('tasked', base, tutorialCounts('제목\n\n- [ ] 글', [])), true);
  assert.equal(tutorialDone('tagged', base, tutorialCounts('제목 #할일', ['할일'])), true);
  assert.equal(tutorialDone('typed', tutorialCounts('', []), tutorialCounts('안녕', [])), true);
  assert.equal(tutorialDone('typed', null, tutorialCounts('안녕', [])), false);
});

test('다음에 해 볼게요(next) · 직접 해 냄(advance) 모두 다음 단계로, 끝내기는 -1', () => {
  const i = TUTORIAL_STEPS.findIndex((s) => s.id === 'style');
  assert.equal(advanceTutorial(i, 'next'), i + 1);
  assert.equal(advanceTutorial(i, 'styled'), i + 1);
  assert.equal(advanceTutorial(i, 'tasked'), i, '다른 단계의 일은 무시');
  assert.equal(advanceTutorial(i, 'skip'), -1);
  const m = MOBILE_TUTORIAL_STEPS.findIndex((s) => s.id === 'ink');
  assert.equal(MOBILE_TUTORIAL_STEPS[advanceTutorial(m, 'note-closed', MOBILE_TUTORIAL_STEPS)].win, 'list', '메모를 먼저 닫으면 목록 단계로');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TUTORIAL_STEPS, MOBILE_TUTORIAL_STEPS, TUTORIAL_EVENTS, TUTORIAL_SAMPLE, hasTutorialSample, advanceTutorial, tutorialCounts, tutorialDone, tutorialStepFor, tutorialChapter, tutorialJumps } from '../app/js/core/tutorial.js';

for (const [name, steps] of [['PC', TUTORIAL_STEPS], ['휴대폰', MOBILE_TUTORIAL_STEPS]]) {
  test(`${name} 튜토리얼: 단계마다 이모지 · 갈 길이 있음 · 사진 파일이 있음`, () => {
    const ids = steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, '같은 id 없음');
    for (const s of steps) {
      assert.ok(s.emoji, `${s.id} 이모지`);
      assert.ok(['list', 'note'].includes(s.win), s.id);
      if (s.advance) assert.ok(TUTORIAL_EVENTS.includes(s.advance), `${s.id} advance`);
      if (s.advance) assert.ok(s.try, `${s.id} 직접 해 보기 안내`);
      assert.ok(s.next || s.advance, `${s.id}: 다음 버튼이나 직접 해 보기 중 하나는 있어야 넘어갈 수 있음`);
      if (s.image) assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'app', 'assets', 'tutorial', s.image)), `${s.id} 사진`);
    }
    assert.ok(steps.filter((s) => s.advance).length >= 4, '직접 해 보는 단계가 넉넉히');
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
  const i = TUTORIAL_STEPS.findIndex((s) => s.id === 'magic');
  assert.equal(advanceTutorial(i, 'next'), i + 1);
  assert.equal(advanceTutorial(i, 'magic-tried'), i + 1);
  assert.equal(advanceTutorial(i, 'quick-memo'), i, '다른 단계의 일은 무시');
  assert.equal(advanceTutorial(i, 'skip'), -1);
  const m = MOBILE_TUTORIAL_STEPS.findIndex((s) => s.id === 'annotate');
  assert.equal(MOBILE_TUTORIAL_STEPS[advanceTutorial(m, 'note-closed', MOBILE_TUTORIAL_STEPS)].win, 'list', '메모를 먼저 닫으면 목록 단계로');
});

test('옮기기 전 예시 목록: PC·휴대폰 모두 옮기기 단계에서 한 번만', () => {
  assert.deepEqual(MOBILE_TUTORIAL_STEPS.filter((s) => s.sample).map((s) => s.id), ['move']);
  assert.deepEqual(TUTORIAL_STEPS.filter((s) => s.sample), [], 'PC는 쓰기 단계가 없다');
  assert.match(TUTORIAL_SAMPLE, /^- \[ \] /m, '체크리스트 줄');
  assert.ok(TUTORIAL_SAMPLE.split('\n').length >= 3, '옮겨 볼 줄이 넉넉히');
  assert.equal(hasTutorialSample('제목\n\n- [ ] 글'), false);
  assert.equal(hasTutorialSample(`제목\n\n${TUTORIAL_SAMPLE}`), true);
  assert.equal(hasTutorialSample(`제목\n\n${TUTORIAL_SAMPLE.replace(/\[ \]/g, '[x]')}`), true, '체크해도 다시 넣지 않음');
});

test('기능이 꺼져 있으면(needs) 직접 해 보기 없이 안내(offText)만, 켜져 있으면 그대로', () => {
  for (const steps of [TUTORIAL_STEPS, MOBILE_TUTORIAL_STEPS]) {
    for (const s of steps.filter((x) => x.needs)) {
      assert.ok(['workLife', 'quickMemo', 'magic', 'history'].includes(s.needs), s.id);
      assert.ok(s.offText, `${s.id} 꺼져 있을 때 안내`);
      const off = tutorialStepFor(s, () => false);
      assert.equal(off.advance, undefined, `${s.id}: 꺼져 있으면 기다리지 않음`);
      assert.equal(off.try, undefined);
      assert.equal(off.text, s.offText);
      assert.equal(off.next, '다음');
      const { enable, ...on } = s;
      assert.deepEqual(tutorialStepFor(s, () => true), on, '켜져 있으면 그대로 (켜기 버튼만 빠짐)');
      if (enable) assert.deepEqual(off.enable, { need: s.needs, label: enable }, `${s.id}: 꺼져 있으면 바로 켜는 버튼`);
    }
  }
  const plain = TUTORIAL_STEPS.find((s) => s.id === 'welcome');
  assert.equal(tutorialStepFor(plain, () => false), plain, 'needs가 없으면 늘 그대로');
});

test('PC: 매직키 · Life/Work · 목록 왕관 · 매직 카피 · 화면 자르기는 직접 해 보기', () => {
  const by = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s]));
  assert.deepEqual(['mode', 'list-crown', 'quick', 'capture', 'magic'].map((id) => by[id]?.advance),
    ['mode-switched', 'list-crown-on', 'quick-memo', 'capture-done', 'magic-tried']);
  const m = Object.fromEntries(MOBILE_TUTORIAL_STEPS.map((s) => [s.id, s]));
  assert.equal(m.mode?.advance, 'mode-switched', '휴대폰 Life/Work');
  assert.ok(m.move && m.annotate && m.voice, '휴대폰: 다이얼 · 글 위에 그리기 · 말로 메모');
  assert.deepEqual(['write', 'lists', 'tag', 'cards', 'layout', 'filters'].filter((id) => m[id]), [], '다른 메모 앱에도 있는 단계는 뺐다');
  assert.ok(m.tabs, '휴대폰 아래 탭 안내');
  for (const s of [...TUTORIAL_STEPS, ...MOBILE_TUTORIAL_STEPS]) assert.doesNotMatch(`${s.text} ${s.offText ?? ''}`, /추억|(?<!알림 )보관함/, `${s.id}: 지금 이름(회상 · 알림 보관함)으로`);
});

test('묶음(chapter): 모든 단계에 있고 같은 묶음은 붙어 있음 · 말풍선 머리에 "목록 2/7"', () => {
  for (const steps of [TUTORIAL_STEPS, MOBILE_TUTORIAL_STEPS]) {
    const seen = [];
    for (const [i, s] of steps.entries()) {
      assert.ok(s.chapter, `${s.id} 묶음`);
      if (steps[i - 1]?.chapter !== s.chapter) {
        assert.ok(!seen.includes(s.chapter), `${s.chapter}가 떨어져 있음`);
        seen.push(s.chapter);
      }
    }
    assert.equal(steps[0].chapter, '시작');
    assert.equal(steps.at(-1).chapter, '마무리');
  }
  const i = TUTORIAL_STEPS.findIndex((s) => s.id === 'quick');
  const c = tutorialChapter(TUTORIAL_STEPS, i);
  assert.equal(c.name, '메모킹만의 기능');
  assert.equal(c.at, 2);
  assert.equal(c.of, TUTORIAL_STEPS.filter((s) => s.chapter === '메모킹만의 기능').length);
});

test('다시 볼 때 바로 가기: 목록 화면에서 시작하는 묶음만, "시작할게요"와 같은 첫 묶음은 빼고', () => {
  assert.deepEqual(tutorialJumps(TUTORIAL_STEPS), [], 'PC는 한 묶음뿐이라 처음부터');
  for (const steps of [MOBILE_TUTORIAL_STEPS]) {
    const jumps = tutorialJumps(steps);
    assert.ok(jumps.length >= 2);
    for (const j of jumps) {
      assert.equal(steps[j.index].chapter, j.name);
      assert.equal(steps[j.index].win, 'list', `${j.name}: 메모 없이 시작할 수 있는 곳`);
      assert.notEqual(steps[j.index - 1].chapter, j.name, '묶음의 첫 단계');
      assert.ok(j.index > 1);
    }
  }
});

test('처음 말풍선 안내가 실제 단계와 맞음 (몇 분 같은 약속 없이 묶음 이름으로)', () => {
  const pc = TUTORIAL_STEPS[0].text;
  for (const name of new Set(TUTORIAL_STEPS.map((s) => s.chapter).filter((n) => !['시작', '마무리'].includes(n)))) assert.ok(pc.includes(name), `PC 처음 안내에 ${name}`);
  assert.doesNotMatch(pc, /\d+분/);
});

test('연습 공간 예시 사진을 못 읽어도 예시 메모는 모두 들어간다 (바로 던져도)', async () => {
  const { seedTutorialSandbox, TUTORIAL_SANDBOX_MEMOS } = await import('../app/js/core/tutorial.js');
  const bodies = [];
  const vault = { import: ({ body }) => (bodies.push(body), `m${bodies.length}`), setReminders: () => {} };
  await seedTutorialSandbox(vault, (d) => d.toISOString(), { photo: () => { throw new Error('없는 파일'); } });
  assert.equal(bodies.length, TUTORIAL_SANDBOX_MEMOS.length);
  assert.ok(bodies.every((b) => !b.includes('![](')));
});

test('PC 튜토리얼은 다른 메모 앱에 없는 것만 (일반 메모 기능은 뺌)', () => {
  assert.deepEqual(TUTORIAL_STEPS.map((s) => s.id), ['welcome', 'magic', 'quick', 'capture', 'list-crown', 'history', 'mode', 'done']);
  assert.ok(TUTORIAL_STEPS.every((s) => s.win === 'list'), '메모를 만들지 않고 목록 창에서만');
});

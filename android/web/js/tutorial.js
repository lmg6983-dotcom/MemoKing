// 휴대폰 튜토리얼 — PC 와 같은 말풍선(coach.js) · 같은 규칙(core/tutorial.js), 진행만 이 화면 안에서 맡는다
//   (PC 는 메인 프로세스가 창 사이를 오가며 맡는다)
//   - 처음 메모 폴더를 연 뒤 한 번 저절로 · 설정 › "사용법 둘러보기"로 언제든 다시
//   - 단계의 화면(목록 · 메모)이 보일 때만 말풍선 — 화면이 바뀌면 screenChanged()
//   - 직접 해 보기: 화면들이 tutEvent('add-opened') 처럼 알리고, 본문 변화는 textChanged(md) 로 판정
import { MOBILE_TUTORIAL_STEPS as STEPS, TUTORIAL_SETTLE_MS, TUTORIAL_SAMPLE, advanceTutorial, hasTutorialSample, tutorialCounts, tutorialDone, tutorialStepFor, tutorialChapter, tutorialJumps } from '../../app/js/core/tutorial.js';
import { extractTags } from '../../app/js/core/tags.js';
import { setupCoach } from '../../app/js/coach.js';

const DONE_KEY = 'memoking.tutorialDone';
let state = { active: false, index: -1, praise: false, again: false };
const listeners = [];
let screen = () => 'list';
let markdown = () => '';
let append = () => {};
let edit = () => {};
let has = () => true; // 직접 해 볼 기능이 켜져 있는가 (needs — core/tutorial.js tutorialStepFor)
let hooks = {}; // onStart · onFinish (연습하며 바꾼 보기를 처음대로) · enable (꺼진 기능 켜기)
let coach = null;
let base = null;
const counts = (md) => tutorialCounts(md, extractTags(md));

function payload() {
  const step = state.active ? tutorialStepFor(STEPS[state.index], has) : null;
  if (!step || step.win !== screen()) return null;
  const jumps = state.index === 0 && state.again ? tutorialJumps(STEPS) : undefined; // 다시 볼 때 어디부터
  return { ...step, index: state.index, total: STEPS.length, praise: state.praise, chapter: tutorialChapter(STEPS, state.index), jumps };
}
function send() {
  const p = payload();
  for (const cb of listeners) cb(p);
}

// coach.js 가 PC 에서 쓰는 api 모양 그대로
const api = {
  on(event, cb) {
    if (event === 'tutorial:step') listeners.push(cb);
  },
  tutorial: {
    action: (action) => {
      if (action === 'next' || action === 'skip') return event(action);
      const jump = /^jump:(\d+)$/.exec(String(action));
      if (jump && state.active && tutorialJumps(STEPS).some((j) => j.index === Number(jump[1]))) {
        state.index = Number(jump[1]);
        state.praise = false;
        return send();
      }
      if (action === 'enable:workLife' && state.active && STEPS[state.index]?.needs === 'workLife') {
        hooks.enable?.('workLife');
        send();
      }
    },
    current: async () => payload(),
  },
};

/** @param {{ screen: () => 'list'|'note', markdown: () => string, append: (md: string) => void, edit?: () => void, has?: (need: string) => boolean,
 *            onStart?: () => void, onFinish?: () => void, enable?: (need: string) => void }} o */
export function setupTutorial(o) {
  screen = o.screen;
  markdown = o.markdown;
  append = o.append;
  edit = o.edit ?? edit;
  has = o.has ?? has;
  hooks = { onStart: o.onStart, onFinish: o.onFinish, enable: o.enable };
  coach = setupCoach(api, {
    onStep: (step) => {
      base = step ? counts(markdown()) : null;
      // 옮기기를 배우기 전: 옮겨 볼 예시 목록을 메모 끝에
      if (step?.sample && screen() === 'note' && !hasTutorialSample(markdown())) append(TUTORIAL_SAMPLE);
      // 글을 써 보는 단계 · + 를 눌러 보는 단계: 다이얼이 옮기기·그리기여도 글 고치기로
      //   (+ 는 옮기기에서 숨는다 — 바로 앞 "다이얼로 옮기기" 단계에서 옮기기로 돌린 채 + 를 누르라고 해 막혔다)
      if ((step?.write || [step?.target].flat().includes('#add-btn')) && screen() === 'note') edit();
    },
  });
}

export function startTutorial() {
  let again = false;
  try {
    again = Boolean(localStorage.getItem(DONE_KEY)); // 다시 보는 사람에게는 어디부터 볼지 고르게
  } catch {
    // 처음처럼
  }
  if (!state.active) hooks.onStart?.();
  state = { active: true, index: 0, praise: false, again };
  send();
}

/** 처음이면 한 번 저절로 */
export function maybeStartTutorial() {
  let done = false;
  try {
    done = Boolean(localStorage.getItem(DONE_KEY));
  } catch {
    done = true; // 기록할 수 없으면 매번 띄우지 않게
  }
  if (!done && !state.active) startTutorial();
}

function finish() {
  state = { active: false, index: -1, praise: false, again: false };
  hooks.onFinish?.();
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    // 이번에만
  }
  send();
}

function event(name) {
  if (!state.active) return;
  const next = advanceTutorial(state.index, name, STEPS);
  if (next === state.index) return;
  if (next < 0) return finish();
  state.praise = name !== 'next' && name === STEPS[state.index]?.advance;
  state.index = next;
  // 메모 단계인데 메모가 닫혀 있으면 목록 단계로
  if (STEPS[next].win === 'note' && screen() !== 'note') return event('note-closed');
  send();
}

/** 지금 단계가 이 일을 직접 해 보기로 기다리는지 (태블릿의 목록 단추가 튜토리얼 동안 메모를 닫게) */
export const tutorialWaitsFor = (name) => state.active && STEPS[state.index]?.advance === name;

/** 직접 해 보기: 지금 단계가 이 일을 기다리면 다음으로 */
export function tutEvent(name) {
  if (state.active && STEPS[state.index]?.advance === name) event(name);
}

/** 지금 단계 id (튜토리얼 중이 아니면 null) — "Work 로 바꿔 보고 다시 Life 로" 처럼 두 번에 걸쳐 해 내는 일을 단계 안에서만 세려고 */
export const tutorialStepId = () => (state.active ? STEPS[state.index]?.id ?? null : null);

/**
 * 메모 글이 바뀔 때 — 쓰기 · 꾸미기 · 체크리스트 · 태그 판정
 *   해 냈어도 바로 넘기지 않고 손을 멈출 때까지 기다린다 (글자를 치는 중·한글 조합 중·"#할" 까지만 쳤을 때 넘어가지 않게)
 */
let settleTimer = 0;
export function textChanged(md) {
  clearTimeout(settleTimer);
  const advance = state.active ? STEPS[state.index]?.advance : null;
  if (!advance || !base || coach?.step?.id !== STEPS[state.index].id) return;
  if (!tutorialDone(advance, base, counts(md))) return;
  const id = STEPS[state.index].id;
  settleTimer = setTimeout(() => {
    const now = markdown();
    if (!state.active || STEPS[state.index]?.id !== id || !base || !tutorialDone(advance, base, counts(now))) return;
    base = null;
    event(advance);
  }, TUTORIAL_SETTLE_MS[advance] ?? 900);
}

/** 목록 ↔ 메모 화면이 바뀌면 (메모를 닫으면 메모 단계는 끝) */
export function screenChanged() {
  if (!state.active) return;
  if (screen() === 'list' && STEPS[state.index]?.win === 'note') return event('note-closed');
  send();
}


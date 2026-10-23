// 설정 › Gemini, ChatGPT 에서 메모 다루기 — MCP 없이 AI 앱의 Google Drive 연결(커넥터)로 메모 폴더를 직접 읽고 쓸 때 (PC · 휴대폰 공용)
//   AI 에게 붙여 넣을 안내문(aiDrivePrompt)은 메모킹이 실제로 읽는 형식에 맞춘다 (core/memo-file.js · drive 동기화):
//     - 메모는 폴더 바로 안의 .md 하나. Google 문서(Docs)로 만든 파일은 동기화가 건너뛴다 (내용 해시가 없는 Drive 전용 파일)
//     - 머리말의 id 는 메모킹이 처음 읽을 때 붙인다 → AI 는 쓰지 않는다 (지어낸 id 가 다른 메모와 겹치지 않게)
//     - Drive 에서 파일을 지우면 휴대폰 · PC 에서도 메모가 지워진다 → 지우기는 사람에게 묻게
//     - 다른 앱이 만든 파일은 "다른 앱 메모 가져오기"로 골라 주거나 "외부 앱 메모 연동"(전체 드라이브 권한)을 켜야 메모킹이 본다
//       (기본 권한은 메모킹이 만들었거나 사용자가 고른 파일만 — AI 가 메모킹이 만든 메모를 고친 것은 그대로 들어온다)
import { COLORS } from './core/memo-file.js';
import { icon } from './icons.js';

const el = (tag, className = '', text = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

/** AI 에게 붙여 넣을 안내문 (folder: Drive 의 메모 폴더 이름) */
export function aiDrivePrompt({ folder = '메모킹' } = {}) {
  const name = String(folder || '메모킹').trim() || '메모킹';
  return `내 Google Drive 의 "${name}" 폴더는 메모킹이라는 메모 앱의 메모 저장소예요. 이 폴더의 메모를 찾고, 읽고, 새로 쓰거나 고칠 때 아래 규칙을 꼭 지켜 주세요.

[폴더와 파일]
- 메모 하나는 "${name}" 폴더 바로 안의 .md 파일 하나예요. 하위 폴더에는 만들지 마세요.
- 새 메모는 Google 문서가 아니라 일반 텍스트 파일로 만들고, 이름 끝을 .md 로 해 주세요 (예: 회의 정리.md). Google 문서로 만들면 메모킹이 읽지 못해요.
- 파일 이름은 메모 제목과 같게 하고, 이 글자들은 쓰지 마세요: / \\ : * ? " < > |
- "_memoking" 폴더와 "attachments" 폴더 안은 메모킹이 관리해요. 만들거나 고치거나 지우지 마세요.
- 메모를 찾을 때는 "_memoking/index.json" 을 먼저 읽으면 좋아요. 모든 메모의 제목, 요약, 태그, 파일 이름이 들어 있어요.

[새 메모 형식]
파일 맨 위에 아래 머리말을 넣고, 그 아래 첫 줄을 "# 제목" 으로 시작해 주세요.

---
created: 2026-10-21T09:30:00+09:00
updated: 2026-10-21T09:30:00+09:00
color: yellow
mode: life
---
# 제목

본문

- created 와 updated 에는 지금 시각을 한국 시간(+09:00)으로 써요.
- color 는 ${COLORS.join(', ')} 중 하나예요. 모르면 yellow.
- mode 는 일과 관련된 메모면 work, 아니면 life 예요.
- id 는 쓰지 마세요. 메모킹이 처음 읽을 때 붙여요.

[본문 쓰는 법]
- 마크다운으로 써요. 소제목은 "## ", 점 목록은 "- ", 번호 목록은 "1. ", 체크리스트는 "- [ ] 할 일" (끝낸 일은 "- [x] 할 일").
- 태그는 본문에 #여행 처럼 띄어쓰기 없이 써요.
- 굵게는 **글자**, 링크는 [제목](주소), 표는 마크다운 표로 써요.

[고칠 때]
- 머리말의 id, created 와 모르는 줄은 그대로 두고, updated 만 지금 시각으로 바꿔요.
- 부탁받은 메모만 고치고, 다른 메모 파일은 건드리지 마세요.
- 본문에 "memoking-lock" 이 들어 있는 메모는 잠긴 메모예요. 읽거나 고치지 마세요.
- 파일을 지우면 휴대폰과 PC 에서도 메모가 사라져요. 지우거나 이름을 크게 바꿔야 하면 먼저 저에게 물어봐 주세요.

[일정을 넣을 때] (부탁받았을 때만)
머리말에 아래처럼 넣으면 메모킹 일정에 보이고 알림이 울려요.

reminders:
  - kind: at
    at: 2026-10-22T15:00:00+09:00
    title: 치과

- 하루 종일 일정이면 allDay: true 를 더하고, at 은 그날 00:00 으로 써요.

일을 마치면 어떤 파일을 만들었거나 고쳤는지 알려 주세요.`;
}

/** AI 에게 부탁해 볼 말 (안내 창의 예) */
export const AI_DRIVE_EXAMPLES = [
  '오늘 회의 내용을 메모킹에 새 메모로 정리해 줘',
  '메모킹에서 #여행 메모를 찾아 가 볼 곳만 모아 줘',
  '메모킹의 장보기 메모에 우유, 달걀을 체크리스트로 더해 줘',
];

/**
 * 안내 창 (<dialog>: 설정 창 위에 뜬다)
 * @param {{ folder?: string, linked?: boolean|null, copy: (text: string) => Promise<void>|void, notify?: (text: string, isError?: boolean) => void,
 *           onOverlay?: (el: HTMLElement, close: () => void) => (() => void) }} o
 *   linked: "외부 앱 메모 연동" 이 켜져 있나 (null: Drive 연결 전)
 */
export function openAiDriveGuide({ folder = '메모킹', linked = null, copy, notify = () => {}, onOverlay = null }) {
  const prompt = aiDrivePrompt({ folder });
  const dlg = el('dialog', 'dialog ai-guide');
  dlg.setAttribute('aria-labelledby', 'ai-guide-title');
  const head = el('header', 'dialog-head');
  const h = el('h2', '', 'Gemini, ChatGPT 에서 메모 다루기');
  h.id = 'ai-guide-title';
  const x = el('button', 'icon-btn dialog-x');
  x.type = 'button';
  x.setAttribute('aria-label', '닫기');
  x.append(icon('close'));
  head.append(h, x);
  const lead = el('p', 'ai-guide-lead', 'AI 앱의 Google Drive 연결로 메모킹 폴더를 직접 읽고 쓰게 하는 방법이에요. Claude 데스크톱처럼 메모킹에 바로 잇는 연결(MCP)이 없을 때 써요.');

  const steps = el('ol', 'ai-guide-steps');
  const s1 = el('li');
  s1.append(el('b', '', 'AI 가 새로 만든 메모는 가져오기로 골라요. '));
  const state = linked == null ? '먼저 Google Drive 동기화를 연결해 주세요.' : linked ? '외부 앱 메모 연동이 켜져 있어 저절로 들어와요.' : '설정의 Google Drive 동기화에서 다른 앱 메모 가져오기를 누르고 그 파일을 골라 주세요.';
  s1.append(el('span', linked ? 'ai-guide-ok' : 'ai-guide-warn', state));
  s1.append(el('small', '', '메모킹은 직접 만들었거나 사용자가 고른 파일만 열어요. 메모킹 메모를 AI 가 고친 것은 고르지 않아도 들어와요. 저절로 들어오게 하려면 고급의 외부 앱 메모 연동을 켜요.'));
  const s2 = el('li');
  s2.append(el('b', '', 'AI 앱에서 Google Drive 연결을 켜요. '));
  s2.append(el('small', '', '파일을 읽기만 하는 연결이면 메모를 찾고 요약하는 데만 쓸 수 있어요. 새 메모를 쓰려면 파일을 만들 수 있는 연결이어야 해요.'));
  const s3 = el('li');
  s3.append(el('b', '', '아래 안내문을 복사해, 대화를 시작할 때 붙여 넣어요. '));
  s3.append(el('small', '', 'AI 앱의 맞춤 지침(Gem, GPT 지침 등)에 넣어 두면 매번 붙여 넣지 않아도 돼요.'));
  const box = el('textarea', 'ai-guide-prompt');
  box.readOnly = true;
  box.rows = 8;
  box.value = prompt;
  box.setAttribute('aria-label', 'AI 에게 붙여 넣을 안내문');
  const copyBtn = el('button', 'btn primary ai-guide-copy', '안내문 복사');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    try {
      await copy(prompt);
      copyBtn.textContent = '복사했어요';
      setTimeout(() => (copyBtn.textContent = '안내문 복사'), 1800);
      notify('안내문을 복사했어요. AI 앱 대화에 붙여 넣으세요');
    } catch {
      box.select();
      notify('복사하지 못했어요. 글을 길게 눌러 복사해 주세요', true);
    }
  });
  s3.append(box, copyBtn);
  const s4 = el('li');
  s4.append(el('b', '', '이렇게 부탁해 보세요.'));
  const ex = el('ul', 'ai-guide-examples');
  for (const t of AI_DRIVE_EXAMPLES) ex.append(el('li', '', `"${t}"`));
  s4.append(ex);
  steps.append(s1, s2, s3, s4);

  const foot = el('p', 'ai-guide-note', 'AI 가 고친 메모는 다음 동기화 때, 새로 만든 메모는 가져온 뒤 목록에 나타나요. 잠긴 메모는 AI 가 읽을 수 없어요. 안내문에는 메모를 삭제 전에 먼저 묻도록 적어 두었어요.');
  dlg.append(head, lead, steps, foot);
  document.body.append(dlg);
  let release = null;
  const close = () => dlg.open && dlg.close();
  dlg.addEventListener('close', () => {
    release?.();
    dlg.remove();
  });
  x.addEventListener('click', close);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close(); // 바깥(배경)을 누르면 닫기
  });
  dlg.showModal();
  release = onOverlay?.(dlg, close) ?? null;
  copyBtn.focus({ preventScroll: true });
  return { el: dlg, close };
}

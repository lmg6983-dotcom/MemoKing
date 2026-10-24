// 처음 실행 튜토리얼 — 실제 화면의 버튼을 비추고 말풍선으로 안내한다. (순수 데이터·규칙, 단위 테스트 대상)
//   PC(TUTORIAL_STEPS)와 휴대폰(MOBILE_TUTORIAL_STEPS)이 같은 말풍선(coach.js)을 쓴다.
//   win: 말풍선을 띄울 화면 ('list' 목록 · 'note' 튜토리얼 중 만든 메모)
//   target: 비출 요소(앞에서부터 보이는 것 하나, 없으면 가운데 카드)
//   keep: 말풍선이 가리면 안 되는 곳 (직접 해 볼 본문 글 · 열리는 메뉴) — 말풍선은 이것들을 가장 덜 가리는 자리로
//   emoji: 말풍선 머리의 그림 글자 · image: 실제 화면 사진 (app/assets/tutorial/)
//   advance: 사용자가 이걸 하면 다음 단계로 (직접 해 보기) — 해 내면 "잘했어요" 칭찬과 함께 넘어간다
//   try: 직접 해 보기 안내 (말풍선 안의 '직접 해 보기' 칸)
//   sample: 이 단계가 뜨면 메모 끝에 예시 목록(TUTORIAL_SAMPLE)을 저절로 넣는다 (옮겨 볼 줄이 있게)
//   next: "다음" 버튼 글자. advance 와 함께 있으면 "다음에 해 볼게요" 처럼 이 단계만 건너뛰기
//         (없으면 직접 해 봐야 넘어감 — 튜토리얼 끝내기는 언제나 있음)
//   chapter: 묶음 이름 (말풍선 머리에 "목록 2/7" 처럼 · 다시 볼 때 어디부터 볼지 고르기) — 같은 묶음은 붙어 있다
//   enable: 꺼져 있을 때(needs) 말풍선에서 바로 켜는 단추 글자 (켜면 그 자리에서 직접 해 보기로)
//   needs: 이 기능이 켜져 있어야 직접 해 볼 수 있다 ('workLife' Work / Life 나누기 · 'quickMemo' Ctrl+Alt+C · 'magic' 매직키 · 'history' 알림 보관함)
//          꺼져 있으면 offText 로 안내만 하고 "다음"으로 (tutorialStepFor)
import { normalizeReminder } from './reminders.js';

const LATER = '다음에 해 볼게요';

/** 옮기기를 배우기 전에 메모 끝에 저절로 넣는 예시 목록 */
export const TUTORIAL_SAMPLE = '- [ ] 우유\n- [ ] 달걀\n- [ ] 사과\n- [ ] 식빵';

/**
 * 튜토리얼 연습 공간: 튜토리얼은 실제 메모 폴더 대신 잠깐 만든 빈 폴더에서 한다 (실제 메모 · 동기화 · 알림은 그대로)
 *   그 폴더에 미리 넣어 두는 예시 메모 — 목록 · 보기 · 태그 · 검색 · Work/Life · 일정 · 회상을 해 볼 거리.
 *   메모킹으로 쓸 수 있는 것(할 일 · 표 · 인용 · 굵게 · 형광펜 · 글자 색 · 코드 · 링크 · 일정)을 골고루. 끝나면 폴더째 사라진다
 *   daysAgo: 며칠 전에 쓴 메모로 (목록 · 회상 달력이 실제처럼) · events: 며칠 뒤(inDays) 몇 시(time)의 일정
 *   photos: 사진 (app/assets/tutorial/sample/이름.jpg — 회상 달력 · 사진 모아 보기가 비지 않게)
 *   예시 장보기 목록(TUTORIAL_SAMPLE)의 낱말은 쓰지 않는다 (옮기기 단계에서 헷갈리지 않게)
 *   Life 태그는 #여행 · #생활 둘만 — 휴대폰 태그 줄에서 튜토리얼 중 만든 #태그가 밀려나지 않게
 */
export const TUTORIAL_SANDBOX_MEMOS = [
  {
    body: '# 연습 공간이에요\n\n여기서 만들고 고친 메모는 튜토리얼을 마치면 **사라지고**, 내 메모로 돌아가요. 마음껏 눌러 보세요.\n\n- 카드를 누르면 열려요\n- 위쪽 <mark>태그</mark>를 누르면 그 태그가 붙은 메모만\n- 위의 검색칸에 **회의**를 쳐 보세요',
    color: 'yellow', pinned: true, daysAgo: 0,
  },
  {
    body: '# 제주 여행 준비\n\n- [x] 숙소 예약\n- [x] 렌터카\n- [ ] 비행기 표 확인\n- [ ] 선크림 챙기기\n\n> 첫날은 바다가 보이는 카페에서 쉬기\n\n#여행',
    color: 'green', daysAgo: 1, events: [{ inDays: 9, allDay: true, title: '제주 여행' }],
  },
  {
    body: '# 이번 달 생활비\n\n| 항목 | 금액 | 메모 |\n| --- | --- | --- |\n| 식비 | 320,000 | 외식 줄이기 |\n| 교통 | 68,000 | |\n| 구독 | 24,900 | 하나 해지 |\n\n<span style="color: #e03131">예산까지 87,100원</span> 남았어요\n\n#생활',
    color: 'pink', daysAgo: 4,
  },
  {
    body: '# 읽고 싶은 책\n\n1. 데미안\n2. 어린 왕자\n3. 아몬드\n\n> 새는 알에서 나오려고 투쟁한다.\n\n#생활',
    color: 'purple', daysAgo: 6,
  },
  {
    body: '# 된장찌개\n\n**재료**: 된장 2숟갈, 애호박, 두부, 양파, 청양고추\n\n1. 멸치 육수를 끓인다\n2. 된장을 풀고 채소를 넣는다\n3. <mark>두부는 마지막에</mark> 넣고 5분 더\n\n#생활',
    color: 'yellow', daysAgo: 11,
  },
  {
    body: '# 운동 기록\n\n- [x] 월 걷기 40분\n- [x] 수 수영 30분\n- [ ] 금 요가\n\n이번 주 목표: **세 번**\n\n#생활',
    color: 'gray', daysAgo: 2, events: [{ inDays: 3, time: '07:00', title: '아침 요가', alerts: [10] }],
  },
  {
    body: '# 주간 회의\n\n## 지난주\n- 시안 두 개 완성\n- 고객 피드백 정리\n\n## 이번 주\n- [ ] 최종안 고르기\n- [ ] 일정표 공유\n\n#회의',
    color: 'blue', mode: 'work', daysAgo: 3, events: [{ inDays: 2, time: '10:00', title: '주간 회의', alerts: [10] }],
  },
  {
    body: '# 출시 준비\n\n| 할 일 | 맡은 사람 | 마감 |\n| --- | --- | --- |\n| 소개 글 | 지민 | 금요일 |\n| 화면 사진 | 현우 | 목요일 |\n\n점검 명령은 `npm test` 로 돌려요. 자료는 [예시 문서](https://example.com) 에\n\n#업무',
    color: 'charcoal', mode: 'work', daysAgo: 5,
  },
  {
    body: '# 춘천 닭갈비\n\n치즈 추가는 **꼭**. 남은 양념에 볶음밥까지 먹어야 끝\n\n#여행',
    color: 'pink', daysAgo: 8, photos: ['dakgalbi-cheese', 'dakgalbi-rice'],
  },
  {
    body: '# 라멘 한 그릇\n\n흑마늘 기름이 진하다. 반숙 달걀은 하나 더 시키기\n\n#생활',
    color: 'gray', daysAgo: 6, photos: ['ramen'],
  },
  {
    body: '# 레몬 파스타\n\n구운 레몬을 짜서 먹으니 산뜻했다. <span style="color: #e03131">고추가 은근 매움</span>\n\n#생활',
    color: 'blue', daysAgo: 3, photos: ['pasta'],
  },
  {
    body: '# 기념일 저녁\n\n스테이크와 피시앤칩스, 맥주 한 잔\n\n> 내년에도 여기서\n\n#생활',
    color: 'purple', daysAgo: 10, photos: ['steak', 'fish-and-chips'],
  },
  {
    body: '# 인절미 토스트\n\n콩고물이 산처럼 쌓여 나온다. <mark>둘이서 하나면 충분</mark>\n\n#생활',
    color: 'yellow', daysAgo: 12, photos: ['injeolmi-toast'],
  },
  {
    body: '# 캠핑 불멍\n\n장작 두 묶음이면 밤새 충분했다.\n\n다음 캠핑 준비물\n- [ ] 장갑\n- [ ] 접이식 의자\n\n#여행',
    color: 'charcoal', daysAgo: 13, photos: ['campfire'],
  },
  {
    body: '# 파르페와 라자냐\n\n창가 자리 그네 의자가 귀엽다\n\n#생활',
    color: 'pink', daysAgo: 17, photos: ['parfait'],
  },
  {
    body: '# 미국식 한 접시\n\n칠리 감자튀김, 나초, 소시지. 셋이 먹어도 남았다\n\n#생활',
    color: 'yellow', daysAgo: 19, photos: ['chili-platter'],
  },
];

/**
 * 연습 공간 예시 메모를 볼트에 넣는다 (PC · 휴대폰 볼트 모두 import · setReminders 가 같다)
 * @param {(name: string) => Promise<string|null>|string|null} [photo] 예시 사진 하나를 볼트 첨부로 넣고 그 경로 (못 넣으면 null — 그 사진은 빼고)
 */
export async function seedTutorialSandbox(vault, toIso, { now = new Date(), photo = () => null } = {}) {
  const day = (n, time = '09:00') => {
    const [h, m] = time.split(':').map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, h, m);
  };
  for (const [i, m] of TUTORIAL_SANDBOX_MEMOS.entries()) {
    // 같은 날 쓴 메모도 순서가 늘 같게 (뒤의 것일수록 조금 앞선 시각)
    const at = toIso(new Date(now.getTime() - m.daysAgo * 86_400_000 - i * 60_000));
    const pics = [];
    for (const name of m.photos ?? []) {
      const rel = await Promise.resolve().then(() => photo(name)).catch(() => null); // 사진을 못 읽어도(바로 던지든 나중에 실패하든) 글만으로
      if (rel) pics.push(`![](${rel})`);
    }
    const body = pics.length ? `${m.body}\n\n${pics.join('\n\n')}` : m.body;
    const id = vault.import({ body, color: m.color, mode: m.mode, pinned: m.pinned === true, created: at, updated: at });
    if (id && m.events?.length) {
      vault.setReminders(id, m.events.map((e, k) => normalizeReminder({
        id: `tut-${i}-${k}`, kind: 'at', action: 'notify', title: e.title, created: at,
        at: toIso(day(e.inDays, e.allDay ? '00:00' : e.time)), allDay: e.allDay === true, alerts: e.alerts, // 하루 종일은 그날 00:00
      }, now)));
    }
  }
}

/** 예시 목록이 이미 들어 있는지 (단계가 다시 떠도 두 번 넣지 않게) */
export function hasTutorialSample(md) {
  const text = String(md ?? '');
  return TUTORIAL_SAMPLE.split('\n').every((line) => text.includes(line.replace('- [ ] ', '')));
}

export const TUTORIAL_STEPS = [
  // 다른 메모 앱에 없는 것만 (일반 메모 기능은 써 보면 아는 것이라 뺐다 — 0.68.0)
  {
    id: 'welcome', chapter: '시작', win: 'list', target: [], emoji: '👑',
    title: '반가워요! 메모킹이에요',
    text: '다른 메모 앱에 없는 메모킹만의 기능을 직접 눌러 봐요. 첫 번째는 어디서든 부르는 매직키예요. 내 메모는 그대로, 예시 메모가 든 연습 공간에서 해요.',
    next: '매직키부터 해 볼게요', skip: '나중에 볼게요',
  },
  {
    id: 'magic', chapter: '메모킹만의 기능', win: 'list', target: [], needs: 'magic', advance: 'magic-tried', emoji: '🔮',
    title: '무엇이든 찾기, 매직키 (Ctrl+Alt+Space)',
    text: '어느 앱을 쓰다가도 Ctrl+Alt+Space! 메모와 파일을 몇 글자로 찾아요. 찾는 게 없으면 Enter, 적은 말이 바로 메모가 돼요.',
    try: 'Ctrl+Alt+Space를 누르고 "회의"를 쳐 보세요. 예시 메모가 보이면 Esc로 닫아요',
    offText: '설정에서 매직키를 켜면 Ctrl+Alt+Space로 어디서든 메모와 파일을 찾고, 떠오른 말을 바로 메모로 남겨요.',
    next: LATER,
  },
  {
    id: 'quick', chapter: '메모킹만의 기능', win: 'list', target: [], needs: 'quickMemo', advance: 'quick-memo', emoji: '⚡',
    title: '매직 카피 (Ctrl+Alt+C)',
    text: '웹 페이지나 문서에서 글을 고르고 Ctrl+Alt+C, 곧바로 메모가 돼요. 파일이나 그림을 고르고 눌러도 돼요.',
    try: '웹 브라우저나 메모장에서 글을 조금 끌어 고르고 Ctrl+Alt+C를 눌러 보세요',
    offText: '설정에서 매직 카피 키를 켜면, 다른 앱에서 글이나 파일을 고르고 Ctrl+Alt+C를 눌러 바로 메모로 담아요.',
    next: LATER,
  },
  {
    id: 'capture', chapter: '메모킹만의 기능', win: 'list', target: [], needs: 'quickMemo', advance: 'capture-done', emoji: '✂️',
    title: '매직 카피 두 번: 화면 잘라 메모',
    text: 'Ctrl+Alt+C를 빠르게 두 번! 화면이 멈추면 담고 싶은 곳을 끌어서 잘라요. 자른 그림이 바로 메모가 돼요.',
    try: 'Ctrl+Alt+C를 빠르게 두 번 누르고, 아무 곳이나 네모로 끌어 보세요',
    offText: '설정에서 매직 카피 키를 켜면 Ctrl+Alt+C를 빠르게 두 번 눌러 화면의 원하는 곳을 잘라 메모로 담아요.',
    next: LATER,
  },
  {
    id: 'list-crown', chapter: '메모킹만의 기능', win: 'list', target: ['#list-top-btn'], advance: 'list-crown-on', emoji: '👑',
    title: '창을 스티커처럼 늘 위에',
    text: '왕관을 누르면 다른 창에 가려지지 않아요. 메모 창도 똑같고, 테이프로 바탕화면에 붙여 둘 수도 있어요. 창 위에 왕관 스티커가 붙고, 창이 좁거나 화면 끝이면 작아져서 이 자리에 들어가요. 스티커나 작은 왕관을 누르면 떼어져요.',
    try: '오른쪽 위 왕관을 눌러 보세요',
    next: LATER,
  },
  {
    id: 'history', chapter: '메모킹만의 기능', win: 'list', target: ['[data-tab="history"]'], needs: 'history', emoji: '📥',
    title: '놓친 알림도 다시 보기 (알림 보관함)',
    text: '카카오톡처럼 금방 사라지는 Windows 알림을 모아 두고 다시 찾아봐요. 이 PC에만 저장하고, 앱마다 모으지 않게 고를 수 있어요.',
    offText: '카카오톡처럼 금방 사라지는 Windows 알림을 모아 두고 다시 찾아봐요. 다른 앱 알림을 읽는 기능이라 처음엔 꺼져 있어요. 켜도 이 PC에만 저장해요.',
    enable: '알림 모으기 켜기',
    next: '다음',
  },
  {
    id: 'mode', chapter: '메모킹만의 기능', win: 'list', target: ['#mode-switch:not([hidden])'], keep: ['#mode-switch'], needs: 'workLife', advance: 'mode-switched', emoji: '🌗',
    title: '일할 때는 Work, 쉴 때는 Life',
    text: '왼쪽 위 해와 달 스위치로 일할 때 쓰는 메모(Work)와 일상 메모(Life)를 나눠 봐요. 메모마다 Work · Life 태그가 붙고, 지금 모드는 작업 표시줄 아이콘의 작은 표시로 보여요. 새 메모도 지금 모드로 들어가요.',
    try: '스위치를 눌러 Work로 바꿔 보고, 다시 눌러 Life로 돌아와 보세요',
    enable: 'Work / Life 나누기 켜기',
    offText: '"Work / Life 나누기"를 켜면 왼쪽 위에 해와 달 스위치가 생겨요. 일할 때 메모(Work)와 일상 메모(Life)를 나눠 보고, 업무 시간에 저절로 Work로 바꿀 수도 있어요.',
    next: LATER,
  },
  {
    id: 'done', chapter: '마무리', win: 'list', target: [], emoji: '🎉',
    title: '준비 끝!',
    text: '연습 공간은 치우고 내 메모로 돌아갈게요. 창을 닫아도 메모킹은 작업 표시줄 오른쪽 아래(^)에서 기다려요. 이 안내는 설정의 사용법 둘러보기에서 다시 볼 수 있어요.',
    next: '메모 쓰러 가기 ✏️',
  },
];

// 휴대폰: 같은 말풍선, 휴대폰 화면에 맞춘 단계 (목록 화면 ↔ 메모 화면)
export const MOBILE_TUTORIAL_STEPS = [
  {
    id: 'welcome', chapter: '시작', win: 'list', target: [], emoji: '👑',
    title: '반가워요! 메모킹이에요',
    text: '직접 눌러 보며 배워요. 내 메모는 그대로 두고 예시 메모가 든 연습 공간에서 해요. 언제든 그만둘 수 있어요.',
    next: '시작할게요', skip: '나중에 볼게요',
  },
  {
    id: 'new-memo', chapter: '메모킹만의 메모', win: 'list', target: ['#fab-menu:not([hidden]) [data-new="text"]', '#fab'], keep: ['#fab-menu:not([hidden]) [data-new]', '#fab'], advance: 'memo-created', emoji: '✨',
    title: '첫 메모를 만들어 볼까요?',
    text: '노란 + 를 누르면 🎙️ 음성, 🎨 손, ✏️ 글 메모가 펼쳐져요.',
    try: '+ 를 누르고 "글 메모"를 골라 보세요',
  },
  {
    id: 'move', chapter: '메모킹만의 메모', win: 'note', target: ['.mode-knob .mk-dial', '.mode-knob'], keep: ['.ProseMirror > *', '.mode-knob'], sample: true, advance: 'mode-moved', emoji: '↕️', image: 'm-move.jpg',
    title: '다이얼로 옮기기',
    text: '오른쪽 아래 다이얼로 글 고치기, 옮기기, 글 위에 그리기를 골라요. 옮기기에서는 줄, 사진, 표를 짧게 눌러 끌면 돼요 (연습용 장보기 목록을 넣어 뒀어요). 글을 복사하거나 고칠 땐 글 고치기로.',
    try: '오른쪽 아래 다이얼을 한 번 눌러 옮기기로 돌려 보세요',
    next: LATER,
  },
  {
    id: 'annotate', chapter: '메모킹만의 메모', win: 'note', target: ['.mode-knob .mk-dial', '.mode-knob'], keep: ['.mode-knob', '.mode-knob.open .mk-stop', '.mk-annot-bar'], advance: 'annotate-done', emoji: '🖍️', // 펼친 다이얼 칸(그리기)도 가리지 않게
    title: '글 위에 바로 그리기',
    text: '다이얼을 글 위에 그리기로 돌리면 글자 위에 밑줄이나 동그라미를 쳐요. 글의 자리는 그대로예요. 다 그렸으면 다이얼을 한 번 더 눌러 글 고치기로 돌리면 저장돼요.',
    try: '다이얼을 누르면 둘레에 칸이 펼쳐져요. 맨 위 그리기를 눌러 글 위에 쓱 긋고, 다이얼을 다시 눌러 끝내요',
    next: LATER,
  },
  {
    id: 'voice', chapter: '메모킹만의 메모', win: 'note', target: ['#add-btn', '#format-bar'], emoji: '🎙️', image: 'm-voice.jpg',
    title: '말로 메모하기',
    text: '+ 버튼에서 "음성 녹음"을 누르고 말하면, 말한 내용이 글로 받아 적혀 녹음과 함께 들어가요. 화면을 꺼도 계속 녹음돼요.',
    next: '다음',
  },
  {
    id: 'back', chapter: '메모킹만의 메모', win: 'note', target: ['#back-btn'], advance: 'note-closed', emoji: '↩️',
    title: '목록으로 돌아가요',
    text: '적은 내용은 이미 저장되어 있어요. 휴대폰의 뒤로 가기를 눌러도 돼요.',
    try: '왼쪽 위 버튼을 눌러 보세요',
  },
  {
    id: 'mode', chapter: '목록', win: 'list', target: ['#mode-switch:not([hidden])'], keep: ['#mode-switch'], needs: 'workLife', advance: 'mode-switched', emoji: '🌗',
    title: '일할 때는 Work, 쉴 때는 Life',
    text: '검색 줄 옆 해와 달 스위치로 일할 때 쓰는 메모(Work)와 일상 메모(Life)를 나눠 봐요. 메모마다 Work · Life 태그가 붙어요.',
    try: '스위치를 눌러 Work로 바꿔 보고, 다시 눌러 Life로 돌아와 보세요',
    enable: 'Work / Life 나누기 켜기',
    offText: '"Work / Life 나누기"를 켜면 해와 달 스위치가 생겨요. 일할 때 메모(Work)와 일상 메모(Life)를 나눠 볼 수 있어요.',
    next: LATER,
  },
  {
    id: 'tabs', chapter: '목록', win: 'list', target: ['.tabs'], emoji: '🔔',
    title: '아래 탭으로 오가기',
    text: '메모, 일정, 알림 보관함 탭이 아래에 있어요. 일정에서는 캘린더와 회상(그날의 사진과 메모)을, 알림 보관함에서는 지나간 알림을 봐요.',
    next: '다음',
  },
  {
    id: 'share', chapter: '함께 쓰기', win: 'list', target: [], emoji: '📤',
    title: '다른 앱에서 바로 담기',
    text: '인터넷, 사진, 녹음 앱에서 "공유"에서 "메모킹"을 누르면 바로 메모가 돼요.',
    next: '다음',
  },
  {
    id: 'settings', chapter: '함께 쓰기', win: 'list', target: ['#settings-btn'], emoji: '☁️',
    title: 'PC와 함께 쓰기',
    text: '설정에서 Google Drive를 연결하면 PC 메모킹과 메모가 맞춰져요. 이 안내도 설정에서 다시 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'done', chapter: '마무리', win: 'list', target: [], emoji: '🎉',
    title: '준비 끝!',
    text: '연습 공간의 메모는 치우고 내 메모로 돌아갈게요. 바꿔 본 보기도 처음대로예요. 떠오를 때 바로, 메모킹과 함께 👑',
    next: '메모 쓰러 가기 ✏️',
  },
];

/** 글로 판정하는 직접 해 보기는 손을 멈춘 뒤에 넘어간다 (치는 도중·한글 조합 중에 넘어가지 않게) */
export const TUTORIAL_SETTLE_MS = { typed: 1800, tagged: 1500, styled: 900, tasked: 700 };

/** 사용자가 직접 해서 넘어가는 일들 (PC 메인 프로세스가 이 이름만 받는다) */
export const TUTORIAL_EVENTS = ['memo-created', 'typed', 'styled', 'tasked', 'add-opened', 'ink-done', 'annotate-done', 'tagged', 'crown-on', 'content-tools', 'note-closed', 'layout-changed', 'tag-filtered', 'mode-moved',
  'list-zoomed', 'mode-switched', 'list-crown-on', 'quick-memo', 'capture-done', 'magic-tried', 'note-zoomed'];

/**
 * 이 기기에서 보일 단계: 필요한 기능(needs)이 꺼져 있으면 직접 해 보기 없이 안내(offText)만 하고 "다음"으로
 * @param {object} step
 * @param {(need: string) => boolean} has 그 기능이 켜져 있는가
 */
export function tutorialStepFor(step, has) {
  if (!step?.needs || has(step.needs)) {
    if (!step?.enable) return step;
    const { enable, ...on } = step; // 켜져 있으면 켜기 단추는 없다
    return on;
  }
  const { advance, try: _try, offText, enable, ...rest } = step;
  return { ...rest, text: offText ?? step.text, next: '다음', ...(enable ? { enable: { need: step.needs, label: enable } } : {}) };
}

/** 지금 단계의 묶음: 이름 · 묶음 안에서 몇 번째(at) · 묶음의 단계 수(of) */
export function tutorialChapter(steps, index) {
  const name = steps[index]?.chapter;
  if (!name) return null;
  const same = steps.map((s, i) => [s, i]).filter(([s]) => s.chapter === name);
  return { name, at: same.findIndex(([, i]) => i === index) + 1, of: same.length };
}

/**
 * 다시 볼 때 어디부터 볼지: 목록 화면에서 시작하는 묶음만 (메모 화면 묶음은 메모를 만드는 "쓰기"부터)
 * @returns {{ name: string, index: number }[]}
 */
export function tutorialJumps(steps) {
  const out = [];
  for (const [i, s] of steps.entries()) {
    if (!s.chapter || s.chapter === '시작' || s.chapter === '마무리' || out.some((j) => j.name === s.chapter)) continue;
    if (steps[i - 1]?.chapter === s.chapter) continue; // 묶음의 첫 단계만
    if (s.win === 'list' && i > 1) out.push({ name: s.chapter, index: i }); // 바로 다음 묶음은 "시작할게요"와 같다
  }
  return out;
}

/**
 * 사용자가 한 일(event)로 몇 번째 단계가 되는지. 끝나면 -1.
 *   'next': 다음 단계 · 'skip': 끝 · 그 밖: 지금 단계의 advance 와 같을 때만 다음
 *   'note-closed': 메모 단계 중에 메모 창이 닫히면 목록 단계로 건너뛴다
 */
export function advanceTutorial(index, event, steps = TUTORIAL_STEPS) {
  const step = steps[index];
  if (!step || event === 'skip') return -1;
  let next = index;
  if (event === 'next') next = index + 1;
  else if (event === step.advance) next = index + 1;
  else if (event === 'note-closed' && step.win === 'note') {
    next = steps.findIndex((s, i) => i > index && s.win !== 'note');
  }
  return next >= steps.length || next < 0 ? -1 : next;
}

/**
 * 직접 해 보기 판정용 수 세기 (마크다운 본문) — 단계가 시작될 때와 비교해 늘었으면 해 낸 것
 *   blocks: 제목·인용 · tasks: 체크 칸 · tags: #태그
 */
export function tutorialCounts(md, tags = []) {
  const text = String(md ?? '');
  return {
    text: text.replace(/\s/g, '').length,
    blocks: (text.match(/^(#{1,6} |> )/gm) ?? []).length, // 첫 줄을 제목으로 바꿔도 셈 (단계 시작 때와 견주므로)
    tasks: (text.match(/^\s*[-*+] \[[ xX]\]/gm) ?? []).length,
    tags: tags.length,
  };
}

/** 지금 단계의 advance 가 본문으로 판정하는 것이면, 해 냈는지 (base: 단계 시작 때의 수) */
export function tutorialDone(advance, base, now) {
  if (!base) return false;
  switch (advance) {
    case 'typed': return now.text - base.text >= 2;
    case 'styled': return now.blocks > base.blocks;
    case 'tasked': return now.tasks > base.tasks;
    case 'tagged': return now.tags > base.tags;
    default: return false;
  }
}

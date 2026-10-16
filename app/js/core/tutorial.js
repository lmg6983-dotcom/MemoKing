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

const LATER = '다음에 해 볼게요';

/** 옮기기를 배우기 전에 메모 끝에 저절로 넣는 예시 목록 */
export const TUTORIAL_SAMPLE = '- [ ] 우유\n- [ ] 달걀\n- [ ] 사과\n- [ ] 식빵';

/** 예시 목록이 이미 들어 있는지 (단계가 다시 떠도 두 번 넣지 않게) */
export function hasTutorialSample(md) {
  const text = String(md ?? '');
  return TUTORIAL_SAMPLE.split('\n').every((line) => text.includes(line.replace('- [ ] ', '')));
}

export const TUTORIAL_STEPS = [
  // ---------- 시작 (목록 창) ----------
  {
    id: 'welcome', win: 'list', target: [], emoji: '👑',
    title: '반가워요! 메모킹이에요',
    text: '하나씩 직접 눌러 보면서 배워 볼게요. 3분이면 끝나요. 언제든 그만둘 수 있어요.',
    next: '시작할게요 🚀', skip: '나중에 볼게요',
  },
  {
    id: 'new-memo', win: 'list', target: ['#fab-menu:not([hidden]) [data-new="text"]', '#fab'], keep: ['#fab-menu:not([hidden]) [data-new]'], advance: 'memo-created', emoji: '✨',
    title: '첫 메모를 만들어 볼까요?',
    text: '오른쪽 아래 노란 + 를 누르면 🎙️ 음성, 🎨 손, ✏️ 글 메모가 펼쳐져요.',
    try: '+ 를 누르고 "글 메모"를 골라 보세요',
  },
  // ---------- 쓰기 (메모 창) ----------
  {
    id: 'write', win: 'note', target: ['.ProseMirror > :first-child', '#editor'], keep: ['.ProseMirror > *'], advance: 'typed', emoji: '📝',
    title: '떠오르는 생각을 적어 보세요',
    text: '첫 줄은 메모 제목이 되고, 적는 대로 저절로 저장돼요. 💾 저장 단추는 없어요!',
    try: '아무 말이나 한 줄 적어 보세요',
    next: '다음',
  },
  {
    id: 'style', win: 'note', target: ['.format-bar .style-btn', '#format-bar'], keep: ['.ProseMirror > *', '#style-menu:not([hidden])'], advance: 'styled', emoji: '🔠',
    title: '제목이나 인용으로 바꾸기',
    text: '"본문" 단추를 누르면 그 줄이 제목, 인용, 코드 모양으로 바뀌어요.',
    try: '"본문"을 누르고 "제목 2"를 골라 보세요',
    next: LATER,
  },
  {
    id: 'lists', win: 'note', target: ['[data-cmd="task"]', '#format-bar'], keep: ['.ProseMirror > *'], advance: 'tasked', emoji: '✅',
    image: 'clear.jpg',
    title: '할 일 목록 만들기',
    text: '체크리스트 단추를 누르면 줄 앞에 네모 칸이 생겨요. 모두 끝내면 CLEAR 도장이 쾅! 🎊',
    try: '체크리스트 단추를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'move', win: 'note', target: ['.ProseMirror > ul:last-of-type', '.ProseMirror > :first-child', '#editor'], keep: ['.ProseMirror > *'], sample: true, emoji: '↕️', image: 'move.jpg',
    title: '줄을 옮기고 싶을 때',
    text: '연습하라고 장보기 목록을 넣어 뒀어요. 줄을 꾹 누르면 살짝 들려요. 끌어서 원하는 자리에 놓으면 끝! 키보드로는 Alt+↑↓ 예요.',
    next: '다음',
  },
  // ---------- + 로 넣기 ----------
  {
    id: 'add', win: 'note', target: ['#add-btn', '#format-bar'], keep: ['#add-menu:not([hidden]) .add-sat'], advance: 'add-opened', emoji: '➕',
    image: 'add.jpg',
    title: '+ 로 더 많은 것 넣기',
    text: '도구막대 맨 왼쪽 + 에 녹음, 손 메모, 글 위에 그리기, 사진, 파일, 표, 수식이 모여 있어요.',
    try: '왼쪽 아래 + 를 눌러 펼쳐 보세요',
    next: LATER,
  },
  {
    id: 'ink', win: 'note', target: ['#add-menu:not([hidden]) [data-add="ink"]', '#add-btn'], keep: ['#add-menu:not([hidden]) .add-sat'], advance: 'ink-done', emoji: '🎨',
    image: 'ink.jpg',
    title: '손으로 그리기',
    text: '그린 만큼의 그림이 메모에 들어가요. 펜을 한 번 더 누르면 색과 굵기, 잘못 그리면 ↩️ 되돌리기.',
    try: '"손 메모"를 눌러 아무거나 그리고 ✓ 완료를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'content', win: 'note', target: ['.ProseMirror .mk-image-line', '.ProseMirror > :last-child', '#editor'], keep: ['.ProseMirror .mk-image-line', '.mk-delete-btn', '.mk-copy-btn', '.mk-save-btn'], advance: 'content-tools', emoji: '💾',
    title: '넣은 내용 저장 · 공유하기',
    text: '사진, 손 메모, 녹음, 파일에 마우스를 올리면 오른쪽 위에 단추가 떠요. 📋 복사, 💾 파일로 저장, 📤 공유(Windows 공유 · Drive 링크 · LocalSend · 메일), × 지우기.',
    try: '방금 그린 손 메모에 마우스를 올리고 📋 복사를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'annotate', win: 'note', target: ['#add-menu:not([hidden]) [data-add="annotate"]', '#add-btn'], keep: ['#add-menu:not([hidden]) .add-sat', '.ProseMirror > *'], advance: 'annotate-done', emoji: '🖍️',
    image: 'annotate.jpg',
    title: '글 위에 바로 그리기',
    text: '"글 위에 그리기"로 글자 위에 밑줄이나 동그라미를 쳐요. 글의 자리는 그대로예요.',
    try: '+ › "글 위에 그리기"를 눌러 글 위에 쓱 긋고 ✓ 완료',
    next: LATER,
  },
  {
    id: 'voice', win: 'note', target: ['#add-btn', '#format-bar'], keep: ['#add-menu:not([hidden]) .add-sat'], emoji: '🎙️', image: 'voice.jpg',
    title: '말로 메모하기',
    text: '"음성 녹음"을 누르고 말하면, 말한 내용이 글로 받아 적혀 녹음과 함께 들어가요. (Ctrl+Shift+R)',
    next: '다음',
  },
  {
    id: 'tag', win: 'note', target: ['.ProseMirror > :last-child', '#editor'], keep: ['.ProseMirror > *', '.tag-suggest', '.tag-suggest-bar:not([hidden])'], advance: 'tagged', emoji: '🏷️',
    title: '#으로 태그 달기',
    text: '같은 태그가 붙은 메모끼리 모아 볼 수 있어요. #을 치면 전에 쓴 태그도 골라 쓸 수 있어요.',
    try: '#할일 처럼 적어 보세요',
    next: LATER,
  },
  // ---------- 위 막대 ----------
  {
    id: 'crown', win: 'note', target: ['#top-btn'], keep: ['#tape-btn:not([hidden])'], advance: 'crown-on', emoji: '👑',
    title: '늘 위에, 또는 바탕화면에',
    text: '👑 왕관: 다른 창에 가려지지 않게 늘 위에. 🩹 테이프(옆 단추): 바탕화면에 붙여 다른 창 뒤에. 둘 중 하나만 붙고, 창 위의 스티커를 누르면 떼어져요.',
    noTape: '왕관을 누르면 이 메모가 다른 창에 가려지지 않아요. 창 위에 붙은 왕관 스티커를 누르거나 Ctrl+Shift+T 를 다시 누르면 떼어져요.',
    try: '지금은 왕관을 눌러 보세요',
    next: LATER,
  },
  {
    id: 'bell', win: 'note', target: ['#bell-btn', '.bar'], emoji: '⏰',
    title: '잊지 않게 알림 맞추기',
    text: '종 단추로 원하는 날짜와 시간에 이 메모를 알려 드려요. 매일, 매주 되풀이도 돼요.',
    next: '다음',
  },
  {
    id: 'links', win: 'note', target: ['#links-btn', '.bar'], emoji: '🔗',
    title: '메모끼리 이어 두기',
    text: '고리 단추로 관련된 메모를 이어 둘 수 있어요. 같은 태그를 쓴 메모도 여기서 함께 보여요.',
    next: '다음',
  },
  {
    id: 'bar', win: 'note', target: ['#new-btn', '.bar'], emoji: '🗂️', image: 'stack.jpg',
    title: '한 창에 여러 메모',
    text: '왼쪽 위 + 를 누르면 새 메모가 이 창의 탭으로 열려요. 탭은 창 왼쪽에 색인처럼 붙어요.',
    next: '다음',
  },
  {
    id: 'close', win: 'note', target: ['#close-btn'], advance: 'note-closed', emoji: '↩️',
    title: '다 적었으면 닫아 볼까요',
    text: '적은 내용은 이미 저장되어 있으니 걱정하지 않아도 돼요.',
    try: '오른쪽 위 × 를 눌러 닫아 보세요',
  },
  // ---------- 목록 ----------
  {
    id: 'cards', win: 'list', target: ['#cards .card', '#cards'], emoji: '🃏',
    title: '메모는 모두 여기에',
    text: '방금 쓴 메모가 카드로 보여요. 카드를 누르면 다시 열리고, 목록 밖으로 끌어다 놓으면 그 자리에 열려요.',
    next: '다음',
  },
  {
    id: 'layout', win: 'list', target: ['#layout-btn'], keep: ['#cards'], advance: 'layout-changed', emoji: '🔲',
    title: '보기 바꾸기',
    text: '카드를 바둑판처럼 볼지, 한 줄씩 볼지 고를 수 있어요.',
    try: '이 단추를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'filters', win: 'list', target: ['#tag-strip:not([hidden])', '#filter-btn'], keep: ['#tag-strip:not([hidden]) .tag-chip'], advance: 'tag-filtered', emoji: '🔎',
    title: '원하는 메모만 보기',
    text: '태그를 누르면 그 태그가 붙은 메모만 보여요. 깔때기 단추로 색이나 사진으로도 골라요.',
    try: '방금 만든 #태그를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'tabs', win: 'list', target: ['.tabs'], emoji: '🔔',
    title: '알림은 한곳에서',
    text: '"일정"에서는 달력으로 일정과 미리 알림을, "알림 보관함"에서는 지나간 Windows 알림을 다시 볼 수 있어요.',
    next: '다음',
  },
  // ---------- 어디서든 ----------
  {
    id: 'quick', win: 'list', target: [], emoji: '⚡',
    title: '어디서든 바로 메모 (Ctrl+Alt+C)',
    text: '웹 페이지나 문서에서 글을 고르고 Ctrl+Alt+C — 곧바로 메모가 돼요. 파일을 고르고 눌러도 돼요.',
    next: '다음',
  },
  {
    id: 'capture', win: 'list', target: [], emoji: '✂️',
    title: '화면을 잘라 메모하기',
    text: 'Ctrl+Alt+C를 빠르게 두 번! 화면에서 원하는 부분을 끌어서 잘라 담아요.',
    next: '다음',
  },
  {
    id: 'magic', win: 'list', target: [], emoji: '🔮',
    title: '무엇이든 찾기 (Ctrl+Alt+Space)',
    text: '메모와 파일을 몇 글자로 찾아요. 찾는 게 없으면 Enter — 적은 말이 바로 메모가 돼요.',
    next: '다음',
  },
  {
    id: 'settings', win: 'list', target: ['#settings-btn'], emoji: '⚙️',
    title: '내게 맞게 바꾸기',
    text: '휴지통, 음성 받아쓰기, 알림 보관은 설정에 있어요. 이 안내도 설정에서 언제든 다시 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'done', win: 'list', target: [], emoji: '🎉',
    title: '준비 끝!',
    text: '이제 마음껏 적어 보세요. 창을 닫아도 메모킹은 작업 표시줄 오른쪽 아래(^)에서 기다리고 있어요.',
    next: '메모 쓰러 가기 ✏️',
  },
];

// 휴대폰: 같은 말풍선, 휴대폰 화면에 맞춘 단계 (목록 화면 ↔ 메모 화면)
export const MOBILE_TUTORIAL_STEPS = [
  {
    id: 'welcome', win: 'list', target: [], emoji: '👑',
    title: '반가워요! 메모킹이에요',
    text: '직접 눌러 보며 배워요. 언제든 그만둘 수 있어요.',
    next: '시작할게요 🚀', skip: '나중에 볼게요',
  },
  {
    id: 'new-memo', win: 'list', target: ['#fab-menu:not([hidden]) [data-new="text"]', '#fab'], keep: ['#fab-menu:not([hidden]) [data-new]', '#fab'], advance: 'memo-created', emoji: '✨',
    title: '첫 메모를 만들어 볼까요?',
    text: '노란 + 를 누르면 🎙️ 음성, 🎨 손, ✏️ 글 메모가 펼쳐져요.',
    try: '+ 를 누르고 "글 메모"를 골라 보세요',
  },
  // 글 쓰는 단계: 쓰는 줄과 그 아래(write) · 도구막대는 비워 두고, 다 쓰고 손을 멈추면 넘어간다 (치는 도중엔 그대로)
  {
    id: 'write', win: 'note', target: ['.ProseMirror > :first-child', '#editor'], keep: ['.ProseMirror > *'], write: true, advance: 'typed', emoji: '📝',
    title: '떠오르는 생각을 적어 보세요',
    text: '첫 줄은 제목이 되고, 적는 대로 저절로 저장돼요.',
    try: '한 줄 적어 보세요 — 다 쓰고 손을 떼면 다음으로',
    next: '다음',
  },
  {
    id: 'lists', win: 'note', target: ['#format-bar [data-cmd="task"]', '#format-bar'], keep: ['.ProseMirror > *', '#format-bar'], write: true, advance: 'tasked', emoji: '✅',
    image: 'm-clear.jpg',
    title: '할 일 목록 만들기',
    text: '체크리스트 단추를 누르면 네모 칸이 생겨요. 줄바꿈이나 쓰던 줄 아래를 누르면 다음 칸이 이어지고, 모두 끝내면 CLEAR 도장! 🎊',
    try: '체크리스트 단추를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'move', win: 'note', target: ['.mode-knob .mk-dial', '.mode-knob'], keep: ['.ProseMirror > *', '.mode-knob'], sample: true, advance: 'mode-moved', emoji: '↕️', image: 'm-move.jpg',
    title: '다이얼로 옮기기',
    text: '오른쪽 아래 다이얼로 글 고치기, 옮기기, 글 위에 그리기를 골라요. 옮기기에서는 줄, 사진, 표를 짧게 눌러 끌면 돼요 (연습용 장보기 목록을 넣어 뒀어요). 글을 복사하거나 고칠 땐 글 고치기로.',
    try: '오른쪽 아래 다이얼을 한 번 눌러 옮기기로 돌려 보세요',
    next: LATER,
  },
  {
    id: 'add', win: 'note', target: ['#add-btn', '#format-bar'], keep: ['#add-menu:not([hidden]) .add-sat'], advance: 'add-opened', emoji: '➕',
    title: '+ 로 더 많은 것 넣기',
    text: '왼쪽 아래 둥근 + 에 녹음, 손 메모, 사진, 파일, 표, 수식이 모여 있어요. 펼치면 키보드는 잠깐 닫혀요.',
    try: '왼쪽 아래 + 를 눌러 펼쳐 보세요',
    next: LATER,
  },
  {
    id: 'ink', win: 'note', target: ['#add-menu:not([hidden]) [data-add="ink"]', '#add-btn'], keep: ['#add-menu:not([hidden]) .add-sat', '#add-btn'], advance: 'ink-done', emoji: '🎨',
    title: '손으로 그리기',
    text: '그린 만큼의 그림이 메모에 들어가요. 펜을 한 번 더 누르면 색과 굵기를 골라요.',
    try: '"손 메모"를 눌러 쓱 그리고 ✓ 완료',
    next: LATER,
  },
  {
    id: 'annotate', win: 'note', target: ['.mode-knob .mk-dial', '.mode-knob'], keep: ['.mode-knob', '.mk-annot-bar'], advance: 'annotate-done', emoji: '🖍️',
    title: '글 위에 바로 그리기',
    text: '다이얼을 글 위에 그리기로 돌리면 글자 위에 밑줄이나 동그라미를 쳐요. 글의 자리는 그대로예요. 다 그렸으면 다이얼을 한 번 더 눌러 글 고치기로 돌리면 저장돼요.',
    try: '다이얼을 누르면 둘레에 칸이 펼쳐져요 — 맨 위 그리기를 눌러 글 위에 쓱 긋고, 다이얼을 다시 눌러 끝내요',
    next: LATER,
  },
  {
    id: 'voice', win: 'note', target: ['#add-btn', '#format-bar'], emoji: '🎙️', image: 'm-voice.jpg',
    title: '말로 메모하기',
    text: '+ › "음성 녹음"을 누르고 말하면, 말한 내용이 글로 받아 적혀 녹음과 함께 들어가요. 화면을 꺼도 계속 녹음돼요.',
    next: '다음',
  },
  {
    id: 'tag', win: 'note', target: ['.ProseMirror > :last-child', '#editor'], keep: ['.ProseMirror > *', '.tag-suggest', '.tag-suggest-bar:not([hidden])'], write: true, advance: 'tagged', emoji: '🏷️',
    title: '#으로 태그 달기',
    text: '같은 태그가 붙은 메모끼리 모아 볼 수 있어요. 아래에 추천 태그도 떠요.',
    try: '#할일 처럼 적어 보세요',
    next: LATER,
  },
  {
    id: 'bell', win: 'note', target: ['#bell-btn'], keep: ['#links-btn'], emoji: '⏰',
    title: '알림과 이어 두기',
    text: '⏰ 종: 원하는 날짜와 시간에 이 메모를 알려 줘요 (매일, 매주도). 🔗 고리: 관련 메모를 이어 둬요.',
    next: '다음',
  },
  {
    id: 'back', win: 'note', target: ['#back-btn'], advance: 'note-closed', emoji: '↩️',
    title: '목록으로 돌아가요',
    text: '적은 내용은 이미 저장되어 있어요. 휴대폰의 뒤로 가기를 눌러도 돼요.',
    try: '왼쪽 위 단추를 눌러 보세요',
  },
  {
    id: 'cards', win: 'list', target: ['#cards .card', '#cards'], emoji: '🃏',
    title: '메모는 모두 여기에',
    text: '카드를 누르면 열리고, 꾹 누르면 메뉴(공유, 색, 지우기)가 떠요. 왼쪽으로 밀면 지우기예요.',
    next: '다음',
  },
  {
    id: 'layout', win: 'list', target: ['#layout-btn'], keep: ['#cards'], advance: 'layout-changed', emoji: '🔲',
    title: '보기 바꾸기',
    text: '카드를 두 줄로 볼지, 한 줄씩 볼지 골라요.',
    try: '이 단추를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'filters', win: 'list', target: ['#tag-strip:not([hidden])'], keep: ['#tag-strip:not([hidden]) .tag-chip'], advance: 'tag-filtered', emoji: '🔎',
    title: '원하는 메모만 보기',
    text: '태그를 누르면 그 태그가 붙은 메모만 보여요. 한 번 더 누르면 다시 모두 보여요.',
    try: '방금 만든 #태그를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'share', win: 'list', target: [], emoji: '📤',
    title: '다른 앱에서 바로 담기',
    text: '인터넷, 사진, 녹음 앱에서 "공유 › 메모킹"을 누르면 바로 메모가 돼요.',
    next: '다음',
  },
  {
    id: 'settings', win: 'list', target: ['#settings-btn'], emoji: '☁️',
    title: 'PC와 함께 쓰기',
    text: '설정에서 Google Drive를 연결하면 PC 메모킹과 메모가 맞춰져요. 이 안내도 설정에서 다시 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'done', win: 'list', target: [], emoji: '🎉',
    title: '준비 끝!',
    text: '이제 마음껏 적어 보세요. 떠오를 때 바로, 메모킹과 함께 👑',
    next: '메모 쓰러 가기 ✏️',
  },
];

/** 글로 판정하는 직접 해 보기는 손을 멈춘 뒤에 넘어간다 (치는 도중·한글 조합 중에 넘어가지 않게) */
export const TUTORIAL_SETTLE_MS = { typed: 1800, tagged: 1500, styled: 900, tasked: 700 };

/** 사용자가 직접 해서 넘어가는 일들 (PC 메인 프로세스가 이 이름만 받는다) */
export const TUTORIAL_EVENTS = ['memo-created', 'typed', 'styled', 'tasked', 'add-opened', 'ink-done', 'annotate-done', 'tagged', 'crown-on', 'content-tools', 'note-closed', 'layout-changed', 'tag-filtered', 'mode-moved'];

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

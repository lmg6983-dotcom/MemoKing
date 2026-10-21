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
//   needs: 이 기능이 켜져 있어야 직접 해 볼 수 있다 ('workLife' Work / Life 나누기 · 'quickMemo' Ctrl+Alt+C · 'magic' 매직키)
//          꺼져 있으면 offText 로 안내만 하고 "다음"으로 (tutorialStepFor)

const LATER = '다음에 해 볼게요';

/** 옮기기를 배우기 전에 메모 끝에 저절로 넣는 예시 목록 */
export const TUTORIAL_SAMPLE = '- [ ] 우유\n- [ ] 달걀\n- [ ] 사과\n- [ ] 식빵';

/**
 * 튜토리얼 연습 공간: 튜토리얼은 실제 메모 폴더 대신 잠깐 만든 빈 폴더에서 한다 (실제 메모 · 동기화 · 알림은 그대로)
 *   그 폴더에 미리 넣어 두는 예시 메모 — 목록 · 보기 · 태그 · Work/Life 를 해 볼 거리. 끝나면 폴더째 사라진다
 *   daysAgo: 며칠 전에 쓴 메모로 (목록이 실제처럼 보이게)
 */
export const TUTORIAL_SANDBOX_MEMOS = [
  { body: '# 연습 공간이에요\n\n여기서 만들고 고친 메모는 튜토리얼을 마치면 사라지고, 원래 메모로 돌아가요. 마음껏 눌러 보세요.', color: 'yellow', pinned: true, daysAgo: 0 },
  { body: '# 여행 준비\n\n- [x] 숙소 예약\n- [ ] 기차표\n- [ ] 우산 챙기기\n\n#여행', color: 'green', daysAgo: 1 },
  { body: '# 읽고 싶은 책\n\n데미안\n\n어린 왕자\n\n#책', color: 'purple', daysAgo: 3 },
  { body: '# 주간 회의\n\n- 지난주 정리\n- 이번 주 할 일 나누기\n\n#회의', color: 'blue', mode: 'work', daysAgo: 2 },
];

/** 연습 공간 예시 메모를 볼트에 넣는다 (PC · 휴대폰 볼트 모두 import 가 같다) */
export function seedTutorialSandbox(vault, toIso, now = new Date()) {
  for (const m of TUTORIAL_SANDBOX_MEMOS) {
    const at = toIso(new Date(now.getTime() - m.daysAgo * 86_400_000));
    vault.import({ body: m.body, color: m.color, mode: m.mode, pinned: m.pinned === true, created: at, updated: at });
  }
}

/** 예시 목록이 이미 들어 있는지 (단계가 다시 떠도 두 번 넣지 않게) */
export function hasTutorialSample(md) {
  const text = String(md ?? '');
  return TUTORIAL_SAMPLE.split('\n').every((line) => text.includes(line.replace('- [ ] ', '')));
}

export const TUTORIAL_STEPS = [
  // ---------- 시작 (목록 창) ----------
  {
    id: 'welcome', chapter: '시작', win: 'list', target: [], emoji: '👑',
    title: '반가워요! 메모킹이에요',
    text: '하나씩 직접 눌러 보면서 배워 볼게요. 내 메모는 그대로 두고 예시 메모가 든 연습 공간에서 해요. 쓰기, 넣기, 메모 창, 목록, 어디서든 다섯 묶음이고, 언제든 그만둘 수 있어요.',
    next: '시작할게요 🚀', skip: '나중에 볼게요',
  },
  {
    id: 'new-memo', chapter: '쓰기', win: 'list', target: ['#fab-menu:not([hidden]) [data-new="text"]', '#fab'], keep: ['#fab-menu:not([hidden]) [data-new]'], advance: 'memo-created', emoji: '✨',
    title: '첫 메모를 만들어 볼까요?',
    text: '오른쪽 아래 노란 + 를 누르면 🎙️ 음성, 🎨 손, ✏️ 글 메모가 펼쳐져요.',
    try: '+ 를 누르고 "글 메모"를 골라 보세요',
  },
  // ---------- 쓰기 (메모 창) ----------
  {
    id: 'write', chapter: '쓰기', win: 'note', target: ['.ProseMirror > :first-child', '#editor'], keep: ['.ProseMirror > *'], advance: 'typed', emoji: '📝',
    title: '떠오르는 생각을 적어 보세요',
    text: '첫 줄은 메모 제목이 되고, 적는 대로 저절로 저장돼요. 💾 저장 단추는 없어요!',
    try: '아무 말이나 한 줄 적어 보세요',
    next: '다음',
  },
  {
    id: 'style', chapter: '쓰기', win: 'note', target: ['.format-bar .style-btn', '#format-bar'], keep: ['.ProseMirror > *', '#style-menu:not([hidden])'], advance: 'styled', emoji: '🔠',
    title: '제목이나 인용으로 바꾸기',
    text: '"본문" 단추를 누르면 그 줄이 제목, 인용, 코드 모양으로 바뀌어요.',
    try: '"본문"을 누르고 "제목 2"를 골라 보세요',
    next: LATER,
  },
  {
    id: 'lists', chapter: '쓰기', win: 'note', target: ['[data-cmd="task"]', '#format-bar'], keep: ['.ProseMirror > *'], advance: 'tasked', emoji: '✅',
    image: 'clear.jpg',
    title: '할 일 목록 만들기',
    text: '체크리스트 단추를 누르면 줄 앞에 네모 칸이 생겨요. 모두 끝내면 CLEAR 도장이 쾅! 🎊',
    try: '체크리스트 단추를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'move', chapter: '쓰기', win: 'note', target: ['.ProseMirror > ul:last-of-type', '.ProseMirror > :first-child', '#editor'], keep: ['.ProseMirror > *'], sample: true, emoji: '↕️', image: 'move.jpg',
    title: '줄을 옮기고 싶을 때',
    text: '연습하라고 장보기 목록을 넣어 뒀어요. 줄을 꾹 누르면 살짝 들려요. 끌어서 원하는 자리에 놓으면 끝! 키보드로는 Alt+↑↓ 예요.',
    next: '다음',
  },
  // 매직 줌: 본문 전체를 비추거나 피하게 하면 자리가 없어 말풍선이 접힌다 — 첫 줄만 비추고 배율 표시만 피한다
  {
    id: 'note-zoom', chapter: '쓰기', win: 'note', target: ['.ProseMirror > :first-child', '#editor'], keep: ['.zoom-badge'], advance: 'note-zoomed', emoji: '🔍',
    title: '글을 크게, 작게 (매직 줌)',
    text: '메모 안에서 Ctrl 을 누른 채 휠을 굴리면 글과 그림이 함께 커지고 작아져요. Ctrl 과 + − 키도 돼요. 위에 뜨는 "원래대로"를 누르면 처음 크기로 돌아와요.',
    try: 'Ctrl 을 누른 채 휠을 위로 굴려 보세요',
    next: LATER,
  },
  // ---------- + 로 넣기 ----------
  {
    id: 'add', chapter: '넣기', win: 'note', target: ['#add-btn', '#format-bar'], keep: ['#add-menu:not([hidden]) .add-sat'], advance: 'add-opened', emoji: '➕',
    image: 'add.jpg',
    title: '+ 로 더 많은 것 넣기',
    text: '도구막대 맨 왼쪽 + 에 녹음, 손 메모, 글 위에 그리기, 사진, 파일, 표, 수식이 모여 있어요.',
    try: '왼쪽 아래 + 를 눌러 펼쳐 보세요',
    next: LATER,
  },
  {
    id: 'ink', chapter: '넣기', win: 'note', target: ['#add-menu:not([hidden]) [data-add="ink"]', '#add-btn'], keep: ['#add-menu:not([hidden]) .add-sat'], advance: 'ink-done', emoji: '🎨',
    image: 'ink.jpg',
    title: '손으로 그리기',
    text: '그린 만큼의 그림이 메모에 들어가요. 펜을 한 번 더 누르면 색과 굵기, 잘못 그리면 ↩️ 되돌리기.',
    try: '"손 메모"를 눌러 아무거나 그리고 ✓ 완료를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'content', chapter: '넣기', win: 'note', target: ['.ProseMirror .mk-image-line', '.ProseMirror > :last-child', '#editor'], keep: ['.ProseMirror .mk-image-line', '.mk-ctx'], advance: 'content-tools', emoji: '💾',
    title: '넣은 내용 저장, 공유하기',
    text: '사진, 손 메모, 녹음, 파일, 표를 오른쪽 클릭하면 메뉴 맨 위 한 줄에 아이콘이 떠요. ✂ 잘라내기, 📋 복사, 💾 파일로 저장, 📤 공유(Drive 링크, LocalSend, 메일), 🗑 지우기.',
    try: '방금 그린 손 메모를 오른쪽 클릭하고 📋 복사 아이콘을 눌러 보세요',
    next: LATER,
  },
  {
    id: 'annotate', chapter: '넣기', win: 'note', target: ['#add-menu:not([hidden]) [data-add="annotate"]', '#add-btn'], keep: ['#add-menu:not([hidden]) .add-sat', '.ProseMirror > *'], advance: 'annotate-done', emoji: '🖍️',
    image: 'annotate.jpg',
    title: '글 위에 바로 그리기',
    text: '"글 위에 그리기"로 글자 위에 밑줄이나 동그라미를 쳐요. 글의 자리는 그대로예요.',
    try: '+ 단추에서 "글 위에 그리기"를 눌러 글 위에 쓱 긋고 ✓ 완료',
    next: LATER,
  },
  {
    id: 'voice', chapter: '넣기', win: 'note', target: ['#add-btn', '#format-bar'], keep: ['#add-menu:not([hidden]) .add-sat'], emoji: '🎙️', image: 'voice.jpg',
    title: '말로 메모하기',
    text: '"음성 녹음"을 누르고 말하면, 말한 내용이 글로 받아 적혀 녹음과 함께 들어가요. (Ctrl+Shift+R)',
    next: '다음',
  },
  {
    id: 'tag', chapter: '넣기', win: 'note', target: ['.ProseMirror > :last-child', '#editor'], keep: ['.ProseMirror > *', '.tag-suggest', '.tag-suggest-bar:not([hidden])'], advance: 'tagged', emoji: '🏷️',
    title: '#으로 태그 달기',
    text: '같은 태그가 붙은 메모끼리 모아 볼 수 있어요. #을 치면 전에 쓴 태그도 골라 쓸 수 있어요.',
    try: '#할일 처럼 적어 보세요',
    next: LATER,
  },
  // ---------- 위 막대 ----------
  {
    id: 'crown', chapter: '메모 창', win: 'note', target: ['#top-btn'], keep: ['#tape-btn:not([hidden])'], advance: 'crown-on', emoji: '👑',
    title: '늘 위에, 또는 바탕화면에',
    text: '👑 왕관: 다른 창에 가려지지 않게 늘 위에. 🩹 테이프(옆 단추): 바탕화면에 붙여 다른 창 뒤에. 둘 중 하나만 붙고, 창 위의 스티커를 누르면 떼어져요.',
    noTape: '왕관을 누르면 이 메모가 다른 창에 가려지지 않아요. 창 위에 붙은 왕관 스티커를 누르거나 Ctrl+Shift+T 를 다시 누르면 떼어져요.',
    try: '지금은 왕관을 눌러 보세요',
    next: LATER,
  },
  {
    id: 'bell', chapter: '메모 창', win: 'note', target: ['#bell-btn', '.bar'], emoji: '⏰',
    title: '잊지 않게 알림 맞추기',
    text: '종 단추로 원하는 날짜와 시간에 이 메모를 알려 드려요. 매일, 매주 되풀이도 돼요.',
    next: '다음',
  },
  {
    id: 'hotkey', chapter: '메모 창', win: 'note', target: ['#hotkey-btn', '.bar'], emoji: '⚡',
    title: '어디서든 불러오는 키',
    text: '번개 단추로 Ctrl+Alt+숫자 키를 정해 두면 다른 앱을 쓰다가도 이 메모를 바로 불러와요. 정한 숫자가 번개 옆에 작게 보여요.',
    next: '다음',
  },
  {
    id: 'bar', chapter: '메모 창', win: 'note', target: ['#new-btn', '.bar'], emoji: '🗂️', image: 'stack.jpg',
    title: '한 창에 여러 메모',
    text: '왼쪽 위 + 를 누르면 새 메모가 이 창의 탭으로 열려요. 탭은 창 왼쪽에 색인처럼 붙어요.',
    next: '다음',
  },
  {
    id: 'close', chapter: '메모 창', win: 'note', target: ['#close-btn'], advance: 'note-closed', emoji: '↩️',
    title: '다 적었으면 닫아 볼까요',
    text: '적은 내용은 이미 저장되어 있으니 걱정하지 않아도 돼요.',
    try: '오른쪽 위 × 를 눌러 닫아 보세요',
  },
  // ---------- 목록 ----------
  {
    id: 'cards', chapter: '목록', win: 'list', target: ['#cards .card', '#cards'], emoji: '🃏',
    title: '메모는 모두 여기에',
    text: '방금 쓴 메모가 카드로 보여요. 카드를 누르면 다시 열리고, 목록 밖으로 끌어다 놓으면 그 자리에 열려요.',
    next: '다음',
  },
  // 카드 확대: 카드 전체를 피하게 하면(keep) 자리가 없어 말풍선이 처음부터 접힌다 — 확대 표시만 피한다
  {
    id: 'zoom', chapter: '목록', win: 'list', target: ['#cards .card', '#cards'], keep: ['.zoom-badge'], advance: 'list-zoomed', emoji: '🔍',
    title: '카드를 크게, 작게',
    text: 'Ctrl 을 누른 채 마우스 휠을 굴리면 메모 카드가 커지고 작아져요. Ctrl 과 + − 키도 돼요. 글씨가 작게 느껴질 때 써 보세요.',
    try: 'Ctrl 을 누른 채 휠을 위로 굴려 보세요',
    next: LATER,
  },
  {
    id: 'layout', chapter: '목록', win: 'list', target: ['#filter-panel:not([hidden]) #layout-group', '#filter-btn'], keep: ['#cards', '#filter-panel'], advance: 'layout-changed', emoji: '🔲',
    title: '보기 바꾸기',
    text: '"보기" 단추에서 카드를 바둑판처럼 볼지, 한 줄씩 볼지와 정렬(최신순, 많이 본 순 등)을 고를 수 있어요.',
    try: '"보기"를 누르고 "한 줄씩"을 골라 보세요',
    next: LATER,
  },
  {
    id: 'filters', chapter: '목록', win: 'list', target: ['#tag-strip:not([hidden])', '#filter-btn'], keep: ['#tag-strip:not([hidden]) .tag-chip'], advance: 'tag-filtered', emoji: '🔎',
    title: '원하는 메모만 보기',
    text: '태그를 누르면 그 태그가 붙은 메모만 보여요. "보기" 단추로 색이나 사진으로도 골라요.',
    try: '방금 만든 #태그를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'mode', chapter: '목록', win: 'list', target: ['#mode-switch:not([hidden])'], keep: ['#mode-switch'], needs: 'workLife', advance: 'mode-switched', emoji: '🌗',
    title: '일할 때는 Work, 쉴 때는 Life',
    text: '왼쪽 위 해와 달 스위치로 일할 때 쓰는 메모(Work)와 일상 메모(Life)를 나눠 봐요. Work 는 밤처럼 어두운 화면이고, 새 메모도 지금 모드로 들어가요.',
    try: '스위치를 눌러 Work 로 바꿔 보고, 다시 눌러 Life 로 돌아와 보세요',
    enable: 'Work / Life 나누기 켜기',
    offText: '"Work / Life 나누기"를 켜면 왼쪽 위에 해와 달 스위치가 생겨요. 일할 때 메모(Work)와 일상 메모(Life)를 나눠 보고, 업무 시간에 저절로 Work 로 바꿀 수도 있어요.',
    next: LATER,
  },
  {
    id: 'tabs', chapter: '목록', win: 'list', target: ['.tabs'], emoji: '🔔',
    title: '일정과 알림은 한곳에서',
    text: '"일정"에서는 캘린더로 일정과 미리 알림을, 회상으로 그날의 사진과 메모를 봐요. "알림 보관함"에는 지나간 Windows 알림이 모여요.',
    next: '다음',
  },
  {
    id: 'list-crown', chapter: '목록', win: 'list', target: ['#list-top-btn'], advance: 'list-crown-on', emoji: '👑',
    title: '목록도 늘 위에',
    text: '목록 창도 왕관을 누르면 다른 창에 가려지지 않아요. 창 위에 왕관 스티커가 붙고, 창이 좁거나 화면 끝이면 작아져서 이 자리에 들어가요. 스티커나 작은 왕관을 누르면 떼어져요.',
    try: '오른쪽 위 왕관을 눌러 보세요',
    next: LATER,
  },
  // ---------- 어디서든 ----------
  {
    id: 'quick', chapter: '어디서든', win: 'list', target: [], needs: 'quickMemo', advance: 'quick-memo', emoji: '⚡',
    title: '어디서든 바로 메모 (Ctrl+Alt+C)',
    text: '웹 페이지나 문서에서 글을 고르고 Ctrl+Alt+C, 곧바로 메모가 돼요. 파일이나 그림을 고르고 눌러도 돼요.',
    try: '웹 브라우저나 메모장에서 글을 조금 끌어 고르고 Ctrl+Alt+C 를 눌러 보세요',
    offText: '설정에서 빠른 메모 키를 켜면, 다른 앱에서 글이나 파일을 고르고 Ctrl+Alt+C 를 눌러 바로 메모로 담아요.',
    next: LATER,
  },
  {
    id: 'capture', chapter: '어디서든', win: 'list', target: [], needs: 'quickMemo', advance: 'capture-done', emoji: '✂️',
    title: '화면을 잘라 메모하기',
    text: 'Ctrl+Alt+C 를 빠르게 두 번! 화면이 멈추면 담고 싶은 곳을 끌어서 잘라요. 자른 그림이 바로 메모가 돼요.',
    try: 'Ctrl+Alt+C 를 빠르게 두 번 누르고, 아무 곳이나 네모로 끌어 보세요',
    offText: '설정에서 빠른 메모 키를 켜면 Ctrl+Alt+C 를 빠르게 두 번 눌러 화면의 원하는 곳을 잘라 메모로 담아요.',
    next: LATER,
  },
  {
    id: 'magic', chapter: '어디서든', win: 'list', target: [], needs: 'magic', advance: 'magic-tried', emoji: '🔮',
    title: '무엇이든 찾기, 매직키 (Ctrl+Alt+Space)',
    text: '어느 앱을 쓰다가도 Ctrl+Alt+Space! 메모와 파일을 몇 글자로 찾아요. 찾는 게 없으면 Enter, 적은 말이 바로 메모가 돼요.',
    try: 'Ctrl+Alt+Space 를 누르고 "튜토리얼"을 쳐 보세요. 방금 쓴 메모가 보이면 Esc 로 닫아요',
    offText: '설정에서 매직키를 켜면 Ctrl+Alt+Space 로 어디서든 메모와 파일을 찾고, 떠오른 말을 바로 메모로 남겨요.',
    next: LATER,
  },
  {
    id: 'settings', chapter: '어디서든', win: 'list', target: ['#settings-btn'], emoji: '⚙️',
    title: '내게 맞게 바꾸기',
    text: '휴지통, 음성 받아쓰기, 알림 보관, Work / Life 나누기, 단축키는 설정에 있어요. 이 안내도 설정에서 언제든 다시 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'done', chapter: '마무리', win: 'list', target: [], emoji: '🎉',
    title: '준비 끝!',
    text: '연습 공간의 메모는 치우고 내 메모로 돌아갈게요. 바꿔 본 보기, 카드 크기, 목록 늘 위에 두기도 처음대로예요. 창을 닫아도 메모킹은 작업 표시줄 오른쪽 아래(^)에서 기다리고 있어요.',
    next: '메모 쓰러 가기 ✏️',
  },
];

// 휴대폰: 같은 말풍선, 휴대폰 화면에 맞춘 단계 (목록 화면 ↔ 메모 화면)
export const MOBILE_TUTORIAL_STEPS = [
  {
    id: 'welcome', chapter: '시작', win: 'list', target: [], emoji: '👑',
    title: '반가워요! 메모킹이에요',
    text: '직접 눌러 보며 배워요. 내 메모는 그대로 두고 예시 메모가 든 연습 공간에서 해요. 언제든 그만둘 수 있어요.',
    next: '시작할게요 🚀', skip: '나중에 볼게요',
  },
  {
    id: 'new-memo', chapter: '쓰기', win: 'list', target: ['#fab-menu:not([hidden]) [data-new="text"]', '#fab'], keep: ['#fab-menu:not([hidden]) [data-new]', '#fab'], advance: 'memo-created', emoji: '✨',
    title: '첫 메모를 만들어 볼까요?',
    text: '노란 + 를 누르면 🎙️ 음성, 🎨 손, ✏️ 글 메모가 펼쳐져요.',
    try: '+ 를 누르고 "글 메모"를 골라 보세요',
  },
  // 글 쓰는 단계: 쓰는 줄과 그 아래(write) · 도구막대는 비워 두고, 다 쓰고 손을 멈추면 넘어간다 (치는 도중엔 그대로)
  {
    id: 'write', chapter: '쓰기', win: 'note', target: ['.ProseMirror > :first-child', '#editor'], keep: ['.ProseMirror > *'], write: true, advance: 'typed', emoji: '📝',
    title: '떠오르는 생각을 적어 보세요',
    text: '첫 줄은 제목이 되고, 적는 대로 저절로 저장돼요.',
    try: '한 줄 적어 보세요. 다 쓰고 손을 떼면 다음으로',
    next: '다음',
  },
  {
    id: 'lists', chapter: '쓰기', win: 'note', target: ['#format-bar [data-cmd="task"]', '#format-bar'], keep: ['.ProseMirror > *', '#format-bar'], write: true, advance: 'tasked', emoji: '✅',
    image: 'm-clear.jpg',
    title: '할 일 목록 만들기',
    text: '체크리스트 단추를 누르면 네모 칸이 생겨요. 줄바꿈이나 쓰던 줄 아래를 누르면 다음 칸이 이어지고, 모두 끝내면 CLEAR 도장! 🎊',
    try: '체크리스트 단추를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'move', chapter: '쓰기', win: 'note', target: ['.mode-knob .mk-dial', '.mode-knob'], keep: ['.ProseMirror > *', '.mode-knob'], sample: true, advance: 'mode-moved', emoji: '↕️', image: 'm-move.jpg',
    title: '다이얼로 옮기기',
    text: '오른쪽 아래 다이얼로 글 고치기, 옮기기, 글 위에 그리기를 골라요. 옮기기에서는 줄, 사진, 표를 짧게 눌러 끌면 돼요 (연습용 장보기 목록을 넣어 뒀어요). 글을 복사하거나 고칠 땐 글 고치기로.',
    try: '오른쪽 아래 다이얼을 한 번 눌러 옮기기로 돌려 보세요',
    next: LATER,
  },
  {
    id: 'note-zoom', chapter: '쓰기', win: 'note', target: ['.ProseMirror > :first-child', '#editor'], advance: 'note-zoomed', emoji: '🔍',
    title: '글을 크게, 작게 (매직 줌)',
    text: '두 손가락을 벌리면 글과 그림이 함께 커지고, 오므리면 글자가 작아져 한 화면에 더 많이 보여요. 100% 가까이 오므리면 처음 크기로 돌아와요.',
    try: '두 손가락을 벌려 글을 키워 보세요',
    next: LATER,
  },
  {
    id: 'add', chapter: '넣기', win: 'note', target: ['#add-btn', '#format-bar'], keep: ['#add-menu:not([hidden]) .add-sat'], advance: 'add-opened', emoji: '➕',
    title: '+ 로 더 많은 것 넣기',
    text: '왼쪽 아래 둥근 + 에 녹음, 손 메모, 사진, 파일, 표, 수식이 모여 있어요. 펼치면 키보드는 잠깐 닫혀요.',
    try: '왼쪽 아래 + 를 눌러 펼쳐 보세요',
    next: LATER,
  },
  {
    id: 'ink', chapter: '넣기', win: 'note', target: ['#add-menu:not([hidden]) [data-add="ink"]', '#add-btn'], keep: ['#add-menu:not([hidden]) .add-sat', '#add-btn'], advance: 'ink-done', emoji: '🎨',
    title: '손으로 그리기',
    text: '그린 만큼의 그림이 메모에 들어가요. 펜을 한 번 더 누르면 색과 굵기를 골라요.',
    try: '"손 메모"를 눌러 쓱 그리고 ✓ 완료',
    next: LATER,
  },
  {
    id: 'annotate', chapter: '넣기', win: 'note', target: ['.mode-knob .mk-dial', '.mode-knob'], keep: ['.mode-knob', '.mode-knob.open .mk-stop', '.mk-annot-bar'], advance: 'annotate-done', emoji: '🖍️', // 펼친 다이얼 칸(그리기)도 가리지 않게
    title: '글 위에 바로 그리기',
    text: '다이얼을 글 위에 그리기로 돌리면 글자 위에 밑줄이나 동그라미를 쳐요. 글의 자리는 그대로예요. 다 그렸으면 다이얼을 한 번 더 눌러 글 고치기로 돌리면 저장돼요.',
    try: '다이얼을 누르면 둘레에 칸이 펼쳐져요. 맨 위 그리기를 눌러 글 위에 쓱 긋고, 다이얼을 다시 눌러 끝내요',
    next: LATER,
  },
  {
    id: 'voice', chapter: '넣기', win: 'note', target: ['#add-btn', '#format-bar'], emoji: '🎙️', image: 'm-voice.jpg',
    title: '말로 메모하기',
    text: '+ 단추에서 "음성 녹음"을 누르고 말하면, 말한 내용이 글로 받아 적혀 녹음과 함께 들어가요. 화면을 꺼도 계속 녹음돼요.',
    next: '다음',
  },
  {
    id: 'tag', chapter: '넣기', win: 'note', target: ['.ProseMirror > :last-child', '#editor'], keep: ['.ProseMirror > *', '.tag-suggest', '.tag-suggest-bar:not([hidden])'], write: true, advance: 'tagged', emoji: '🏷️',
    title: '#으로 태그 달기',
    text: '같은 태그가 붙은 메모끼리 모아 볼 수 있어요. 아래에 추천 태그도 떠요.',
    try: '#할일 처럼 적어 보세요',
    next: LATER,
  },
  {
    id: 'bell', chapter: '메모 화면', win: 'note', target: ['#bell-btn'], keep: ['#links-btn'], emoji: '⏰',
    title: '알림과 이어 두기',
    text: '⏰ 종: 원하는 날짜와 시간에 이 메모를 알려 줘요 (매일, 매주도). 🔗 고리: 관련 메모를 이어 둬요.',
    next: '다음',
  },
  {
    id: 'back', chapter: '메모 화면', win: 'note', target: ['#back-btn'], advance: 'note-closed', emoji: '↩️',
    title: '목록으로 돌아가요',
    text: '적은 내용은 이미 저장되어 있어요. 휴대폰의 뒤로 가기를 눌러도 돼요.',
    try: '왼쪽 위 단추를 눌러 보세요',
  },
  {
    id: 'cards', chapter: '목록', win: 'list', target: ['#cards .card', '#cards'], emoji: '🃏',
    title: '메모는 모두 여기에',
    text: '카드를 누르면 열리고, 꾹 누르면 메뉴(공유, 색, 지우기)가 떠요. 왼쪽으로 밀면 지우기예요.',
    next: '다음',
  },
  {
    id: 'layout', chapter: '목록', win: 'list', target: ['#filter-panel:not([hidden]) #layout-group', '#filter-btn'], keep: ['#cards', '#filter-panel'], advance: 'layout-changed', emoji: '🔲',
    title: '보기 바꾸기',
    text: '"보기" 단추에서 카드를 두 줄로 볼지, 한 줄씩 볼지와 정렬(최신순, 많이 본 순 등)을 골라요.',
    try: '"보기"를 누르고 "한 줄씩"을 골라 보세요',
    next: LATER,
  },
  {
    id: 'filters', chapter: '목록', win: 'list', target: ['#tag-strip:not([hidden])'], keep: ['#tag-strip:not([hidden]) .tag-chip'], advance: 'tag-filtered', emoji: '🔎',
    title: '원하는 메모만 보기',
    text: '태그를 누르면 그 태그가 붙은 메모만 보여요. 한 번 더 누르면 다시 모두 보여요.',
    try: '방금 만든 #태그를 눌러 보세요',
    next: LATER,
  },
  {
    id: 'mode', chapter: '목록', win: 'list', target: ['#mode-switch:not([hidden])'], keep: ['#mode-switch'], needs: 'workLife', advance: 'mode-switched', emoji: '🌗',
    title: '일할 때는 Work, 쉴 때는 Life',
    text: '검색 줄 옆 해와 달 스위치로 일할 때 쓰는 메모(Work)와 일상 메모(Life)를 나눠 봐요. Work 는 밤처럼 어두운 화면이에요.',
    try: '스위치를 눌러 Work 로 바꿔 보고, 다시 눌러 Life 로 돌아와 보세요',
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

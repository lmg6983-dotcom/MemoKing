// 단축키 한눈에 보기(Ctrl+/)의 '어디서든' 무리 — 전역 단축키(바꾼 키는 withShortcuts 로 바꿔 보임).
//   메모 창 기능의 키는 core/keymap.js 하나에서 (바꿀 수 있는 키 · 기본 키 · 설명)
export const SHORTCUT_GROUPS = [
  {
    title: '어디서든',
    items: [
      ['매직 카피 (고른 글, 파일, 그림)', 'Ctrl+Alt+C'],
      ['화면 영역 캡처', 'Ctrl+Alt+C 두 번'],
      ['메모 목록 열기/닫기', 'Ctrl+Alt+`'],
      ['메모 불러오기 (메뉴의 불러오기 키 정하기)', 'Ctrl+Alt+1~9'],
    ],
  },
];

// 처음 실행 튜토리얼 — 실제 화면의 버튼을 비추고 말풍선으로 안내한다. (순수 데이터·규칙, 단위 테스트 대상)
//   win: 말풍선을 띄울 창 ('list' 목록 창 · 'note' 튜토리얼 중 만든 메모 창)
//   target: 비출 요소(앞에서부터 보이는 것 하나, 없으면 가운데 카드)
//   advance: 사용자가 이걸 하면 다음 단계로 ('memo-created' | 'typed' | 'tagged' | 'note-closed')
//   next: "다음" 버튼 글자 (없으면 직접 해 봐야 넘어감 — 건너뛰기는 언제나 있음)

export const TUTORIAL_STEPS = [
  // ---------- 시작 (목록 창) ----------
  {
    id: 'welcome', win: 'list', target: [],
    title: '반가워요! 메모킹이에요',
    text: '메모킹을 쓰는 방법을 하나씩 천천히 알려 드릴게요. 3분이면 충분해요.',
    next: '시작할게요', skip: '나중에 볼게요',
  },
  {
    id: 'new-memo', win: 'list', target: ['#fab-menu:not([hidden])', '#fab'], advance: 'memo-created',
    title: '첫 메모를 만들어 볼까요?',
    text: '오른쪽 아래 노란 + 단추를 눌러 보세요. 위로 단추 세 개가 펼쳐지면 "글 메모"를 골라 주세요.',
  },
  // ---------- 쓰기 (메모 창) ----------
  {
    id: 'write', win: 'note', target: ['#editor'], advance: 'typed',
    title: '떠오르는 생각을 적어 보세요',
    text: '아무 말이나 한 줄 적어 보세요. 첫 줄은 메모의 제목이 되고, 적는 대로 저절로 저장돼요.',
    next: '다음',
  },
  {
    id: 'format', win: 'note', target: ['#format-bar'],
    title: '글자를 꾸며 볼까요',
    text: '꾸미고 싶은 글자를 고른 다음, 아래 도구막대에서 굵게·글자 색·형광펜을 눌러 보세요.',
    next: '다음',
  },
  {
    id: 'style', win: 'note', target: ['.format-bar .style-btn', '#format-bar'],
    title: '제목이나 인용으로 바꾸기',
    text: '"본문"이라고 적힌 단추를 누르면 그 줄을 제목·인용·코드 모양으로 바꿀 수 있어요.',
    next: '다음',
  },
  {
    id: 'lists', win: 'note', target: ['[data-cmd="task"]', '#format-bar'],
    title: '할 일 목록 만들기',
    text: '체크리스트 단추를 누르면 줄 앞에 네모 칸이 생겨요. 다 한 일에 표시하면 작은 축하가 기다리고 있어요.',
    next: '다음',
  },
  {
    id: 'move', win: 'note', target: ['#editor'],
    title: '줄을 옮기고 싶을 때',
    text: '옮기고 싶은 줄을 꾹 누르면 살짝 들려요. 그대로 끌어서 원하는 자리에 놓으면 돼요.',
    next: '다음',
  },
  // ---------- + 로 넣기 ----------
  {
    id: 'add', win: 'note', target: ['#add-btn', '#format-bar'],
    title: '+ 로 더 많은 것 넣기',
    text: '도구막대 맨 왼쪽 + 를 누르면 녹음·손 메모·주석·사진·파일·표·수식을 넣을 수 있어요. 몇 가지만 소개할게요.',
    next: '다음',
  },
  {
    id: 'voice', win: 'note', target: ['#add-btn', '#format-bar'],
    title: '말로 메모하기',
    text: '"음성 녹음"을 누르고 말해 보세요. 말한 내용이 글로 받아 적혀서 녹음과 함께 메모에 들어가요. (Ctrl+Shift+R)',
    next: '다음',
  },
  {
    id: 'ink', win: 'note', target: ['#add-btn', '#format-bar'],
    title: '손으로 그리기',
    text: '"손 메모"를 누르면 그림판이 열려요. 펜이나 마우스로 그리고 "완료"를 누르면 그린 만큼의 그림이 메모에 들어가요. (Ctrl+Shift+D)',
    next: '다음',
  },
  {
    id: 'annotate', win: 'note', target: ['#add-btn', '#format-bar'],
    title: '글 위에 바로 그리기',
    text: '"주석"은 글자 위에 덧그리는 기능이에요. 밑줄이나 동그라미를 쳐도 글의 자리는 그대로예요. (Ctrl+Shift+E)',
    next: '다음',
  },
  {
    id: 'ink-tips', win: 'note', target: ['#add-btn', '#format-bar'],
    title: '그림 그릴 때 알아 두면 좋아요',
    text: '펜을 한 번 더 누르면 색과 굵기를 고를 수 있어요. 잘못 그렸다면 되돌리기를 누르면 되고, 다 그렸으면 "완료"만 누르면 저장까지 끝나요.',
    next: '다음',
  },
  {
    id: 'tag', win: 'note', target: ['#editor'], advance: 'tagged',
    title: '#으로 태그 달기',
    text: '#할일 처럼 # 뒤에 낱말을 적어 보세요. 같은 태그가 붙은 메모끼리 모아 볼 수 있어요.',
    next: '다음',
  },
  // ---------- 위 막대 ----------
  {
    id: 'crown', win: 'note', target: ['#top-btn'],
    title: '늘 위에 띄워 두기',
    text: '왕관을 누르면 이 메모가 다른 창에 가려지지 않고 늘 맨 위에 있어요. 창 위에 붙은 왕관 스티커를 누르면 원래대로 돌아와요.',
    next: '다음',
  },
  {
    id: 'bell', win: 'note', target: ['#bell-btn', '.bar'],
    title: '잊지 않게 알림 맞추기',
    text: '종 단추를 누르면 원하는 날짜와 시간에 이 메모를 알려 드려요.',
    next: '다음',
  },
  {
    id: 'links', win: 'note', target: ['#links-btn', '.bar'],
    title: '메모끼리 이어 두기',
    text: '고리 단추로 관련된 메모를 이어 둘 수 있어요. 같은 태그를 쓴 메모도 여기서 함께 보여요.',
    next: '다음',
  },
  {
    id: 'bar', win: 'note', target: ['#new-btn', '.bar'],
    title: '한 창에 여러 메모',
    text: '왼쪽 위 + 를 누르면 새 메모가 이 창의 탭으로 열려요. 여러 메모를 한 창에서 오가며 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'close', win: 'note', target: ['#close-btn'], advance: 'note-closed',
    title: '다 적었으면 닫아 볼까요',
    text: '오른쪽 위 × 를 눌러 창을 닫아 보세요. 적은 내용은 이미 저장되어 있으니 걱정하지 않아도 돼요.',
  },
  // ---------- 목록 ----------
  {
    id: 'cards', win: 'list', target: ['#cards'],
    title: '메모는 모두 여기에',
    text: '방금 쓴 메모가 카드로 보여요. 카드를 누르면 다시 열려요.',
    next: '다음',
  },
  {
    id: 'drag', win: 'list', target: ['#cards'],
    title: '카드를 끌어 꺼내기',
    text: '카드를 목록 밖으로 끌어다 놓으면 그 자리에 메모가 열려요. 다른 메모 창 위에 놓으면 탭으로 합쳐져요.',
    next: '다음',
  },
  {
    id: 'layout', win: 'list', target: ['#layout-btn'],
    title: '보기 바꾸기',
    text: '이 단추로 카드를 바둑판처럼 보거나 한 줄씩 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'filters', win: 'list', target: ['#tag-strip:not([hidden])', '#filter-btn'],
    title: '원하는 메모만 보기',
    text: '태그를 누르면 그 태그가 붙은 메모만 보여요. 깔때기 단추로 색이나 사진이 있는 메모만 골라 볼 수도 있어요.',
    next: '다음',
  },
  {
    id: 'tabs', win: 'list', target: ['.tabs'],
    title: '알림은 한곳에서',
    text: '"알림 예약"에서는 맞춰 둔 알림을, "알림 보관함"에서는 지나간 Windows 알림을 다시 볼 수 있어요.',
    next: '다음',
  },
  // ---------- 어디서든 ----------
  {
    id: 'quick', win: 'list', target: [],
    title: '어디서든 바로 메모 (Ctrl+Alt+C)',
    text: '웹 페이지나 문서에서 글을 고르고 Ctrl+Alt+C를 누르면 곧바로 메모가 돼요. 파일을 고르고 눌러도 돼요.',
    next: '다음',
  },
  {
    id: 'capture', win: 'list', target: [],
    title: '화면을 잘라 메모하기',
    text: 'Ctrl+Alt+C를 빠르게 두 번 누르면 화면에서 원하는 부분을 끌어서 잘라 담을 수 있어요.',
    next: '다음',
  },
  {
    id: 'magic', win: 'list', target: [],
    title: '무엇이든 찾기 (Ctrl+Alt+Space)',
    text: '어디서든 Ctrl+Alt+Space를 누르면 검색 창이 떠요. 메모와 파일을 몇 글자로 찾고, 찾는 게 없으면 Enter로 적은 말이 바로 메모가 돼요.',
    next: '다음',
  },
  {
    id: 'settings', win: 'list', target: ['#settings-btn'],
    title: '내게 맞게 바꾸기',
    text: '지운 메모 되살리기, 음성 받아쓰기, 알림 보관 같은 것은 설정에서 바꿀 수 있어요. 이 안내도 설정에서 언제든 다시 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'done', win: 'list', target: [],
    title: '준비 끝!',
    text: '이제 마음껏 적어 보세요. 창을 닫아도 메모킹은 작업 표시줄 오른쪽 아래(^) 안에서 기다리고 있어요.',
    next: '메모 쓰러 가기',
  },
];

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

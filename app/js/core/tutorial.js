// 처음 실행 튜토리얼 — 실제 화면의 버튼을 비추고 말풍선으로 안내한다. (순수 데이터·규칙, 단위 테스트 대상)
//   win: 말풍선을 띄울 창 ('list' 목록 창 · 'note' 튜토리얼 중 만든 메모 창)
//   target: 비출 요소(앞에서부터 보이는 것 하나, 없으면 가운데 카드)
//   advance: 사용자가 이걸 하면 다음 단계로 ('memo-created' | 'typed' | 'tagged' | 'note-closed')
//   next: "다음" 버튼 글자 (없으면 직접 해 봐야 넘어감 — 건너뛰기는 언제나 있음)

export const TUTORIAL_STEPS = [
  {
    id: 'welcome', win: 'list', target: [],
    title: '반가워요, 메모킹이에요',
    text: '1분이면 주요 기능을 모두 둘러볼 수 있어요. 직접 눌러 보면서 알아볼까요?',
    next: '시작하기', skip: '다음에 할게요',
  },
  {
    id: 'new-memo', win: 'list', target: ['#new-btn'], advance: 'memo-created',
    title: '첫 메모를 만들어 볼게요',
    text: '노란 + 버튼을 눌러 보세요. 단축키는 Ctrl+N이에요.',
  },
  {
    id: 'write', win: 'note', target: ['#editor'], advance: 'typed',
    title: '생각나는 걸 적어 보세요',
    text: '첫 줄이 메모 제목이 돼요. 적는 대로 메모 폴더에 저장돼요.',
    next: '다음',
  },
  {
    id: 'format', win: 'note', target: ['#format-bar'],
    title: '글자를 꾸밀 수 있어요',
    text: '글자를 고른 뒤 굵게·밑줄·색·형광펜을 눌러 보세요. 클립 버튼으로 사진·파일을, 표 버튼으로 표를 넣을 수 있어요.',
    next: '다음',
  },
  {
    id: 'tag', win: 'note', target: ['#editor'], advance: 'tagged',
    title: '#으로 태그를 붙여요',
    text: '#할일 처럼 적으면 태그가 돼요. #을 치면 전에 쓴 태그를 골라 쓸 수도 있어요.',
    next: '다음',
  },
  {
    id: 'crown', win: 'note', target: ['#top-btn'],
    title: '왕관 스티커로 늘 위에',
    text: '왕관을 누르면 창 위에 왕관 스티커가 붙고, 이 메모가 다른 창보다 늘 위에 있어요. 뗄 때는 스티커를 누르면 돼요.',
    next: '다음',
  },
  {
    id: 'bar', win: 'note', target: ['#bell-btn', '.bar'],
    title: '알림과 연결',
    text: '종은 알림 예약, 고리는 다른 메모와 연결이에요. 왼쪽 + 를 누르면 새 메모가 이 창의 탭으로 생겨요. 탭은 창 왼쪽에 색인처럼 달려요.',
    next: '다음',
  },
  {
    id: 'close', win: 'note', target: ['#close-btn'], advance: 'note-closed',
    title: '다 적었으면 닫아요',
    text: '× 를 눌러 닫아 보세요. 닫아도 적은 내용은 그대로 저장돼요.',
  },
  {
    id: 'cards', win: 'list', target: ['#cards'],
    title: '메모는 여기 모여요',
    text: '카드를 목록 밖으로 끌어 놓으면 그 자리에 메모가 열려요. 떠 있는 다른 메모 위에 놓으면 한 창의 탭으로 합쳐져요.',
    next: '다음',
  },
  {
    id: 'filters', win: 'list', target: ['#tag-strip:not([hidden])', '#filter-btn'],
    title: '골라서 보기',
    text: '태그를 누르면 그 태그의 메모만 보여요. 깔때기 버튼으로 색·사진·파일 등으로도 걸러 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'tabs', win: 'list', target: ['.tabs'],
    title: '알림도 한곳에서',
    text: '알림 예약 탭에서는 모든 메모의 알림을, 알림 보관함에서는 지나간 Windows 알림을 볼 수 있어요.',
    next: '다음',
  },
  {
    id: 'quick', win: 'list', target: [],
    title: '어디서든 Ctrl+Alt+C',
    text: '웹·문서·탐색기 어디서든 글이나 파일을 고르고 Ctrl+Alt+C를 누르면 바로 메모가 돼요. 빠르게 두 번 누르면 화면을 끌어서 캡처해요.',
    next: '다음',
  },
  {
    id: 'settings', win: 'list', target: ['#settings-btn'],
    title: '설정',
    text: '지운 메모 되살리기(휴지통), Windows 알림 모아두기, 사용법 다시 보기는 설정에 있어요. 목록 창도 왕관을 눌러 늘 위에 둘 수 있어요.',
    next: '다음',
  },
  {
    id: 'done', win: 'list', target: [],
    title: '이제 시작해 볼까요?',
    text: '창을 닫아도 메모킹은 작업 표시줄 오른쪽 아래(^)에 있어요. 사용법은 설정에서 언제든 다시 볼 수 있어요.',
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

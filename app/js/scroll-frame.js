// 스크롤 캡처 테두리 창 — 메인 프로세스가 진행(장 수)과 마지막 반짝·찰칵을 부른다.
//   ?pill=top|bottom  안내를 테두리 위·아래 어디에 둘지
import { shutter } from './shutter.js';

const q = new URLSearchParams(location.search);
document.body.classList.add(`pill-${q.get('pill') === 'bottom' ? 'bottom' : 'top'}`);
const pill = document.getElementById('pill');

window.mkScroll = {
  count(n) {
    pill.textContent = `스크롤하며 캡처하는 중 · ${n}장`;
  },
  stitching() {
    pill.textContent = '이어 붙이는 중';
  },
  flash() {
    pill.textContent = '찰칵! 메모를 만들어요';
    document.getElementById('ring').classList.add('flash');
    shutter();
  },
};
document.documentElement.dataset.ready = 'true';

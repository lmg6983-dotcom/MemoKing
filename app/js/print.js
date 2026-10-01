// 메모를 PDF 쪽으로 — 메인 프로세스의 PDF 만들기(printToPDF)와 PDF 만들기 창의 미리보기가 함께 쓴다.
//   ?id=메모&w=210&h=297&m=16&bg=1&date=1           (길이는 mm)
//   &preview=1  미리보기: 첫 쪽만 쪽 모양으로 보이고, 몇 쪽인지 부모 창에 알린다
import { createNoteEditor } from './editor.js';
import { injectIcons } from './icons.js';

const api = window.memoking;
const q = new URLSearchParams(location.search);
const id = q.get('id');
const W = Number(q.get('w')) || 210;
const H = Number(q.get('h')) || 297;
const M = Number(q.get('m')) || 0;
const preview = q.get('preview') === '1';
const root = document.getElementById('editor');

const style = document.createElement('style');
// 쪽 크기·여백은 CSS 의 @page 로 (PDF 만들기가 이것을 따른다)
// 쪽 여백은 @page 가 아니라 안쪽 여백으로 — 메모 색 바탕이 쪽 가장자리까지 칠해지게 (Chromium 은 @page 여백을 칠하지 않음)
style.textContent = `@page { size: ${W}mm ${H}mm; margin: 0; }
:root { --page-w: ${W}mm; --page-h: ${H}mm; --page-m: ${M}mm; }`;
document.head.append(style);
document.documentElement.classList.toggle('with-bg', q.get('bg') === '1');
document.documentElement.classList.toggle('preview', preview);

// PDF: 위아래 여백은 쪽마다 되풀이되는 표 머리·꼬리(빈 칸)로, 좌우 여백은 칸 안쪽 여백으로
if (!preview && M > 0) {
  const table = document.createElement('table');
  table.className = 'page-table';
  table.innerHTML = '<thead><tr><td class="page-gap"></td></tr></thead><tfoot><tr><td class="page-gap"></td></tr></tfoot><tbody><tr><td class="page-cell"></td></tr></tbody>';
  root.before(table);
  table.querySelector('.page-cell').append(root, document.getElementById('print-date'));
}

function pages() {
  const mm = 96 / 25.4;
  const content = (H - 2 * M) * mm;
  return Math.max(1, Math.ceil((root.scrollHeight - 1) / content));
}

async function settled(timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const imgs = [...document.images].filter((i) => !i.complete);
    const cards = document.querySelectorAll('.mk-link-card[data-state="loading"]');
    if (!imgs.length && !cards.length) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

injectIcons();
const memo = await api.pdf.memo(id);
if (memo) {
  document.body.dataset.color = memo.color;
  // 쪽 바탕(여백 포함): 메모 색 바탕이면 그 메모 색, 아니면 흰색. 메모 색 변수는 body 에 있어 여기서 읽어 html 에 준다
  const pageBg = q.get('bg') === '1' ? getComputedStyle(document.body).getPropertyValue('--note-bg').trim() : '#ffffff';
  document.documentElement.style.setProperty('--page-bg', pageBg || '#ffffff');
  document.title = memo.title;
  await createNoteEditor(root, {
    markdown: memo.body,
    tables: memo.tables ?? [], // 표 열 너비·행 높이·머리글 강조도 PDF 에 그대로
    readOnly: true,
    onChange: () => {},
    fetchPreview: (url) => api.links.preview(url),
    openLink: () => {},
    getTags: async () => [],
  });
  if (q.get('date') === '1') {
    const f = (v) => new Date(v).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    const foot = document.getElementById('print-date');
    foot.textContent = f(memo.created) === f(memo.updated) ? f(memo.created) : `${f(memo.created)} 만듦 · ${f(memo.updated)} 고침`;
    foot.hidden = false;
  }
  await document.fonts.ready;
  await settled();
}
document.documentElement.dataset.pages = String(pages());
document.documentElement.dataset.ready = 'true';
if (preview) window.parent.postMessage({ type: 'pdf-preview', pages: pages() }, '*');

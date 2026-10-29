// 메모를 PDF 쪽으로 — 메인 프로세스의 PDF 만들기(printToPDF)와 PDF 만들기 창의 미리보기가 함께 쓴다.
//   ?id=메모&w=210&h=297&m=16&bg=1&date=1&fit=1     (길이는 mm · fit: 쪽보다 큰 그림은 한 쪽 안에 들게 줄인다)
//   &preview=1  미리보기: 쪽마다 쪽 모양으로 이어 보이고(내용을 쪽 높이로 잘라서), 몇 쪽인지 부모 창에 알린다
import { createNoteEditor } from './editor.js';
import { injectIcons } from './icons.js';
import { clampPrintScale } from './core/pdf-page.js';

const api = window.memoking;
const q = new URLSearchParams(location.search);
const id = q.get('id');
const W = Number(q.get('w')) || 210;
const H = Number(q.get('h')) || 297;
const M = Number(q.get('m')) || 0;
const preview = q.get('preview') === '1';
// 글자 크기 (내용 전체를 확대 · 축소 — 휴대폰 PDF 와 같은 50~200%). 줄은 쪽 폭에 다시 맞춰진다
const Z = clampPrintScale(q.get('z'));
const PAGE_GAP = 28; // 미리보기 쪽 사이 (실제 크기 px — 줄여 보이면 10px 쯤)
const root = document.getElementById('editor');

const style = document.createElement('style');
// 쪽 크기·여백은 CSS 의 @page 로 (PDF 만들기가 이것을 따른다)
// 쪽 여백은 @page 가 아니라 안쪽 여백으로 — 메모 색 바탕이 쪽 가장자리까지 칠해지게 (Chromium 은 @page 여백을 칠하지 않음)
// --fit-h: 그림이 한 쪽에 들어갈 높이 (위아래 여백 · 줄 간격 몫 12mm 를 빼고, 글자 크기 배율로 나눔 — 본문 전체가 그만큼 커지므로)
style.textContent = `@page { size: ${W}mm ${H}mm; margin: 0; }
:root { --page-w: ${W}mm; --page-h: ${H}mm; --page-m: ${M}mm; --fit-h: ${Math.max(20, (H - 2 * M - 12) / Z).toFixed(1)}mm; }`;
document.head.append(style);
document.documentElement.classList.toggle('with-bg', q.get('bg') === '1');
document.documentElement.classList.toggle('preview', preview);
document.documentElement.classList.toggle('fit-images', q.get('fit') !== '0');

// PDF: 위아래 여백은 쪽마다 되풀이되는 표 머리·꼬리(빈 칸)로, 좌우 여백은 칸 안쪽 여백으로
if (!preview && M > 0) {
  const table = document.createElement('table');
  table.className = 'page-table';
  table.innerHTML = '<thead><tr><td class="page-gap"></td></tr></thead><tfoot><tr><td class="page-gap"></td></tr></tfoot><tbody><tr><td class="page-cell"></td></tr></tbody>';
  root.before(table);
  table.querySelector('.page-cell').append(root, document.getElementById('print-date'));
}

if (Z !== 1) root.style.zoom = String(Z);

function pages() {
  const mm = 96 / 25.4;
  const content = (H - 2 * M) * mm;
  // 확대한 만큼 높이가 늘어난다 (getBoundingClientRect 는 zoom 을 반영한 높이)
  return Math.max(1, Math.ceil((root.getBoundingClientRect().height - 1) / content));
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
    linkPreviews: await api.settings.get().then((s) => s?.linkPreviews !== false, () => true),
    onChange: () => {},
    fetchPreview: (url) => api.links.preview(url),
    openLink: () => {},
    getTags: async () => [],
  });
  if (q.get('date') === '1') {
    const f = (v) => new Date(v).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    const foot = document.getElementById('print-date');
    foot.textContent = f(memo.created) === f(memo.updated) ? f(memo.created) : `${f(memo.created)} 만듦, ${f(memo.updated)} 고침`;
    foot.hidden = false;
  }
  await document.fonts.ready;
  await settled();
}
const count = pages();
if (preview && count > 1) paginate(count);
document.documentElement.dataset.pages = String(count);
document.documentElement.dataset.ready = 'true';
if (preview) window.parent.postMessage({ type: 'pdf-preview', pages: count, gap: PAGE_GAP, query: location.search }, '*'); // query: 어느 미리보기의 결과인지

/**
 * 미리보기 쪽 나누기: 그린 본문을 쪽마다 복사해, 쪽의 글 칸 높이만큼씩 올려 보이게 한다
 *   (PDF 의 쪽 나눔과 같은 높이로 자른다 — 그림이 쪽 끝에 걸리면 실제 PDF 는 다음 쪽으로 넘길 수 있다)
 */
function paginate(n) {
  const mm = 96 / 25.4;
  const content = (H - 2 * M) * mm;
  const date = document.getElementById('print-date');
  const list = document.createElement('div');
  list.className = 'pv-pages';
  for (let i = 0; i < n; i++) {
    const page = document.createElement('section');
    page.className = 'pv-page';
    page.setAttribute('aria-label', `${i + 1}쪽`);
    const view = document.createElement('div');
    view.className = 'pv-view';
    const flow = document.createElement('div');
    flow.className = 'pv-flow';
    flow.style.transform = `translateY(${-i * content}px)`;
    flow.append(root.cloneNode(true));
    if (!date.hidden) flow.append(date.cloneNode(true));
    view.append(flow);
    page.append(view);
    list.append(page);
  }
  root.style.display = 'none';
  date.hidden = true;
  document.body.append(list);
  document.documentElement.classList.add('multi');
}

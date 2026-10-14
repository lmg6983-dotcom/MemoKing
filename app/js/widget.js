// 바탕화면 위젯 — 메모 한 장을 읽기 전용으로 바탕화면에 (window-manager.js openWidget)
//   메모가 바뀌면(이 PC · 휴대폰 · 다른 PC) 바로 다시 그린다. 글은 골라서 복사할 수 있고(Ctrl+C), 복사 단추는 본문 전체를.
import { createNoteEditor } from './editor.js';
import { injectIcons } from './icons.js';

const api = window.memoking;
const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);
const root = $('editor');
let editor = null;
let shown = null; // 지금 그린 { body, tables }

injectIcons();

let toastTimer = 0;
function toast(text) {
  const t = $('wg-toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1400);
}

async function render() {
  const memo = await api.widget.memo(id);
  if (!memo) return; // 지워졌으면 메인이 창을 닫는다
  document.body.dataset.color = memo.color;
  document.title = memo.title;
  $('wg-locked').hidden = !memo.locked;
  root.hidden = memo.locked;
  $('wg-copy').hidden = memo.locked;
  if (memo.locked) {
    $('wg-locked-title').textContent = memo.title;
    return;
  }
  const tables = memo.tables ?? [];
  if (shown && shown.body === memo.body && JSON.stringify(shown.tables) === JSON.stringify(tables)) return;
  shown = { body: memo.body, tables };
  if (editor) {
    const top = root.scrollTop;
    editor.setMarkdown(memo.body, tables);
    root.scrollTop = top; // 읽던 자리 그대로
    return;
  }
  editor = await createNoteEditor(root, {
    markdown: memo.body,
    tables,
    readOnly: true,
    linkPreviews: await api.settings.get().then((s) => s?.linkPreviews !== false, () => true),
    // 투명 바탕 손 메모를 어두운 화면에서 흰 펜으로 그리려면 획 자료(SVG)를 읽어야 한다 (메모 창과 같게)
    readAttachment: async (src) => {
      let rel = src;
      try {
        rel = decodeURI(src);
      } catch {
        // 이미 풀린 주소
      }
      return new TextDecoder().decode(await api.attachments.read(rel));
    },
    onChange: () => {},
    fetchPreview: (url) => api.links.preview(url),
    openLink: (url) => api.links.open(url),
    getTags: async () => [],
  });
}

// 그리기는 한 번에 하나씩 (처음 편집기를 만드는 동안 바뀜이 와도 편집기가 둘 생기지 않게)
let rendering = Promise.resolve();
const queueRender = () => (rendering = rendering.then(render).catch((err) => console.warn('위젯 다시 그리기', err)));
let renderTimer = 0;
api.on('settings:link-previews', (on) => editor?.setLinkPreviews(on));
api.on('widget:changed', () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(queueRender, 120); // 저장이 이어서 올 때 한 번만
});

$('wg-copy').addEventListener('click', async () => {
  const btn = $('wg-copy');
  const ok = await api.copyMemoText(id).catch(() => false);
  btn.classList.toggle('done', ok);
  toast(ok ? '본문을 복사했어요' : '복사하지 못했어요');
  setTimeout(() => btn.classList.remove('done'), 1400);
});
$('wg-open').addEventListener('click', () => api.widget.openNote(id));
$('wg-unlock').addEventListener('click', () => api.widget.openNote(id));
// 테이프(tape.html)를 눌러 뗄 때: 위젯도 살짝 작아지며 흐려진다 (곧 메인이 창을 닫는다)
api.on('widget:peeling', () => document.body.classList.add('wg-peeling'));
// 파일 칩 · 인터넷 링크는 메모 창에서처럼 한 번 누르면 열기
root.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || getSelection()?.toString()) return; // 글을 고르던 중이면 그대로
  const href = a.getAttribute('href');
  e.preventDefault();
  if (/^attachments\//.test(href)) api.attachments.open(href);
  else if (/^https?:/i.test(href)) api.links.open(href);
});

await queueRender();
document.documentElement.dataset.ready = 'true';

// 메모 안의 내용 복사 — 지우기(×) 옆 복사 단추 · 그림을 골라(눌러) Ctrl+C / Ctrl+X
//   그림: 화면에 그려진 그림을 PNG 로 바꿔 "그림" 으로 복사 (다른 앱 · 카톡 · 워드에 그대로 붙음).
//     실제로 클립보드에 넣는 일은 앱(PC: Electron clipboard, 휴대폰: 안드로이드 클립보드)이 — setCopyHost 로 받는다
//   그 밖의 내용(줄 · 목록 · 표 · 파일 칩 · 링크 카드): 서식(HTML)과 일반 글자를 함께
import { plainTextOf } from './clipboard-text.js';

let host = {
  /** @param {string} pngBase64 */
  image: null,
  /** @param {{ text: string, html: string }} c */
  text: null,
};

/** 앱마다 클립보드에 넣는 방법 — { image(pngBase64), text({ text, html }) } (빠지면 브라우저 Clipboard API) */
export function setCopyHost(h) {
  host = { ...host, ...h };
}

/** 그림 상자(사진 줄 · 손 메모) 안의 <img> */
export function imageIn(el) {
  if (!el) return null;
  if (el instanceof HTMLImageElement) return el;
  // 편집기가 커서 자리로 끼워 넣는 빈 <img class="ProseMirror-separator"> 는 빼고 — 그림 하나만 든 상자일 때만 (여럿이면 글로 복사)
  const imgs = [...(el.querySelectorAll?.('img') ?? [])].filter((i) => !i.classList.contains('ProseMirror-separator'));
  return imgs.length === 1 ? imgs[0] : null;
}

function toPng(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('그림을 아직 불러오지 못했어요');
  const canvas = document.createElement('canvas');
  // 너무 큰 그림은 줄여서 (클립보드 · 메모리 한도) — 긴 변 8000px
  const k = Math.min(1, 8000 / Math.max(w, h));
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
}

/** 화면의 그림 → PNG base64 (원래 크기로) */
export async function pngBase64(img) {
  if (!img.complete || !img.naturalWidth) await img.decode().catch(() => {});
  try {
    return toPng(img);
  } catch (err) {
    if (err?.name !== 'SecurityError') throw err;
    // 그림 주소가 화면과 다른 오리진(memoking://vault)이면 캔버스가 "오염" 돼 읽을 수 없다 — CORS 로 한 번 더 불러 그린다
    const fresh = new Image();
    fresh.crossOrigin = 'anonymous';
    fresh.src = img.currentSrc || img.src;
    await fresh.decode();
    return toPng(fresh);
  }
}

export async function copyImage(img) {
  const b64 = await pngBase64(img);
  if (host.image) return host.image(b64);
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export async function copyText({ text, html = '' }) {
  if (host.text) return host.text({ text, html });
  if (html && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    })]);
  } else await navigator.clipboard.writeText(text);
}

/** 그림 노드인가 (사진 · 손 메모) */
const isImageNode = (node) => node?.type.name === 'image';
/** 그림 하나만 든 줄 */
const loneImage = (node) => node?.type.name === 'paragraph' && node.childCount === 1 && isImageNode(node.firstChild);

/**
 * 편집기 안의 한 덩어리(줄 · 목록 · 그림 줄)를 복사 → '그림' | '내용'
 * @param {import('prosemirror-view').EditorView} view
 */
export async function copyBlock(view, pos, node, target) {
  if (isImageNode(node) || loneImage(node)) {
    const img = imageIn(target) ?? imageIn(view.nodeDOM(pos));
    if (img) {
      await copyImage(img);
      return '그림';
    }
  }
  const slice = view.state.doc.slice(pos, pos + node.nodeSize);
  const text = plainTextOf(slice.content).trim() || node.attrs?.href || node.attrs?.src || '';
  const dom = view.nodeDOM(pos);
  const html = dom instanceof Element ? dom.outerHTML : '';
  await copyText({ text, html });
  return '내용';
}

/**
 * 편집기 플러그인용: 그림을 골라(눌러) 둔 채 Ctrl+C / Ctrl+X 면 그림 자체를 복사 — 처리했으면 true
 *   (그림이 아닌 선택은 편집기의 보통 복사 그대로)
 */
export function handleImageCopy(view, event) {
  const sel = view.state.selection;
  const node = sel.node;
  if (!node || !(isImageNode(node) || loneImage(node))) return false;
  const img = imageIn(view.nodeDOM(sel.from));
  if (!img) return false;
  event.preventDefault();
  const cut = event.type === 'cut';
  const { from, to } = sel;
  copyImage(img).then(() => {
    if (cut && !view.isDestroyed && view.state.doc.nodeAt(from) === node) view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
  }).catch((err) => console.warn('그림 복사', err));
  return true;
}

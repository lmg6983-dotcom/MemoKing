// 메모를 그림(PNG) 한 장으로 (PC·휴대폰 함께) — 메모 화면에 그려진 본문을 메모 색 종이 위에 옮겨 담아 html-to-image(MIT)로 찍는다.
//   소리·동영상 플레이어는 "🎙 녹음 이름" 같은 글로, 링크 카드의 ✕ 같은 버튼은 빼고, 아래에 날짜·메모킹 표시.
import { UI } from './core/ui-text.js';
const WIDTH = 640; // 그림의 본문 폭 (CSS px) — 휴대폰·PC 어디서 열어도 읽기 좋게
const MAX_PIXELS = 7900; // 캔버스 한 변의 한계(약 8192)를 넘지 않게 배율을 줄인다

let fontCss = null;

/** 메모 → 그림 한 장 (base64 PNG). 너무 길면 PDF 로 저장하라는 오류 */
export async function renderMemoImage(editor, opts = {}) {
  return (await renderMemoImages(editor, { ...opts, split: false }))[0];
}

const SLICE = 3600; // 나눠 찍을 때 한 장의 본문 높이 (CSS px — 2배로 찍어 7200px, 캔버스 한계 안)
const MAX_SLICES = 20;

/**
 * 메모 → 그림들 (base64 PNG 배열). split: 너무 길면 문단 사이에서 끊어 여러 장으로 (메신저로 보내기 — 휴대폰 공유)
 *   한 장에 들어가면 늘 한 장
 */
export async function renderMemoImages(editor, { color = 'yellow', split = true } = {}) {
  if (!editor) throw new Error('메모가 열려 있지 않아요');
  const { toCanvas, getFontEmbedCSS } = await import('../vendor/html-to-image.js');
  const source = editor.dom();
  const paper = document.createElement('div');
  paper.className = 'share-paper';
  paper.dataset.color = color;
  // 화면 밖에 그려 둔다 (글꼴·크기 계산은 실제 화면과 같게)
  paper.style.cssText = `position: fixed; left: -10000px; top: 0; width: ${WIDTH}px;`;
  const doc = source.cloneNode(true);
  inlineShownImages(source, doc);
  doc.removeAttribute('contenteditable');
  doc.classList.remove('ProseMirror-focused');
  doc.style.setProperty('--note-zoom', '1');
  // 편집기의 min-height:100% · 스크롤이 그림 안에서는 종이 전체 높이가 되어 아래 날짜 줄을 밀어내므로 내용 높이만큼만
  Object.assign(doc.style, { minHeight: '0', height: 'auto', overflow: 'visible' });
  for (const n of doc.querySelectorAll('.ProseMirror-separator, .ProseMirror-trailingBreak, .mk-drag-badge, .ProseMirror-gapcursor')) n.remove();
  for (const n of doc.querySelectorAll('.mk-caret-item, .mk-lift, .mk-swap-target, .mk-date')) n.classList.remove('mk-caret-item', 'mk-lift', 'mk-swap-target', 'mk-date', 'mk-date-set');
  for (const media of doc.querySelectorAll('.mk-media')) {
    const label = media.querySelector('.mk-media-label')?.textContent || '';
    const chip = document.createElement('span');
    chip.className = 'share-media';
    chip.textContent = `${media.classList.contains('mk-video') ? '🎬 동영상' : '🎙 녹음'}${label ? ` · ${label}` : ''}`;
    media.replaceWith(chip);
  }
  const foot = document.createElement('div');
  foot.className = 'share-foot';
  const d = new Date();
  foot.textContent = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}  메모킹`;
  const inner = document.createElement('div'); // 나눠 찍을 때 이것을 위로 올려 그 장의 부분만 보이게
  inner.append(doc, foot);
  paper.append(inner);
  document.body.append(paper);
  try {
    // 그림이 다 불러와지기를 잠깐 기다린다
    await Promise.all([...paper.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => {
      img.onload = img.onerror = r;
      setTimeout(r, 4000);
    }))));
    await document.fonts?.ready;
    const height = paper.offsetHeight;
    // 길면 배율을 낮춰 캔버스 한계 안에 (1 아래로도) — 너무 길어 글자를 읽을 수 없을 만큼이면 안내
    const ratio = Math.min(2, MAX_PIXELS / Math.max(WIDTH, height));
    fontCss ??= await getFontEmbedCSS(paper).catch(() => '');
    const shoot = async (pixelRatio, clip = null) => {
      const canvas = await toCanvas(paper, {
        pixelRatio,
        backgroundColor: getComputedStyle(paper).backgroundColor,
        fontEmbedCSS: fontCss,
        cacheBust: false,
        skipAutoScale: true,
        ...(clip ? { height: clip } : {}),
        // 그림 하나를 못 그려도 메모 전체를 실패로 하지 않는다 (그 그림만 빈칸)
        onImageErrorHandler: () => {},
        style: { position: 'static', left: '0', top: '0', ...(clip ? { height: `${clip}px`, overflow: 'hidden' } : {}) },
      });
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      if (!base64) throw new Error(UI.imageMakeFail);
      return base64;
    };
    if (ratio >= 0.4) return [await shoot(ratio)];
    const tooLong = new Error('메모가 너무 길어 그림 한 장으로 만들 수 없어요. PDF로 저장해 주세요');
    if (!split) throw tooLong;
    // 문단(맨 위 덩어리) 사이에서 끊는다 — 한 덩어리가 한 장보다 길면 그 안에서
    const top0 = inner.getBoundingClientRect().top;
    const total = inner.offsetHeight;
    const bottoms = [...doc.children].map((c) => c.getBoundingClientRect().bottom - top0).filter((y) => y > 0).sort((a, b) => a - b);
    const cuts = [];
    let a = 0;
    let last = 0;
    for (const y of [...bottoms, total]) {
      while (y - a > SLICE) {
        const cut = last > a ? last : a + SLICE;
        cuts.push([a, cut]);
        a = cut;
      }
      last = y;
    }
    if (total > a) cuts.push([a, total]);
    if (cuts.length > MAX_SLICES) throw tooLong;
    const cs = getComputedStyle(paper);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const out = [];
    for (const [from, to] of cuts) {
      inner.style.marginTop = `${-from}px`;
      out.push(await shoot(2, Math.ceil(to - from + pad)));
    }
    return out;
  } catch (err) {
    // 그림 그리기 도구는 Error 가 아닌 것(불러오기 실패 Event 등)으로 거절하기도 한다 → 알아들을 수 있는 말로
    if (err instanceof Error) throw err;
    console.error('[그림으로 공유]', err);
    throw new Error(UI.imageMakeFail);
  } finally {
    paper.remove();
  }
}

// 메모에 이미 보이는 그림은 그 모습 그대로 data: 로 바꿔 둔다 — 그림 그리기 도구가 주소로 다시 받아 오다
//   실패하는 일이 없게 (휴대폰은 앱 안 주소라 다시 받기가 막히기도 한다). 못 바꾸면 원래 주소 그대로
function inlineShownImages(source, clone) {
  const shown = [...source.querySelectorAll('img')];
  const copies = [...clone.querySelectorAll('img')];
  shown.forEach((img, i) => {
    const copy = copies[i];
    if (!copy || !img.complete || !img.naturalWidth || img.src.startsWith('data:')) return;
    try {
      // 그림은 폭 640 × 2배로 찍히므로 큰 사진은 1600px 로 줄여 옮긴다 (휴대폰 메모리 · 시간)
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      copy.src = c.toDataURL(/\.jpe?g($|\?)/i.test(img.src) ? 'image/jpeg' : 'image/png', 0.92);
      copy.removeAttribute('srcset');
    } catch {
      // 다른 곳 그림(인터넷 사진)은 캔버스에 옮길 수 없다 → 도구가 주소로 받아 본다
    }
  });
}

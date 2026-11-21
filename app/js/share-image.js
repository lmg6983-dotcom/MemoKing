// 메모를 그림(PNG) 한 장으로 (PC·휴대폰 함께) — 메모 화면에 그려진 본문을 메모 색 종이 위에 옮겨 담아 html-to-image(MIT)로 찍는다.
//   소리·동영상 플레이어는 "🎙 녹음 이름" 같은 글로, 링크 카드의 ✕ 같은 버튼은 빼고, 아래에 날짜·메모킹 표시.
import { UI } from './core/ui-text.js';
import { fontFacesFor } from './core/font-subset.js';
const WIDTH = 640; // 그림의 본문 폭 (CSS px) — 휴대폰·PC 어디서 열어도 읽기 좋게
const MAX_PIXELS = 7900; // 캔버스 한 변의 한계(약 8192)를 넘지 않게 배율을 줄인다


// 브랜드 글꼴(Pretendard 나눠 읽기 판)은 base.css 가 @import 로 읽어 html-to-image 가 찾지 못한다 — 직접 고르고 그림에 넣는다
const FONT_DIR = new URL('../vendor/fonts/pretendard/', import.meta.url);
const dataUrl = async (url) => {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
};
async function brandFontCss(text) {
  const css = fontFacesFor(await (await fetch(new URL('pretendard.css', FONT_DIR))).text(), text);
  const files = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]))];
  const inlined = await Promise.all(files.map(async (f) => [f, await dataUrl(new URL(f.replace(/['"]/g, ''), FONT_DIR))]));
  return inlined.reduce((out, [f, d]) => out.replaceAll(`url(${f})`, `url(${d})`), css);
}
// 그 밖의 글꼴(수식 글꼴 등): 그림에 쓰인 글꼴의 @font-face 만 골라 파일을 넣는다
//   html-to-image 의 getFontEmbedCSS 는 @import 를 CSS 파일이 아니라 페이지 기준 주소로 다시 받아 404 가 났다 (base.css 의 Pretendard @import)
//   — 이미 읽힌 시트(@import 한 시트 포함)를 그대로 훑고, 파일 주소는 그 시트 기준으로
async function otherFontCss(node) {
  const used = new Set();
  for (const e of [node, ...node.querySelectorAll('*')]) for (const f of getComputedStyle(e).fontFamily.split(',')) used.add(f.trim().replace(/["']/g, ''));
  const faces = [];
  const walk = (sheet) => {
    let rules;
    try { rules = sheet.cssRules; } catch { return; } // 다른 곳에서 온 시트는 읽을 수 없다
    for (const r of rules) {
      if (r instanceof CSSImportRule && r.styleSheet) walk(r.styleSheet);
      else if (r instanceof CSSFontFaceRule) faces.push(r);
    }
  };
  for (const sheet of document.styleSheets) walk(sheet);
  const css = await Promise.all(faces.filter((r) => {
    const family = r.style.getPropertyValue('font-family').trim().replace(/["']/g, '');
    return used.has(family) && !/^Pretendard/.test(family); // 브랜드 글꼴은 brandFontCss 가
  }).map(async (r) => {
    let text = r.cssText;
    for (const [whole, , u] of text.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
      if (u.startsWith('data:')) continue;
      const data = await dataUrl(new URL(u, r.parentStyleSheet?.href ?? location.href)).catch(() => null);
      if (data) text = text.replaceAll(whole, `url(${data})`);
    }
    return text;
  }));
  return css.join('\n');
}

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
  const { toCanvas } = await import('../vendor/html-to-image.js');
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
    // 글꼴: 브랜드 글꼴은 이 메모에 나오는 글자를 가진 조각만 넣는다 (brandFontCss). 수식(KaTeX) 같은 그 밖의 글꼴은 html-to-image 가 찾는다.
    //   메모마다 글자가 달라 담아 두지 않는다 (창에 몇 MB 를 붙들고 있지 않게)
    const fontCss = (await brandFontCss(paper.textContent).catch(() => '')) + (await otherFontCss(paper).catch(() => ''));
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
    const tooLong = new Error('메모가 너무 길어 이미지 한 장으로 만들 수 없어요. PDF로 저장해 주세요');
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
    console.error('[이미지로 공유]', err);
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

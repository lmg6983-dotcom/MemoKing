// 메모를 그림(PNG) 한 장으로 (PC·휴대폰 함께) — 메모 화면에 그려진 본문을 메모 색 종이 위에 옮겨 담아 html-to-image(MIT)로 찍는다.
//   소리·동영상 플레이어는 "🎙 녹음 이름" 같은 글로, 링크 카드의 ✕ 같은 버튼은 빼고, 아래에 날짜·메모킹 표시.
import { UI } from './core/ui-text.js';
const WIDTH = 640; // 그림의 본문 폭 (CSS px) — 휴대폰·PC 어디서 열어도 읽기 좋게
const MAX_PIXELS = 7900; // 캔버스 한 변의 한계(약 8192)를 넘지 않게 배율을 줄인다

let fontCss = null;

export async function renderMemoImage(editor, { color = 'yellow' } = {}) {
  if (!editor) throw new Error('메모가 열려 있지 않아요');
  const { toCanvas, getFontEmbedCSS } = await import('../vendor/html-to-image.js');
  const source = editor.dom();
  const paper = document.createElement('div');
  paper.className = 'share-paper';
  paper.dataset.color = color;
  // 화면 밖에 그려 둔다 (글꼴·크기 계산은 실제 화면과 같게)
  paper.style.cssText = `position: fixed; left: -10000px; top: 0; width: ${WIDTH}px;`;
  const doc = source.cloneNode(true);
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
  paper.append(doc, foot);
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
    if (ratio < 0.4) throw new Error('메모가 너무 길어 그림 한 장으로 만들 수 없어요. PDF 로 저장해 주세요');
    fontCss ??= await getFontEmbedCSS(paper).catch(() => '');
    const canvas = await toCanvas(paper, {
      pixelRatio: ratio,
      backgroundColor: getComputedStyle(paper).backgroundColor,
      fontEmbedCSS: fontCss,
      cacheBust: false,
      skipAutoScale: true,
      style: { position: 'static', left: '0', top: '0' },
    });
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    if (!base64) throw new Error(UI.imageMakeFail);
    return base64;
  } finally {
    paper.remove();
  }
}

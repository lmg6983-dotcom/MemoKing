// 메모를 그림(PNG) 한 장으로 — 메모 화면에 그려진 본문을 메모 색 종이 위에 옮겨 담아 html-to-image(MIT)로 찍는다.
//   소리·동영상 플레이어는 "🎙 녹음 이름" 같은 글로, 링크 카드의 ✕ 같은 버튼은 빼고, 아래에 날짜·메모킹 표시.
const WIDTH = 640; // 그림의 본문 폭 (CSS px) — 휴대폰·PC 어디서 열어도 읽기 좋게
const MAX_PIXELS = 7900; // 캔버스 한 변의 한계(약 8192)를 넘지 않게 배율을 줄인다

let fontCss = null;

export async function renderMemoImage(editor, { color = 'yellow' } = {}) {
  if (!editor) throw new Error('메모가 열려 있지 않아요');
  const { toCanvas, getFontEmbedCSS } = await import('../../app/vendor/html-to-image.js');
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
  for (const n of doc.querySelectorAll('.lc-remove, .ProseMirror-separator, .ProseMirror-trailingBreak, .mk-drag-badge, .ProseMirror-gapcursor')) n.remove();
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
    const ratio = Math.max(1, Math.min(2, MAX_PIXELS / Math.max(WIDTH, height)));
    fontCss ??= await getFontEmbedCSS(paper).catch(() => '');
    const canvas = await toCanvas(paper, {
      pixelRatio: ratio,
      backgroundColor: getComputedStyle(paper).backgroundColor,
      fontEmbedCSS: fontCss,
      cacheBust: false,
      skipAutoScale: true,
      style: { position: 'static', left: '0', top: '0' },
    });
    return canvas.toDataURL('image/png').split(',')[1];
  } finally {
    paper.remove();
  }
}

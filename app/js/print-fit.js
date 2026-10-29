// PDF 쪽 나눔 다듬기 ("그림을 쪽 안에 맞추기"를 켰을 때) — PC print.js 와 휴대폰 인쇄(app.js)가 함께 쓴다.
//   그려진 높이를 재서 고치므로 편집기가 아닌 복사본(.mk-doc)에 쓴다. 고치는 차례:
//   D 표: 행이 두 쪽에 걸치지 않게, 머리글 줄은 쪽마다 다시 (thead — print.css)
//   C 글 없이 이어진 그림 2장 이상: 한 장을 쪽 높이 절반 안으로 (쪽마다 두 장씩)
//   B 쪽 폭에 맞추면 쪽 높이의 2.5배가 넘는 긴 그림(웹페이지 통 캡처 등): 줄이지 않고 쪽 높이로 잘라 여러 쪽에, 조각 아래 "다음 쪽에 이어져요"
//   A 그림이 쪽 끝에 걸치면: 남은 자리가 그림 높이의 60% 이상이면 그만큼 줄여 그 쪽에, 아니면 그대로(다음 쪽으로 넘어감)

const LONG = 2.5; // 쪽 높이의 몇 배부터 나눠 담나
const SQUEEZE = 0.6; // 남은 자리가 그림 높이의 이만큼은 돼야 줄여 넣는다 (그보다 작게는 줄이지 않음)
const LABEL_H = 22; // "다음 쪽에 이어져요" 줄 높이 (px)

const imagesOf = (el) => [...el.querySelectorAll('img.mk-image, .mk-ink img')].filter((i) => !i.classList.contains('mk-album-img'));
/** 그림만 든 줄인가 (글 없이) */
const isImageLine = (el) => el?.tagName === 'P' && imagesOf(el).length > 0 && !el.textContent.trim();

/**
 * @param {HTMLElement} doc 본문 복사본 (.mk-doc)
 * @param {{ pageH: number, zoom?: number }} o pageH: 한 쪽에 담기는 내용 높이 (화면 px, 확대 반영) · zoom: 본문 확대 배율
 */
export function fitPages(doc, { pageH, zoom = 1 }) {
  const css = (px) => `${Math.max(24, Math.floor(px / zoom))}px`; // 화면 px → 확대 전 CSS px
  // D 표: 첫 줄이 머리글 칸이면 thead 로 (쪽마다 다시 보인다)
  for (const table of doc.querySelectorAll('table')) {
    const first = table.querySelector('tr');
    if (!table.tHead && first && [...first.cells].every((c) => c.tagName === 'TH')) table.createTHead().append(first);
  }
  // C 이어진 그림 줄 (그 사이에 글 없음): 쪽에 두 장씩
  const lines = [...doc.children];
  for (let i = 0; i < lines.length; i++) {
    if (!isImageLine(lines[i]) || !(isImageLine(lines[i - 1]) || isImageLine(lines[i + 1]))) continue;
    for (const img of imagesOf(lines[i])) img.style.maxHeight = css(pageH / 2 - 16);
  }
  // B 아주 긴 그림: 쪽 높이로 잘라 여러 쪽에
  const width = doc.getBoundingClientRect().width / zoom; // 확대 전 CSS px
  for (const img of imagesOf(doc)) {
    if (!img.naturalWidth || img.closest('.mk-ink')) continue;
    const w = Math.min(img.naturalWidth, width);
    const full = (w * img.naturalHeight) / img.naturalWidth; // 확대 전 CSS px
    if (full * zoom < LONG * pageH) continue;
    const slice = pageH / zoom - LABEL_H - 2; // 조각 + 안내 줄이 한 쪽보다 조금 작게 (반올림으로 빈 쪽이 생기지 않게)
    const box = document.createElement('div');
    box.className = 'mk-print-slices';
    const n = Math.ceil(full / slice);
    for (let k = 0; k < n; k++) {
      const part = document.createElement('div');
      part.className = 'mk-print-slice';
      const view = document.createElement('div');
      view.className = 'mk-print-slice-view';
      view.style.height = `${Math.min(slice, full - k * slice)}px`;
      const copy = img.cloneNode();
      copy.removeAttribute('style');
      copy.style.cssText = `width: ${w}px; max-width: none; max-height: none; height: ${full}px; margin-top: ${-k * slice}px;`;
      view.append(copy);
      part.append(view);
      if (k < n - 1) part.append(Object.assign(document.createElement('div'), { className: 'mk-print-more', textContent: '다음 쪽에 이어져요' }));
      box.append(part);
    }
    img.replaceWith(box);
  }
  // A 쪽 끝에 걸친 그림: 남은 자리가 그림의 60% 이상이면 그만큼 줄이고, 아니면 남은 자리만큼 빈칸을 두어 다음 쪽 맨 위로.
  //   긴 그림 조각들도 쪽 맨 위에서 시작하게. 위에서부터 차례로 — 앞의 것이 바뀌면 뒤 자리도 바뀌므로 그때마다 잰다
  //   (빈칸으로 넘겨야 화면에서 잰 자리와 PDF 의 쪽 나눔이 같아진다 — 저절로 넘어가게 두면 뒤의 계산이 어긋난다)
  const top = doc.getBoundingClientRect().top;
  const gap = (before, px) => before.before(Object.assign(document.createElement('div'), { className: 'mk-print-gap', style: `height: ${px / zoom}px` }));
  const lineOf = (el) => [...doc.children].find((c) => c.contains(el)) ?? el;
  for (const el of doc.querySelectorAll('img.mk-image, .mk-ink img, .mk-print-slices')) {
    if (el.classList.contains('mk-album-img') || (el.tagName === 'IMG' && el.closest('.mk-print-slices'))) continue;
    const r = el.getBoundingClientRect();
    const at = (r.top - top) % pageH;
    const left = pageH - at;
    if (el.classList.contains('mk-print-slices')) {
      if (at > 2) gap(lineOf(el), left);
    } else if (r.height > left - 2) {
      if (left - 4 >= SQUEEZE * r.height) el.style.maxHeight = css(left - 4);
      else gap(lineOf(el), left);
    }
  }
}

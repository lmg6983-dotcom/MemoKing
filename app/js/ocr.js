// 숨은 OCR 창 — 알림 창 그림을 tesseract.js(한글)로 읽어 줄 단위 글·위치를 돌려준다.
// memoking://ocr 오리진에서 로드되어 워커·wasm·언어파일을 모두 같은 오리진에서 불러온다 (교차 오리진 문제 없음).
/* global Tesseract */
import { grayImage, refineHangul } from './ocr-verify.js';

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('kor', 1, {
      workerPath: 'vendor/tesseract/worker.min.js',
      corePath: 'vendor/tesseract/core',
      langPath: 'vendor/tesseract/lang',
      gzip: true,
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: '6', // 알림 창은 한 덩어리 글 상자 (SINGLE_BLOCK)
        preserve_interword_spaces: '1',
      });
      return worker;
    }).catch((err) => {
      workerPromise = null; // 다음에 다시 시도
      throw err;
    });
  }
  return workerPromise;
}

// 글자 인식 결과 → 줄마다 { text, x, y, w, h }. 좌표는 100% 배율 화면 px (unit 으로 나눈다).
// 단어 단위는 "단톡방" 을 "단 톡 방" 처럼 과하게 쪼개므로 줄 단위(줄 글·줄 박스)를 쓴다.
function linesOf(data, unit, refined = new Map()) {
  const u = unit || 1;
  const out = [];
  for (const block of data.blocks ?? []) {
    for (const par of block.paragraphs ?? []) {
      for (const ln of par.lines ?? []) {
        const conf = Math.round(ln.confidence ?? 0);
        const text = (refined.get(ln) ?? ln.text ?? '')
          .replace(/^[|!I1l·•~_—-]+(?=\s*[\p{L}\p{N}])/u, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text || (conf > 0 && conf < 30 && text.length <= 1)) continue;
        const b = ln.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
        out.push({
          text,
          x: Math.round(b.x0 / u),
          y: Math.round(b.y0 / u),
          w: Math.round((b.x1 - b.x0) / u),
          h: Math.round((b.y1 - b.y0) / u),
          conf,
        });
      }
    }
  }
  return out;
}

// 원래 크기 그림 → 흑백 (글자 다듬기용)
const loadImage = (url) => new Promise((resolve, reject) => {
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = () => reject(new Error('그림을 읽지 못했어요'));
  im.src = url;
});
async function loadGray(url) {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return { gray: grayImage(g.getImageData(0, 0, c.width, c.height)), width: img.width };
}

window.ocrBridge.onRequest(async ({ id, dataUrl, unit, rawUrl, scale }) => {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(dataUrl, {}, { blocks: true });
    // 원래 크기 그림이 있으면 헷갈리는 한글을 같은 글꼴로 그려 견줘 다듬는다 (글꼴이 꼭 맞을 때만, 안 되면 그대로)
    let refined;
    let refine = null;
    if (rawUrl) {
      try {
        const t = performance.now();
        const [raw, big] = await Promise.all([loadGray(rawUrl), loadImage(dataUrl)]);
        // 글자 인식 그림(키운 것) px → 원래 그림 px
        const r = refineHangul(raw.gray, data, { unit: big.width / raw.width, scale: scale || 1 });
        refined = r.lines;
        refine = { matched: r.matched, lines: r.lineCount, skipped: r.skipped, fixes: r.fixes.map((f) => f.join('>')), ms: Math.round(performance.now() - t) };
      } catch (err) {
        refine = { error: String((err && err.message) || err) };
      }
    }
    const boxes = linesOf(data, unit, refined);
    window.ocrBridge.sendResult({ id, boxes, lines: boxes.map((b) => b.text), refine });
  } catch (err) {
    window.ocrBridge.sendResult({ id, error: String((err && err.message) || err) });
  }
});
window.ocrBridge.ready();

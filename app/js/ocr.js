// 숨은 OCR 창 — 알림 창 그림을 tesseract.js(한글)로 읽어 줄 단위 글·위치를 돌려준다.
// memoking://ocr 오리진에서 로드되어 워커·wasm·언어파일을 모두 같은 오리진에서 불러온다 (교차 오리진 문제 없음).
/* global Tesseract */

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('kor', 1, {
      workerPath: 'vendor/tesseract/worker.min.js',
      corePath: 'vendor/tesseract/core',
      langPath: 'vendor/tesseract/lang',
      gzip: true,
    }).catch((err) => {
      workerPromise = null; // 다음에 다시 시도
      throw err;
    });
  }
  return workerPromise;
}

// 글자 인식 결과 → 줄마다 { text, x, y, w, h }. 좌표는 100% 배율 화면 px (unit 으로 나눈다).
// 단어 단위는 "단톡방" 을 "단 톡 방" 처럼 과하게 쪼개므로 줄 단위(줄 글·줄 박스)를 쓴다.
function linesOf(data, unit) {
  const u = unit || 1;
  const out = [];
  for (const block of data.blocks ?? []) {
    for (const par of block.paragraphs ?? []) {
      for (const ln of par.lines ?? []) {
        const text = (ln.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const b = ln.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
        out.push({
          text,
          x: Math.round(b.x0 / u),
          y: Math.round(b.y0 / u),
          w: Math.round((b.x1 - b.x0) / u),
          h: Math.round((b.y1 - b.y0) / u),
          conf: Math.round(ln.confidence ?? 0),
        });
      }
    }
  }
  return out;
}

window.ocrBridge.onRequest(async ({ id, dataUrl, unit }) => {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(dataUrl, {}, { blocks: true });
    const boxes = linesOf(data, unit);
    window.ocrBridge.sendResult({ id, boxes, lines: boxes.map((b) => b.text) });
  } catch (err) {
    window.ocrBridge.sendResult({ id, error: String((err && err.message) || err) });
  }
});
window.ocrBridge.ready();

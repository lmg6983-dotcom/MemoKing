// 숨은 OCR 창 전용 다리 — 메인에서 그림을 받아 글자 인식 결과를 돌려준다 (sandbox + contextIsolation 안전)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ocrBridge', {
  onRequest: (cb) => ipcRenderer.on('ocr:request', (_e, data) => cb(data)),
  sendResult: (data) => ipcRenderer.send('ocr:result', data),
  ready: () => ipcRenderer.send('ocr:ready'),
});

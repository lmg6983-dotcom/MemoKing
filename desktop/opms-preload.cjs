// OPMS 창 전용 다리 (sandbox + contextIsolation 안전) — 사건은 매직키·이 창에서 찾아본 것만 열 수 있다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opms', {
  search: (query) => ipcRenderer.invoke('opms:search', query),
  case: (idx) => ipcRenderer.invoke('opms:case', idx),
  mywork: (idx) => ipcRenderer.invoke('opms:mywork', idx),
  details: (idx) => ipcRenderer.invoke('opms:details', idx), // 신규성 의제 · 진행사항 · 메모
  copySchema: () => ipcRenderer.invoke('opms:schema-copy'), // 표를 못 찾았을 때 표 목록 복사
  bills: (idx) => ipcRenderer.invoke('opms:bills', idx),
  attachments: (idx) => ipcRenderer.invoke('opms:attachments', idx),
  download: (req) => ipcRenderer.invoke('opms:download', req), // { idx, uploads: [서버 파일 경로], all }
  openFile: (req) => ipcRenderer.invoke('opms:open-file', req), // { idx, upload } — 받아 두고 바로 열기
  openFolder: (dir) => ipcRenderer.invoke('opms:open-folder', dir), // 받은 사건 폴더, 없으면 전자포대 저장 폴더
  chooseDir: () => ipcRenderer.invoke('opms:choose-dir'),
  copy: (text) => ipcRenderer.invoke('opms:copy', text),
  toMemo: (idx) => ipcRenderer.invoke('opms:to-memo', idx), // 사건 정보 → 새 메모
  onShow: (cb) => ipcRenderer.on('opms:show', (_e, req) => cb(req)),
  onProgress: (cb) => ipcRenderer.on('opms:progress', (_e, p) => cb(p)),
});

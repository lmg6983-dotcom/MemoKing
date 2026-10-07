// OPMS 창 전용 다리 (sandbox + contextIsolation 안전) — 사건은 매직키·이 창에서 찾아본 것만 열 수 있다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opms', {
  search: (query) => ipcRenderer.invoke('opms:search', query),
  case: (idx) => ipcRenderer.invoke('opms:case', idx),
  mywork: (idx) => ipcRenderer.invoke('opms:mywork', idx),
  bills: (idx) => ipcRenderer.invoke('opms:bills', idx),
  attachments: (idx) => ipcRenderer.invoke('opms:attachments', idx),
  download: (req) => ipcRenderer.invoke('opms:download', req), // { idx, ns: [번호], all }
  openFolder: () => ipcRenderer.invoke('opms:open-folder'),
  chooseDir: () => ipcRenderer.invoke('opms:choose-dir'),
  copy: (text) => ipcRenderer.invoke('opms:copy', text),
  onShow: (cb) => ipcRenderer.on('opms:show', (_e, req) => cb(req)),
  onProgress: (cb) => ipcRenderer.on('opms:progress', (_e, p) => cb(p)),
});

// 전체 결과 창(모두 찾기) 전용 다리 (sandbox + contextIsolation 안전)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('finder', {
  search: (query) => ipcRenderer.invoke('finder:search', query),
  stat: (paths) => ipcRenderer.invoke('finder:stat', paths),
  act: (req) => ipcRenderer.invoke('finder:act', req), // { action, path } · { action, id }
  onQuery: (cb) => ipcRenderer.on('finder:query', (_e, q) => cb(q)),
});

// 매직키 창 전용 다리 (sandbox + contextIsolation 안전)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magic', {
  modules: () => ipcRenderer.invoke('magic:modules'),
  run: (payload) => ipcRenderer.invoke('magic:run', payload),
  search: (query) => ipcRenderer.invoke('magic:search', query),
  openMemo: (id) => ipcRenderer.invoke('magic:open-memo', id),
  openFile: (path, reveal = false) => ipcRenderer.invoke('magic:open-file', { path, reveal }),
  resize: (height) => ipcRenderer.send('magic:resize', height),
  close: () => ipcRenderer.send('magic:close'),
  onShow: (cb) => ipcRenderer.on('magic:show', () => cb()),
});

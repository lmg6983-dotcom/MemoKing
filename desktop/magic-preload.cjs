// 매직키 창 전용 다리 (sandbox + contextIsolation 안전)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magic', {
  modules: () => ipcRenderer.invoke('magic:modules'),
  toggleModule: (id) => ipcRenderer.invoke('magic:toggle-module', id),
  run: (payload) => ipcRenderer.invoke('magic:run', payload),
  search: (query) => ipcRenderer.invoke('magic:search', query),
  opmsSearch: (query) => ipcRenderer.invoke('magic:opms-search', query),
  act: (req) => ipcRenderer.invoke('magic:act', req), // { action, path } · { action, id }
  openAll: (query) => ipcRenderer.invoke('magic:open-all', query),
  resize: (height) => ipcRenderer.send('magic:resize', height),
  close: () => ipcRenderer.send('magic:close'),
  onShow: (cb) => ipcRenderer.on('magic:show', () => cb()),
});

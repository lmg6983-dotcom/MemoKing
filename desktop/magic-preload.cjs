// 매직키 창 전용 다리 (sandbox + contextIsolation 안전)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magic', {
  modules: () => ipcRenderer.invoke('magic:modules'),
  toggleModule: (id) => ipcRenderer.invoke('magic:toggle-module', id),
  run: (payload) => ipcRenderer.invoke('magic:run', payload),
  search: (query) => ipcRenderer.invoke('magic:search', query),
  opmsSearch: (query) => ipcRenderer.invoke('magic:opms-search', query),
  act: (req) => ipcRenderer.invoke('magic:act', req), // { action, path } · { action, id }
  prefs: () => ipcRenderer.invoke('magic:prefs'), // 웹 검색 · AI 기본 사이트
  tool: (req) => ipcRenderer.invoke('magic:tool', req), // { type: 'copy' | 'web' | 'ai' | 'site', text, site }
  openAll: (query) => ipcRenderer.invoke('magic:open-all', query),
  resize: (height) => ipcRenderer.send('magic:resize', height),
  close: () => ipcRenderer.send('magic:close'),
  onShow: (cb) => ipcRenderer.on('magic:show', () => cb()),
  onModules: (cb) => ipcRenderer.on('magic:modules-changed', (_e, list) => cb(list)), // 설정에서 기능을 끄고 켜면
});

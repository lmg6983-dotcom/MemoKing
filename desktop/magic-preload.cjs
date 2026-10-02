// 매직키 창 전용 다리 (sandbox + contextIsolation 안전)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('magic', {
  modules: () => ipcRenderer.invoke('magic:modules'),
  run: (payload) => ipcRenderer.invoke('magic:run', payload),
  close: () => ipcRenderer.send('magic:close'),
  onShow: (cb) => ipcRenderer.on('magic:show', () => cb()),
});

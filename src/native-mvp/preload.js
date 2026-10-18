const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativeMvp', {
  sources: () => ipcRenderer.invoke('native-mvp-sources'),
  start: value => ipcRenderer.invoke('native-mvp-start',value),
  stop: () => ipcRenderer.invoke('native-mvp-stop'),
  openViewer: () => ipcRenderer.invoke('native-mvp-viewer'),
  join: value => ipcRenderer.invoke('native-mvp-join',value),
  network: () => ipcRenderer.invoke('native-mvp-network'),
  saveNetwork: value => ipcRenderer.invoke('native-mvp-network-save',value),
  copyLink: value => ipcRenderer.invoke('native-mvp-copy',value),
  openLogs: () => ipcRenderer.invoke('native-mvp-logs'),
  onEvent: callback => { const listener = (_event,value) => callback(value); ipcRenderer.on('native-mvp-event',listener); return () => ipcRenderer.removeListener('native-mvp-event',listener); }
});

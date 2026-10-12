const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('selfLiveBridge', {
  saveUserName: name => ipcRenderer.invoke('user-name-save', name),
  sharePreferences: () => ipcRenderer.invoke('share-preferences'),
  saveSharePreferences: value => ipcRenderer.invoke('share-preferences-save', value),
  pilotSettings: () => ipcRenderer.invoke('pilot-settings'),
  pilotPassword: () => ipcRenderer.invoke('pilot-password'),
  copyText: text => ipcRenderer.invoke('clipboard-write', text),
  mediaAuditStart: value => ipcRenderer.invoke('media-audit-start', value),
  mediaAuditSample: value => ipcRenderer.send('media-audit-sample', value),
  mediaAuditStop: () => ipcRenderer.send('media-audit-stop'),
  diagnosticSettings: () => ipcRenderer.invoke('diagnostic-settings'),
  saveDiagnosticSettings: value => ipcRenderer.invoke('diagnostic-settings-save', value),
  diagnosticSample: value => ipcRenderer.invoke('diagnostic-sample', value),
  diagnosticEvent: value => ipcRenderer.invoke('diagnostic-event', value),
  exportDiagnostic: () => ipcRenderer.invoke('diagnostic-export'),
  openLogsFolder: () => ipcRenderer.invoke('diagnostic-folder'),
  pilotSave: value => ipcRenderer.invoke('pilot-save', value),
  pilotRestart: () => ipcRenderer.invoke('pilot-restart'),
  relayOpen: (endpoint, hello) => ipcRenderer.invoke('relay-open', endpoint, hello),
  relaySend: raw => ipcRenderer.invoke('relay-send', raw),
  relayClose: () => ipcRenderer.invoke('relay-close'),
  relayStatus: () => ipcRenderer.invoke('relay-status'),
  onRelay: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('relay-event', listener);
    return () => ipcRenderer.removeListener('relay-event', listener);
  },
  config: () => ipcRenderer.invoke('config'),
  networkStatus: () => ipcRenderer.invoke('network-status'),
  connectivity: () => ipcRenderer.invoke('connectivity'),
  generateAccessLink: nodeId => ipcRenderer.invoke('generate-access-link', nodeId),
  useAccessLink: link => ipcRenderer.invoke('use-access-link', link),
  onConnectivity: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('connectivity-update', listener);
    return () => ipcRenderer.removeListener('connectivity-update', listener);
  },
  generateTurnCredentials: nodeId => ipcRenderer.invoke('generate-turn-credentials', nodeId),
  sources: () => ipcRenderer.invoke('sources'),
  selectSource: (id, audioId) => ipcRenderer.invoke('select-source', id, audioId),
  applicationAudioStart: () => ipcRenderer.invoke('application-audio-start'),
  applicationAudioSources: () => ipcRenderer.invoke('application-audio-sources'),
  onApplicationAudioState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('application-audio-state', listener);
    return () => ipcRenderer.removeListener('application-audio-state', listener);
  },
  applicationAudioStop: () => ipcRenderer.invoke('application-audio-stop'),
  onApplicationAudio: callback => {
    const listener = (_event, bytes) => callback(bytes);
    ipcRenderer.on('application-audio-data', listener);
    return () => ipcRenderer.removeListener('application-audio-data', listener);
  },
  onApplicationAudioEnded: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('application-audio-ended', listener);
    return () => ipcRenderer.removeListener('application-audio-ended', listener);
  },
  hash: (password, room) => ipcRenderer.invoke('hash', password, room),
  streaming: active => ipcRenderer.send('streaming', Boolean(active)),
  onAction: callback => ipcRenderer.on('tray-action', (_event, action) => callback(action)),
  shutdownLog: (stage, errorName) => ipcRenderer.send('shutdown-log', stage, errorName),
  onShutdown: callback => ipcRenderer.on('shutdown-request', async (_event, token) => {
    try { await callback(); }
    catch (error) {
      try { ipcRenderer.send('shutdown-log', 'Fechando conexões WebRTC', error.name || 'Error'); } catch { /* Main já encerrado. */ }
    }
    finally {
      try { ipcRenderer.send('shutdown-complete', token); } catch { /* Saída forçada já terminou. */ }
    }
  })
});

// Objetos atravessando contextBridge são cópias congeladas. Este getter no mundo
// da página oferece um snapshot atualizado sem expor ipcRenderer ou Node.js.
contextBridge.executeInMainWorld({ func: () => {
  const bridge = window.selfLiveBridge;
  let mapping = Object.freeze({ tcp: null, udp: null, method: null, status: 'checking' });
  let hostRelay = Object.freeze({ status: 'disabled', url: null, reconnects: 0 });
  let viewerRelay = null;
  let signaling = 'failed';
  bridge.onRelay(event => {
    if (event.kind === 'host-status') hostRelay = Object.freeze(event.value);
    if (event.kind === 'status') viewerRelay = Object.freeze(event.value);
    if (event.kind === 'close') viewerRelay = null;
  });
  bridge.relayStatus().then(value => { hostRelay = Object.freeze(value); }).catch(() => {});
  const update = snapshot => { mapping = snapshot.portMapping; };
  bridge.onConnectivity(update);
  bridge.connectivity().then(update).catch(() => {});
  Object.defineProperty(window, 'selfLive', { value: Object.freeze({
    ...bridge, get portMapping() { return mapping; },
    get relay() { return viewerRelay || hostRelay; },
    get signaling() { return signaling; },
    setSignaling: value => { if (['direct', 'relay', 'failed'].includes(value)) signaling = value; },
    relayClose: async () => { viewerRelay = null; await bridge.relayClose(); }
  }), writable: false, configurable: false });
} });

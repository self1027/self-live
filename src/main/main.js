const { app, BrowserWindow, ipcMain, session, dialog, Menu, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { startServers } = require('./server');
const { setupCaptureHandlers } = require('./capture');
const { createTray } = require('./tray');
const { passwordHash } = require('../shared/crypto');
const { getPreferredEndpoints } = require('./network');
const { createConnectivity, readPortMappingConfig } = require('./connectivity');
const { encodeAccessLink, decodeAccessLink } = require('./access-link');
const { selectMediaPorts } = require('./media-ports');
const { readTurnConfig, generateTurnCredentials } = require('./turn');
const { createShutdown } = require('./shutdown');
const { readRelayConfig, relayKey, attachHostRelay, installRelayIpc } = require('./relay-client');
const { createPilotConfig, applyPilotDefaults } = require('./pilot-config');
const { createApplicationAudio } = require('./application-audio');
const { createSharePreferences } = require('./share-preferences');
const { createMediaAudit } = require('./media-audit');
const { createDiagnosticSettings } = require('./diagnostic-settings');
const { createGpuPriority } = require('./gpu-priority');
const { createCaptureState } = require('./capture-state');
const { shell } = require('electron');

app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
// Mantém captura ativa com o dashboard minimizado na bandeja.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
let window, servers, tray, connectivity, applicationAudio, mediaAudit, gpuPriority, quitting = false;
const shutdown = createShutdown({ app, ipcMain, getWindow: () => window, getServers: () => servers,
  closePorts: async () => { applicationAudio?.stop(); await Promise.allSettled([gpuPriority?.setEnabled(false), connectivity?.closePorts()]); },
  getTray: () => tray, onStart: () => { quitting = true; mediaAudit?.stop('shutdown'); } });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const runtimeEnv = { ...process.env };
  const pilot = createPilotConfig(app.getPath('userData'), safeStorage);
  const sharePreferences = createSharePreferences(app.getPath('userData'));
  const diagnosticSettings = createDiagnosticSettings(app.getPath('userData'));
  mediaAudit = createMediaAudit({ app, enabled:diagnosticSettings.load().loggingEnabled,
    gpuPriorityProvider: () => gpuPriority?.snapshot() });
  gpuPriority = createGpuPriority({ app, onChange: state => {
    mediaAudit.gpuPriorityChanged(state);
    if (window && !window.isDestroyed()) window.webContents.send('gpu-priority-status', state);
  } });
  await gpuPriority.setEnabled(diagnosticSettings.load().gpuPriorityEnabled);
  ipcMain.handle('gpu-priority-status', event => { trusted(event); return gpuPriority.snapshot(); });
  ipcMain.handle('media-audit-start', async (event, value) => { trusted(event); await gpuPriority.refresh(); return mediaAudit.start(value); });
  ipcMain.on('media-audit-sample', (event, value) => { trusted(event); mediaAudit.sample(value); });
  ipcMain.on('media-audit-stop', event => { trusted(event); mediaAudit.stop(); });
  ipcMain.handle('diagnostic-settings', event => { trusted(event); return diagnosticSettings.load(); });
  ipcMain.handle('diagnostic-settings-save', async (event, value) => {
    trusted(event);
    if ((value?.loggingEnabled !== undefined || value?.gpuPriorityEnabled !== undefined) && isStreaming) throw new Error('Pare a transmissão para alterar.');
    const saved = diagnosticSettings.save(value); mediaAudit.setEnabled(saved.loggingEnabled);
    if (value?.gpuPriorityEnabled !== undefined) await gpuPriority.setEnabled(saved.gpuPriorityEnabled);
    if (!saved.loggingEnabled && !saved.adaptiveQuality) mediaAudit.pauseSampling();
    return saved;
  });
  ipcMain.handle('diagnostic-sample', (event, value) => { trusted(event); return mediaAudit.sample(value, { adaptive:diagnosticSettings.load().adaptiveQuality }); });
  ipcMain.handle('diagnostic-event', (event, value) => { trusted(event); mediaAudit.event(value); });
  ipcMain.handle('diagnostic-export', event => { trusted(event); return mediaAudit.exportReport(diagnosticSettings.load()); });
  ipcMain.handle('diagnostic-folder', async event => {
    trusted(event); require('node:fs').mkdirSync(mediaAudit.directory, { recursive:true });
    const error = await shell.openPath(mediaAudit.directory); if (error) throw new Error('Não foi possível abrir a pasta de logs.');
  });
  applyPilotDefaults(runtimeEnv, pilot.snapshot(), pilot.password());
  const turn = readTurnConfig(runtimeEnv);
  // O main guarda sua cópia privada; novos renderers não herdam a variável.
  delete runtimeEnv.SELF_LIVE_TURN_SECRET;
  delete process.env.SELF_LIVE_TURN_SECRET;
  const iceTransportPolicy = runtimeEnv.SELF_LIVE_ICE_TRANSPORT_POLICY || 'all';
  if (!['all', 'relay'].includes(iceTransportPolicy)) throw new Error('SELF_LIVE_ICE_TRANSPORT_POLICY deve ser all ou relay.');
  if (iceTransportPolicy === 'relay' && !turn) console.warn('[TURN] Política relay sem TURN configurado; o teste de conexão falhará.');
  const room = runtimeEnv.SELF_LIVE_ROOM || 'sala-local';
  const mappingConfig = readPortMappingConfig(runtimeEnv);
  const password = runtimeEnv.SELF_LIVE_PASSWORD || 'self-live-local';
  const port = name => {
    const value = Number(runtimeEnv[name] || 0);
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Porta inválida: ${name}`);
    return value;
  };
  const remote = runtimeEnv.SELF_LIVE_SIGNAL_URL;
  const relayConfig = readRelayConfig(runtimeEnv, room);
  const forcedRelay = Boolean(remote && relayConfig && new URL(remote).href === new URL(relayConfig.url).href);
  const remoteFingerprint = runtimeEnv.SELF_LIVE_SIGNAL_FINGERPRINT?.toUpperCase();
  if (remote && (new URL(remote).protocol !== 'wss:' || (!forcedRelay && !/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(remoteFingerprint || '')))) {
    throw new Error('Informe SELF_LIVE_SIGNAL_URL (wss://) e SELF_LIVE_SIGNAL_FINGERPRINT (SHA-256 do host).');
  }
  servers = await startServers(room, passwordHash(password, room), {
    httpPort: port('SELF_LIVE_HTTP_PORT'), wsPort: port('SELF_LIVE_WS_PORT'),
    wsHost: runtimeEnv.SELF_LIVE_WS_HOST || undefined, signalUrl: remote
  });
  const hostRelay = !remote && relayConfig ? attachHostRelay(servers, {
    ...relayConfig, hash: passwordHash(password, room), key: relayKey(password, room), log: text => console.info(text)
  }) : null;
  hostRelay?.on('warning', () => console.warn('[relay] Relay indisponível ou mensagem rejeitada; WSS local continua ativo.'));
  hostRelay?.on('status', state => {
    if (!quitting && window && !window.isDestroyed()) window.webContents.send('relay-event', { kind: 'host-status', value: state });
  });
  const endpoints = getPreferredEndpoints();
  const mediaRange = await selectMediaPorts(runtimeEnv.SELF_LIVE_MEDIA_PORT === undefined ? undefined : Number(runtimeEnv.SELF_LIVE_MEDIA_PORT));
  connectivity = createConnectivity({ servers, endpoints, udpPorts: mediaRange.ports, ...mappingConfig,
    onUpdate: state => { if (!quitting && window && !window.isDestroyed()) window.webContents.send('connectivity-update', state); } });
  void connectivity.start();
  const endpointUrls = endpoints.map(endpoint => `wss://${endpoint.family === 'IPv6' ? `[${endpoint.ip}]` : endpoint.ip}:${servers.wsPort}`);
  const wsUrl = remote || servers.wsUrl;
  const signalEndpoints = forcedRelay ? [{ type: 'relay', ...relayConfig, priority: 3 }] :
    [{ type: new URL(wsUrl).hostname.includes(':') ? 'ipv6' : remote ? 'ipv4-manual' : 'ipv4-local',
      url: wsUrl, priority: remote ? 3 : 4 }];
  let importedAccess = null, joinRoom = room;
  let permittedUrls = new Set();
  let pins = new Map();
  const hostOf = url => new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const pin = (url, fingerprint) => {
    const host = hostOf(url);
    permittedUrls.add(new URL(url).href);
    if (!pins.has(host)) pins.set(host, new Set());
    pins.get(host).add(fingerprint);
  };
  const resetPins = access => {
    permittedUrls = new Set(); pins = new Map();
    pin(servers.wsUrl, servers.fingerprint);
    // Há um único canal de sala ativo. Se host remoto e WSS próprio compartilham
    // hostname (ex.: duas instâncias em localhost), somente o pin do destino
    // pode validar esse hostname durante a entrada na sala remota.
    if (access) {
      access.endpoints.filter(endpoint => endpoint.type !== 'relay').forEach(endpoint => pins.set(hostOf(endpoint.url), new Set([access.fingerprint])));
      access.endpoints.filter(endpoint => endpoint.type !== 'relay').forEach(endpoint => pin(endpoint.url, access.fingerprint));
    } else if (remote && !forcedRelay) {
      pins.set(hostOf(remote), new Set([remoteFingerprint]));
      pin(remote, remoteFingerprint);
    }
  };
  resetPins(null);
  // Sessão em memória por processo: duas instâncias não compartilham estado/cache.
  const appSession = session.fromPartition(`self-live-${process.pid}`);
  const verifyCertificate = (request, callback) => {
    let matches = false;
    try {
      const fingerprint = new X509Certificate(request.certificate.data).fingerprint256;
      matches = Boolean(pins.get(request.hostname.replace(/^\[|\]$/g, '').toLowerCase())?.has(fingerprint));
    } catch {}
    const pinnedHost = pins.has(request.hostname.replace(/^\[|\]$/g, '').toLowerCase());
    callback(matches ? 0 : pinnedHost ? -2 : -3);
  };
  appSession.setCertificateVerifyProc(verifyCertificate);
  appSession.webRequest.onBeforeRequest({ urls: ['wss://*/*'] }, (details, callback) => {
    let allowed = false;
    try { allowed = permittedUrls.has(new URL(details.url).href); } catch {}
    callback({ cancel: !allowed });
  });
  const capture = setupCaptureHandlers(appSession, () => window, servers.url);
  const trusted = event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith(servers.url + '/')) throw new Error('IPC não autorizado');
  };
  let relaySecret;
  const relayIpc = installRelayIpc({ ipcMain, trusted, getWindow: () => window,
    getAccess: () => importedAccess || (forcedRelay ? { room, endpoints: signalEndpoints } : null),
    getSecret: () => relaySecret, getHostRelay: () => hostRelay, log: text => console.info(text) });
  const closeServers = servers.close.bind(servers);
  servers.close = async () => {
    await Promise.all([hostRelay?.close(), relayIpc.close()]);
    await closeServers();
  };
  ipcMain.handle('config', event => { trusted(event); return {
    room, wsUrl, localWsUrl: servers.wsUrl, fingerprint: servers.fingerprint,
    endpoints, endpointUrls, bindings: servers.bindings, wsPort: servers.wsPort,
    name: runtimeEnv.SELF_LIVE_NAME || `Peer ${process.pid}`, requiresName: pilot.snapshot().nameChosen === false, iceTransportPolicy, turnEnabled: Boolean(turn), pilotEnabled: true,
    signalEndpoints, udpPorts: mediaRange.ports
  }; });
  ipcMain.handle('network-status', event => { trusted(event); return connectivity.natStatus(); });
  ipcMain.handle('pilot-settings', event => { trusted(event); return pilot.snapshot(); });
  ipcMain.handle('user-name-save', (event, name) => {
    trusted(event); const saved = pilot.saveName(name); runtimeEnv.SELF_LIVE_NAME = saved; return saved;
  });
  ipcMain.handle('share-preferences', event => { trusted(event); return sharePreferences.load(); });
  ipcMain.handle('share-preferences-save', (event, value) => { trusted(event); return sharePreferences.save(value); });
  ipcMain.handle('pilot-password', event => { trusted(event); return password; });
  ipcMain.handle('clipboard-write', (event, text) => {
    trusted(event);
    if (typeof text !== 'string' || !text || text.length > 65536) throw new Error('Texto inválido para copiar.');
    clipboard.writeText(text);
  });
  ipcMain.handle('pilot-save', (event, value) => {
    trusted(event); const result = pilot.save(value); return result;
  });
  ipcMain.handle('pilot-restart', event => {
    trusted(event); app.relaunch(); setImmediate(() => { void shutdown(); });
  });
  ipcMain.handle('connectivity', event => { trusted(event); return connectivity.snapshot(); });
  ipcMain.handle('generate-access-link', (event, nodeId) => {
    trusted(event);
    if (importedAccess) return encodeAccessLink(importedAccess);
    if (remote) throw new Error('Gere o link no host da sala ou importe o convite recebido.');
    return encodeAccessLink({ node_id: nodeId, name: runtimeEnv.SELF_LIVE_NAME || `Peer ${process.pid}`,
      room, fingerprint: servers.fingerprint, endpoints: [...connectivity.endpoints().map(endpoint =>
        hostRelay && endpoint.type === 'ipv4-local' ? { ...endpoint, type: 'lan' } : endpoint),
        ...(hostRelay ? [{ type: 'relay', url: relayConfig.url, room: relayConfig.room,
          host: hostRelay.nodeId, priority: 3, ...(relayConfig.fingerprint ? { fingerprint: relayConfig.fingerprint } : {}) }] : [])] });
  });
  ipcMain.handle('use-access-link', (event, link) => {
    trusted(event);
    const access = link === '' ? null : decodeAccessLink(link);
    importedAccess = access; joinRoom = access?.room || room; relaySecret = null;
    resetPins(access);
    appSession.setCertificateVerifyProc(verifyCertificate);
    return access;
  });
  ipcMain.handle('generate-turn-credentials', (event, nodeId) => {
    trusted(event);
    return generateTurnCredentials(turn, nodeId);
  });
  ipcMain.handle('sources', event => { trusted(event); return capture.sources(); });
  const captureState = createCaptureState({app});
  ipcMain.handle('capture-source-state', event => { trusted(event); return captureState.sample(capture.activeSource()); });
  ipcMain.handle('capture-recover', event => { trusted(event); capture.recover(); });
  ipcMain.handle('capture-confirm', (event,id) => { trusted(event); capture.confirm(id); });
  applicationAudio = createApplicationAudio({ app, getWindow: () => window });
  ipcMain.handle('application-audio-sources', event => { trusted(event); return applicationAudio.sources(); });
  ipcMain.handle('select-source', (event, id, audioId) => { trusted(event); capture.select(id, audioId); });
  ipcMain.handle('application-audio-start', event => { trusted(event); return applicationAudio.start(capture.audioSource()); });
  ipcMain.handle('application-audio-stop', event => { trusted(event); applicationAudio.stop(); });
  ipcMain.handle('hash', (event, value, name) => {
    trusted(event);
    if (typeof value !== 'string' || value.length > 1024 || name !== joinRoom) throw new Error('Entrada inválida');
    const hash = passwordHash(value, name);
    relaySecret = { hash, key: relayKey(value, name) };
    return hash;
  });
  let isStreaming = false;
  ipcMain.on('streaming', (event, active) => { trusted(event); isStreaming = Boolean(active); tray.update(isStreaming); });
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 800, backgroundColor: '#10151d',
    webPreferences: { session: appSession, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWebRTCUDPPortRange({ min: mediaRange.min, max: mediaRange.max });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== servers.url + '/') event.preventDefault(); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  tray = createTray(() => { window.show(); window.focus(); }, action => {
    if (!quitting) window.webContents.send('tray-action', action);
  }, shutdown);
  await window.loadURL(servers.url);
  console.log(`Dashboard: ${servers.url}\nWSS local: ${servers.wsUrl}\nSHA-256: ${servers.fingerprint}`);
  console.log(`[Rede] WSS porta ${servers.wsPort}; interfaces: ${endpoints.filter(e => e.family === 'IPv6').length} IPv6, ${endpoints.filter(e => e.family === 'IPv4').length} IPv4. Endpoints disponíveis no dashboard.`);
}).catch(error => { dialog.showErrorBox('Self Live — falha na inicialização', error.message); app.quit(); });
app.on('before-quit', event => {
  event.preventDefault();
  void shutdown();
});
app.on('window-all-closed', () => {});


// Fixture isolado do produto: usa o dashboard/preload reais e substitui apenas
// captura por canvas + tom. Comandos de QA chegam pelo IPC do processo pai.
const { app, BrowserWindow, session, ipcMain, nativeImage } = require('electron');
const { startServers } = require('../src/main/server');
const { passwordHash } = require('../src/shared/crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createMediaAudit } = require('../src/main/media-audit');
const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(),'self-live-audit-ui-'));
const mediaAudit = createMediaAudit({app,directory:auditDirectory});
app.on('will-quit',()=> { mediaAudit.stop('shutdown'); fs.rmSync(auditDirectory,{recursive:true,force:true}); });
const { getPreferredEndpoints } = require('../src/main/network');
const { createShutdown } = require('../src/main/shutdown');
const { createTray } = require('../src/main/tray');
const { setupSmokeConnectivity } = require('./smoke-connectivity');
const { attachHostRelay, installRelayIpc, relayKey, roomToken } = require('../src/main/relay-client');
const name = process.env.SELF_LIVE_SMOKE_NAME;
const room = process.env.SELF_LIVE_SMOKE_ROOM || 'smoke';
const password = process.env.SELF_LIVE_SMOKE_PASSWORD || 'senha';
let servers, window, tray, connectivity, quitting = false;
const shutdown = createShutdown({ app, ipcMain, getWindow: () => window, getServers: () => servers,
  getTray: () => tray, onStart: () => { quitting = true; } });
app.on('before-quit', event => { event.preventDefault(); void shutdown(); });

process.on('message', async command => {
  try {
    if (command.type === 'screenshot') {
      const image = await window.webContents.capturePage();
      require('node:fs').writeFileSync(command.code, image.toPNG());
      process.send({ id: command.id, ok: true });
    } else if (command.type === 'audit') {
      const records = fs.readdirSync(auditDirectory).filter(file=>file.endsWith('.jsonl')).flatMap(file => fs.readFileSync(path.join(auditDirectory,file),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
      process.send({ id:command.id, ok:true, result:records });
    } else if (command.type === 'processes') {
      process.send({ id: command.id, ok: true, result: app.getAppMetrics().map(metric => metric.pid) });
    } else if (command.type === 'quit') {
      process.send({ id: command.id, ok: true });
      tray.menu.items.find(item => item.label === 'Sair').click();
    } else if (command.type === 'close-window') {
      window.close();
      process.send({ id: command.id, ok: true, result: { destroyed: window.isDestroyed(), visible: window.isVisible() } });
    } else if (command.type === 'connectivity') {
      connectivity.update(command.code);
      process.send({ id: command.id, ok: true });
    } else {
      const result = await window.webContents.executeJavaScript(command.code, true);
      process.send({ id: command.id, ok: true, result });
    }
  } catch (error) { process.send({ id: command.id, ok: false, error: error.stack }); }
});

app.whenReady().then(async () => {
  servers = await startServers(room, passwordHash(password, room));
  const url = process.env.SELF_LIVE_SMOKE_URL || servers.wsUrl;
  const fingerprint = process.env.SELF_LIVE_SMOKE_FINGERPRINT || servers.fingerprint;
  const ses = session.fromPartition(`room-smoke-${process.pid}`);
  const endpoints = getPreferredEndpoints();
  const relayUrl = process.env.SELF_LIVE_SMOKE_RELAY_URL;
  const forcedRelay = Boolean(process.env.SELF_LIVE_SMOKE_FORCE_RELAY);
  const hostRelay = relayUrl && !process.env.SELF_LIVE_SMOKE_LINK && !forcedRelay ? attachHostRelay(servers, {
    url: relayUrl, fingerprint: process.env.SELF_LIVE_SMOKE_RELAY_PIN,
    room: roomToken(room), hash: passwordHash(password, room), key: relayKey(password, room)
  }) : null;
  const relayEndpoint = hostRelay ? { type: 'relay', priority: 3, url: relayUrl,
    room: roomToken(room), host: hostRelay.nodeId, ...(process.env.SELF_LIVE_SMOKE_RELAY_PIN ? { fingerprint: process.env.SELF_LIVE_SMOKE_RELAY_PIN } : {}) } : null;
  const forcedEndpoints = [{ type: 'relay', priority: 3, url: relayUrl, room: roomToken(room),
    ...(process.env.SELF_LIVE_SMOKE_RELAY_PIN ? { fingerprint: process.env.SELF_LIVE_SMOKE_RELAY_PIN } : {}) }];
  hostRelay?.on('status', value => window?.webContents.send('relay-event', { kind: 'host-status', value }));
  connectivity = await setupSmokeConnectivity({ ipcMain, ses, servers, url, fingerprint, name, endpoints, relayEndpoint, room });
  let secret;
  const relayIpc = installRelayIpc({ ipcMain, trusted: event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('IPC não autorizado');
  }, getWindow: () => window, getAccess: () => connectivity.getAccess() || (forcedRelay ? { room, endpoints: forcedEndpoints } : null),
    getSecret: () => secret, getHostRelay: () => hostRelay });
  const close = servers.close.bind(servers);
  servers.close = async () => { await Promise.all([hostRelay?.close(), relayIpc.close()]); await close(); };
  const endpointUrls = endpoints.map(endpoint => `wss://${endpoint.family === 'IPv6' ? `[${endpoint.ip}]` : endpoint.ip}:${servers.wsPort}`);
  ipcMain.handle('config', () => ({ room, wsUrl: url, localWsUrl: servers.wsUrl, fingerprint, name,
    ...(forcedRelay ? { signalEndpoints: forcedEndpoints } : {}),
    endpoints, endpointUrls, bindings: servers.bindings, wsPort: servers.wsPort, udpPorts: connectivity.mediaRange.ports }));
  const bitmap = Buffer.alloc(256 * 144 * 4);
  for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 130; bitmap[i + 1] = 90; bitmap[i + 2] = 35; bitmap[i + 3] = 255; }
  const thumbnail = nativeImage.createFromBitmap(bitmap, { width: 256, height: 144 }).toDataURL();
  ipcMain.handle('sources', () => [{ id: 'screen:synthetic', name: 'Canvas de teste', thumbnail, width: 640, height: 360 },
    {id:'window:synthetic',name:'Janela de teste',thumbnail,width:640,height:360}]);
  let sharePreferences = { audioMode: 'window', applications: [], manual: '', bitrate: '10000000' };
  ipcMain.handle('share-preferences', () => sharePreferences);
  ipcMain.handle('share-preferences-save', (_event, value) => { sharePreferences = value; return value; });
  ipcMain.handle('media-audit-start', (_event, value) => mediaAudit.start(value));
  ipcMain.on('media-audit-sample', (_event, value) => mediaAudit.sample(value));
  ipcMain.on('media-audit-stop', () => mediaAudit.stop());
  let diagnosticSettings = { loggingEnabled:false, adaptiveQuality:true, previewHidden:false, resolution:'auto', frameRate:60 };
  ipcMain.handle('diagnostic-settings', () => diagnosticSettings);
  ipcMain.handle('diagnostic-settings-save', (_event,value) => { diagnosticSettings = {...diagnosticSettings,...value}; mediaAudit.setEnabled(diagnosticSettings.loggingEnabled); return diagnosticSettings; });
  ipcMain.handle('diagnostic-sample', (_event,value) => mediaAudit.sample(value,{adaptive:diagnosticSettings.adaptiveQuality}));
  ipcMain.handle('diagnostic-event', (_event,value) => mediaAudit.event(value));
  ipcMain.handle('diagnostic-export', () => mediaAudit.exportReport(diagnosticSettings));
  ipcMain.handle('diagnostic-folder', () => {});
  ipcMain.handle('application-audio-start', () => ({enabled:false,reason:'Sem áudio nativo na fixture'}));
  ipcMain.on('application-audio-stop', () => {});
  ipcMain.handle('application-audio-stop', () => {});
  ipcMain.handle('generate-turn-credentials', () => null);
  ipcMain.handle('network-status', () => ({ status: 'unknown' }));
  ipcMain.handle('select-source', () => {});
  ipcMain.handle('application-audio-sources', () => ({ available: true, applications: [
    {name:'JogoQA.exe',blocked:false},{name:'PlayerQA.exe',blocked:false},{name:'Discord.exe',blocked:true}
  ] }));
  ipcMain.handle('hash', (_event, password, room) => {
    const hash = passwordHash(password, room); secret = { hash, key: relayKey(password, room) }; return hash;
  });
  ipcMain.on('streaming', (_event, active) => tray?.update(active));
  window = new BrowserWindow({ show: false, width: 1280, height: 960, webPreferences: {
    session: ses, preload: path.join(__dirname, '../src/main/preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
  } });
  connectivity.attach(window);
  window.webContents.on('console-message', event => {
    if (event.level === 3) console.error(`[${name}] Renderer: ${event.message}`);
    if (event.message?.startsWith('[Sinalização]')) console.info(`[${name}] ${event.message}`);
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  tray = createTray(() => window.show(), action => window.webContents.send('tray-action', action), shutdown);
  await window.loadURL(servers.url);
  await window.webContents.executeJavaScript(`
    (async () => {
    window.smoke = { connections: [] };
    const blocked = ${JSON.stringify(process.env.SELF_LIVE_SMOKE_BLOCKED_URL || '')};
    const target = ${JSON.stringify(process.env.SELF_LIVE_SMOKE_BLOCKED_TARGET || '')};
    if (blocked) {
      const NativeWS = window.WebSocket;
      window.WebSocket = new Proxy(NativeWS, { construct(type, args) {
        if (new URL(args[0]).href === new URL(blocked).href) args[0] = target;
        return Reflect.construct(type, args);
      } });
    }
    const NativePC = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePC, { construct(target, args) {
      const pc = new target(...args); window.smoke.connections.push(pc); return pc;
    } });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#d33682' : '#268bd2'; ctx.fillRect(0,0,640,360); }, 33);
      const stream = canvas.captureStream(30);
      const audio = new AudioContext(); await audio.resume();
      const tone = audio.createOscillator(); tone.frequency.value = 440;
      const destination = audio.createMediaStreamDestination(); tone.connect(destination); tone.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      const nativeStop = stream.getVideoTracks()[0].stop.bind(stream.getVideoTracks()[0]);
      stream.getVideoTracks()[0].stop = () => { clearInterval(timer); audio.close().catch(() => {}); nativeStop(); };
      return stream;
    };
    document.getElementById('password').value = ${JSON.stringify(password)};
    document.getElementById('access-link').value = ${JSON.stringify(process.env.SELF_LIVE_SMOKE_LINK || '')};
    if (${Boolean(process.env.SELF_LIVE_SMOKE_LANDING)}) return;
    document.getElementById('join').requestSubmit();
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (document.getElementById('connection').textContent.startsWith('Conectado')) { clearInterval(timer); resolve(); }
        else if (Date.now() - started > 10000) { clearInterval(timer); reject(new Error('Handshake timeout')); }
      }, 100);
    });
    })()
  `, true);
  process.send({ type: 'ready', url: servers.wsUrl, fingerprint: servers.fingerprint, dashboard: servers.url,
    endpoints, bindings: servers.bindings, udpPorts: connectivity.mediaRange.ports });
}).catch(async error => { console.error(`[Fixture ${name}]`, error); await servers?.close(); app.exit(1); });

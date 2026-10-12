// Dois processos Electron usam o dashboard real e mídia sintética de canvas/tom.
// O fixture simula só seleção/captura; handshake, relay, WebRTC e botões são reais.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const { startServers } = require('../src/main/server');
const { passwordHash } = require('../src/shared/crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setupSmokeConnectivity } = require('./smoke-connectivity');
const role = process.env.SELF_LIVE_SMOKE_ROLE;
let servers, window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  servers = await startServers('smoke', passwordHash('senha', 'smoke'));
  const ses = session.fromPartition(`smoke-${process.pid}`);
  const url = role === 'host' ? servers.wsUrl : process.env.SELF_LIVE_SMOKE_URL;
  const fingerprint = role === 'host' ? servers.fingerprint : process.env.SELF_LIVE_SMOKE_FINGERPRINT;
  const connectivity = await setupSmokeConnectivity({ ipcMain, ses, servers, url, fingerprint, name: role });
  ipcMain.handle('config', () => ({ room: 'smoke', wsUrl: url, localWsUrl: servers.wsUrl, fingerprint, name: role }));
  ipcMain.handle('relay-status', () => ({ state: 'disabled', status: 'disabled', url: null, reconnects: 0, backoff: 0 }));
  ipcMain.handle('sources', () => [{ id: 'synthetic', name: 'Canvas de teste' }]);
  ipcMain.handle('share-preferences', () => ({ audioMode: 'window', applications: [], manual: '', bitrate: '10000000' }));
  ipcMain.handle('share-preferences-save', (_event, value) => value);
  ipcMain.handle('generate-turn-credentials', () => null);
  ipcMain.handle('network-status', () => ({ status: 'unknown' }));
  ipcMain.handle('select-source', () => {});
  ipcMain.handle('application-audio-sources', () => ({ available: true, applications: [] }));
  ipcMain.handle('hash', (_event, password, room) => passwordHash(password, room));
  ipcMain.on('streaming', () => {});
  window = new BrowserWindow({ show: false, webPreferences: {
    session: ses, preload: path.join(__dirname, '../src/main/preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
  } });
  connectivity.attach(window);
  await window.loadURL(servers.url);
  await window.webContents.executeJavaScript(`
    window.smoke = { connections: [] };
    const NativePC = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePC, { construct(target, args) {
      const pc = new target(...args); window.smoke.connections.push(pc); return pc;
    } });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      window.smoke.timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#d33682' : '#268bd2'; ctx.fillRect(0,0,640,360); }, 33);
      const stream = canvas.captureStream(30);
      const audio = new AudioContext(); await audio.resume();
      const tone = audio.createOscillator(); tone.frequency.value = 440;
      const destination = audio.createMediaStreamDestination(); tone.connect(destination); tone.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      window.smoke.audio = audio;
      return stream;
    };
    document.getElementById('password').value = 'senha';
    document.getElementById('join').requestSubmit();
  `, true);
  async function waitFor(expression, message, timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await delay(100);
    }
    const error = await window.webContents.executeJavaScript("document.getElementById('error').textContent + ' | ' + document.getElementById('connection').textContent");
    throw new Error(`${message}: ${error}`);
  }
  await waitFor("document.getElementById('connection').textContent.startsWith('Conectado')", 'Handshake do dashboard falhou');
  if (!await window.webContents.executeJavaScript("window.selfLive.signaling === 'direct' && window.selfLive.relay.status === 'disabled'")) {
    throw new Error('Modo P2P puro deve usar sinalização direta com relay desativado');
  }
  if (role === 'host') {
    await window.webContents.executeJavaScript("document.getElementById('start-stream').click()", true);
    await waitFor("document.getElementById('status').textContent === 'Transmitindo'", 'Botão de transmissão falhou');
    fs.writeFileSync(process.env.SELF_LIVE_SMOKE_READY, JSON.stringify({ url, fingerprint }));
    return;
  }
  await waitFor("Boolean(document.querySelector('#peers button'))", 'Lista de peers não exibiu Assistir');
  await window.webContents.executeJavaScript("document.querySelector('#peers button').click()", true);
  await waitFor("document.getElementById('p2p-status').textContent === 'Assistindo host'", 'Viewer não conectou', 20000);
  await delay(1000);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const video = document.getElementById('p2p-video');
    const pc = window.smoke.connections.at(-1);
    const stats = await pc.getStats();
    const inbound = [...stats.values()].filter(s => s.type === 'inbound-rtp');
    return { state: pc.connectionState, status: document.getElementById('p2p-status').textContent,
      width: video.videoWidth, height: video.videoHeight, tracks: video.srcObject?.getTracks().map(t => t.kind),
      media: inbound.map(s => ({kind: s.kind, bytes: s.bytesReceived, frames: s.framesDecoded,
        samples: s.totalSamplesReceived, codec: stats.get(s.codecId)?.mimeType})) };
  })()`);
  if (!(result.state === 'connected' && result.width > 0 && result.media.some(m => m.codec === 'video/H264' && m.frames > 5) && result.media.some(m => m.codec === 'audio/opus' && m.bytes > 0))) {
    throw new Error('Mídia P2P não validada: ' + JSON.stringify(result));
  }
  console.log(JSON.stringify(result));
  // Exercita o encerramento do viewer e a limpeza do vídeo pelo botão real.
  await window.webContents.executeJavaScript("document.getElementById('stop-watch').click()", true);
  await waitFor("document.getElementById('p2p-video').srcObject === null && window.smoke.connections.at(-1).connectionState === 'closed'", 'Parar viewer não liberou a conexão');
  await servers.close(); app.quit();
}).catch(async error => { console.error(error); await servers?.close(); app.exit(1); });

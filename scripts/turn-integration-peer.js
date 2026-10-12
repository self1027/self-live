// Fixture Electron independente. Dois endpoints ICE no mesmo renderer; nenhum
// servidor de sinalização, captura de desktop ou segredo principal no renderer.
const { app, BrowserWindow } = require('electron');
const { readTurnConfig, generateTurnCredentials } = require('../src/main/turn');
let window;
let finished = false;
const silentLog = { info() {}, warn() {} };
const config = readTurnConfig(process.env, silentLog);
delete process.env.SELF_LIVE_TURN_SECRET;
app.commandLine.appendSwitch('disable-logging');
// finish() controla a saída após o resultado IPC ser entregue ao runner.
app.on('window-all-closed', () => {});

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(safetyTimer);
  if (window && !window.isDestroyed()) window.destroy();
  if (process.connected) process.send(result, () => app.exit(0));
  else app.exit(1);
}
// Mesmo se loadURL/executeJavaScript falhar, a fixture encerra seus processos.
const safetyTimer = setTimeout(() => finish({ failed: true }), 25000);
process.on('disconnect', () => { if (!finished) finish({ failed: true }); });

app.whenReady().then(async () => {
  if (!config) { finish({ unavailable: true }); return; }
  // Só username/credential/urls entram no renderer. Cada peer recebe sua própria
  // credencial recém-gerada pelo mesmo módulo do processo main do aplicativo.
  const credentials = [
    generateTurnCredentials(config, 'turn-test-a'),
    generateTurnCredentials(config, 'turn-test-b')
  ];
  window = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
  } });
  await window.loadURL('data:text/html,<meta charset="utf-8"><title>Self Live TURN test</title>');
  const result = await window.webContents.executeJavaScript(`(${runRelayTest.toString()})(${JSON.stringify(credentials)})`);
  finish(result);
}).catch(() => finish({ failed: true }));

async function runRelayTest(credentials) {
  const peers = credentials.map(server => new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, server], iceTransportPolicy: 'relay'
  }));
  const [sender, receiver] = peers;
  const pending = [[], []];
  const signaling = [Promise.resolve(), Promise.resolve()];
  const relaySeen = [false, false];
  let signalingFailed = false;
  let received = false;
  let incoming;
  let outgoing;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let index = 0; index < peers.length; index++) {
      const targetIndex = 1 - index;
      const target = peers[targetIndex];
      peers[index].onicecandidate = event => {
        if (!event.candidate) return;
        if (event.candidate.type === 'relay') relaySeen[index] = true;
        // Mantém ICE ordenado e em fila até setRemoteDescription, como o app.
        signaling[targetIndex] = signaling[targetIndex].then(async () => {
          if (target.signalingState === 'closed') return;
          if (target.remoteDescription) await target.addIceCandidate(event.candidate);
          else pending[targetIndex].push(event.candidate);
        }).catch(() => { signalingFailed = true; });
      };
    }
    async function flush(index) {
      await signaling[index];
      for (const candidate of pending[index].splice(0)) await peers[index].addIceCandidate(candidate);
    }
    receiver.ondatachannel = event => {
      incoming = event.channel;
      incoming.onmessage = event => {
        if (event.data === 'self-live-turn-probe') incoming.send('self-live-turn-ack');
      };
    };
    outgoing = sender.createDataChannel('turn-test');
    outgoing.onopen = () => outgoing.send('self-live-turn-probe');
    outgoing.onmessage = event => { if (event.data === 'self-live-turn-ack') received = true; };

    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await flush(1);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    await flush(0);

    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (signalingFailed) return { failed: true };
      if (received && peers.every(peer => peer.connectionState === 'connected')) {
        const reports = await Promise.all(peers.map(async peer => {
          const stats = await peer.getStats();
          const transport = [...stats.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
          const pair = transport ? stats.get(transport.selectedCandidatePairId) : [...stats.values()].find(stat =>
            stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.selected || stat.nominated));
          const localType = stats.get(pair?.localCandidateId)?.candidateType;
          const remoteType = stats.get(pair?.remoteCandidateId)?.candidateType;
          return { valid: pair?.state === 'succeeded' && localType === 'relay' && remoteType === 'relay' };
        }));
        // Par selecionado incorreto sempre falha; uma regressão da política
        // relay não pode ser apresentada como indisponibilidade do servidor.
        if (reports.some(report => !report.valid)) return { failed: true };
        return { ok: true, localType: 'relay', remoteType: 'relay', peerCount: 2, received: true };
      }
      await delay(100);
    }
    // Timeout após obter relay indica falha operacional de negociação,
    // permissões ou transferência, e precisa de correção em vez de skip.
    return relaySeen.some(Boolean) ? { failed: true } : { unavailable: true };
  } catch {
    return { failed: true };
  } finally {
    for (const peer of peers) {
      peer.onicecandidate = null;
      peer.ondatachannel = null;
    }
    if (outgoing) { outgoing.onopen = null; outgoing.onmessage = null; outgoing.close(); }
    if (incoming) { incoming.onmessage = null; incoming.close(); }
    for (const peer of peers) peer.close();
    await Promise.all(signaling);
  }
}

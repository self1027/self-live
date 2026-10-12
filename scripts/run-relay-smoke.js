const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const https = require('node:https');
const selfsigned = require('selfsigned');
const { X509Certificate, randomUUID } = require('node:crypto');
const { startRelay } = require('../relay/server');
const { decodeAccessLink, encodeAccessLink } = require('../src/main/access-link');
const children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fallback = process.argv.includes('--fallback');
const forced = process.argv.includes('--forced');
const publicRelay = process.argv.includes('--public');
const isolated = { SELF_LIVE_SMOKE_ROOM: `smoke-${randomUUID()}`, SELF_LIVE_SMOKE_PASSWORD: randomUUID() };
let relay, blocker;
const blockedSockets = new Set();
async function launch(name, extra = {}) {
  const env = { ...process.env, SELF_LIVE_SMOKE_NAME: name, ...isolated, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const variable of ['SELF_LIVE_SMOKE_URL', 'SELF_LIVE_SMOKE_FINGERPRINT']) delete env[variable];
  const child = spawn(require('electron'), [path.join(__dirname, 'room-smoke-peer.js')], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  children.push(child); let logs = '';
  child.stdout.on('data', data => { logs += data.toString(); }); child.stderr.on('data', data => { logs += data.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout iniciando ${name}`)); }, 25000);
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture ${name} encerrou (${code}): ${logs.slice(-1000)}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  let id = 0;
  return { ...ready, child, logs: () => logs, rpc(type, code) {
    return new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`Timeout RPC ${name}`)); }, 18000);
      const receive = m => {
        if (m.id !== request) return;
        clearTimeout(timer); child.off('message', receive);
        if (m.ok) resolve(m.result); else reject(new Error(m.error));
      };
      child.on('message', receive); child.send({ id: request, type, code });
    });
  } };
}
const evaluate = (peer, code) => peer.rpc('evaluate', code);
const click = (peer, id) => evaluate(peer, `document.getElementById(${JSON.stringify(id)}).click()`);
async function until(peer, expression, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(peer, expression)) return; await delay(100); }
  const debug = await evaluate(peer, `({error: document.getElementById('error').textContent, signal: document.getElementById('connection').textContent, media: document.getElementById('p2p-status').textContent})`);
  throw new Error(`${label}: ${JSON.stringify(debug)}`);
}
async function stats(peer) {
  return evaluate(peer, `(async () => {
    const pc = window.smoke.connections.findLast(pc => pc.connectionState === 'connected');
    const stats = [...(await pc.getStats()).values()];
    return stats.filter(s => s.type === 'inbound-rtp').map(s => ({
      codec: stats.find(c => c.id === s.codecId)?.mimeType, frames: s.framesDecoded || 0, bytes: s.bytesReceived || 0 }));
  })()`);
}
(async () => {
  if (publicRelay && fallback) throw new Error('Fallback usa somente relay local.');
  const cert = publicRelay ? null : await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1 });
  const options = cert ? { key: cert.private, cert: cert.cert, host: '127.0.0.1', port: 0, log() {} } : null;
  if (!publicRelay) relay = await startRelay(options);
  const port = relay?.port;
  const connectionEnv = { SELF_LIVE_SMOKE_RELAY_URL: publicRelay ? 'wss://relay.murilod.dev:8443' : `wss://127.0.0.1:${port}`,
    SELF_LIVE_SMOKE_RELAY_PIN: cert ? new X509Certificate(cert.cert).fingerprint256.replace(/:/g, '') : '' };
  const a = await launch('A', connectionEnv);
  await until(a, `document.getElementById('relay-status').textContent === '🟢 Relay online'`, 'Host registrado');
  await click(a, 'generate-link');
  const access = decodeAccessLink(await evaluate(a, `document.getElementById('invitation-link').value`));
  let endpoints = access.endpoints.filter(e => e.type === 'relay');
  if (fallback) {
    // HTTPS aceita WSS mas nunca conclui o upgrade: exerce timeout real de 5s.
    blocker = https.createServer({ key: cert.private, cert: cert.cert });
    blocker.on('connection', socket => { blockedSockets.add(socket); socket.on('close', () => blockedSockets.delete(socket)); });
    blocker.on('upgrade', () => {});
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    // A fixture redireciona só esta URL sintética ao listener local bloqueado.
    endpoints = [{ type: 'ipv6', url: 'wss://[2001:4860:ffff::1]:4000', priority: 1 }, ...access.endpoints.filter(e => e.type === 'relay')];
  }
  const link = encodeAccessLink({ ...access, endpoints,
    ...(fallback ? { fingerprint: new X509Certificate(cert.cert).fingerprint256 } : {}) });
  if (publicRelay) assert.equal(endpoints[0].fingerprint, undefined, 'Certificado público sem pin no convite');
  const b = await launch('B', { ...connectionEnv, SELF_LIVE_SMOKE_LINK: forced ? '' : link,
    SELF_LIVE_SMOKE_FORCE_RELAY: forced ? '1' : '', ...(fallback ? {
    SELF_LIVE_SMOKE_BLOCKED_URL: endpoints[0].url,
    SELF_LIVE_SMOKE_BLOCKED_TARGET: `wss://127.0.0.1:${blocker.address().port}`
  } : {}) });
  assert.equal(await evaluate(b, `document.getElementById('signaling-mode').textContent`), '🟡 Via relay');
  assert.equal(await evaluate(b, 'window.selfLive.signaling'), 'relay');
  assert.equal(await evaluate(b, 'window.selfLive.relay.status'), 'online');
  assert.equal(await evaluate(b, 'window.selfLive.relay.url'), connectionEnv.SELF_LIVE_SMOKE_RELAY_URL);
  if (fallback) assert.match(b.logs(), /Endpoint ipv6 falhou em 5\.\d+s: timeout/);
  await click(a, 'start-stream');
  await until(b, `Boolean(document.querySelector('#peers li[data-streaming="true"] button'))`, 'Anúncio cifrado de stream');
  await evaluate(b, `document.querySelector('#peers li[data-streaming="true"] button').click()`);
  await until(b, `document.getElementById('p2p-video').videoWidth > 0 && document.getElementById('connection-mode').textContent.startsWith('🟢 Direta')`, 'Mídia direta');
  await delay(600);
  const before = await stats(b);
  assert.ok(before.some(s => s.codec === 'video/H264' && s.frames > 5));
  assert.ok(before.some(s => s.codec === 'audio/opus' && s.bytes > 0));
  const count = await evaluate(b, 'window.smoke.connections.length');
  if (!publicRelay) {
  await relay.close(); relay = null;
  await until(b, `document.getElementById('relay-status').textContent.includes('reconectando')`, 'Backoff do viewer');
  await delay(1500);
  const during = await stats(b);
  assert.ok(during.find(s => s.codec === 'video/H264').frames > before.find(s => s.codec === 'video/H264').frames, 'Mídia continua durante queda');
  relay = await startRelay({ ...options, port });
  for (const peer of [a, b]) await until(peer, `document.getElementById('relay-status').textContent === '🟢 Relay online'`, 'Reconexão');
  await until(b, `document.getElementById('signaling-mode').textContent === '🟡 Via relay'`, 'Dashboard após reconexão');
  assert.equal(await evaluate(b, 'window.smoke.connections.length'), count, 'Reconexão não recria mídia');
  assert.ok(await evaluate(b, 'window.selfLive.relay.reconnects >= 1'), 'Snapshot registra reconexões');
  }
  await click(b, 'stop-watch');
  await until(a, `window.smoke.connections.every(pc => pc.connectionState === 'closed')`, 'Sinalização funciona após reinício');
  for (const peer of [b, a]) {
    const exit = new Promise(resolve => peer.child.once('exit', resolve));
    await peer.rpc('quit'); assert.equal(await exit, 0);
  }
  console.log(`${fallback ? 'Fallback' : forced ? 'Relay forçado' : 'Relay'}${publicRelay ? ' público (CA, sem pin)' : ''} validado: dois processos Electron, H.264/Opus P2P, signaling=relay${publicRelay ? '' : ', recuperação sem interromper mídia'}.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of children) if (child.exitCode === null) child.kill();
  await relay?.close();
  if (blocker) { for (const socket of blockedSockets) socket.destroy(); blocker.closeAllConnections(); await new Promise(resolve => blocker.close(resolve)); }
});

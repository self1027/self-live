const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const electron = require('electron');
const net = require('node:net');
const { encodeAccessLink, decodeAccessLink } = require('../src/main/access-link');
const children = [];
const processIds = new Set();
let nextId = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(name, host) {
  const env = { ...process.env, SELF_LIVE_SMOKE_NAME: name };
  delete env.ELECTRON_RUN_AS_NODE;
  if (host) { env.SELF_LIVE_SMOKE_URL = host.url; env.SELF_LIVE_SMOKE_FINGERPRINT = host.fingerprint; }
  else { delete env.SELF_LIVE_SMOKE_URL; delete env.SELF_LIVE_SMOKE_FINGERPRINT; }
  const child = spawn(electron, [path.join(__dirname, 'room-smoke-peer.js')], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); process.stdout.write(data); });
  child.stderr.on('data', data => { output += data.toString(); process.stderr.write(data); });
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error(`Timeout ao iniciar ${name}`)), 20000);
  child.on('message', message => {
    if (message.type === 'ready') { clearTimeout(timer); readyResolve(message); return; }
    const operation = pending.get(message.id);
    if (!operation) return;
    clearTimeout(operation.timer); pending.delete(message.id);
    if (message.ok) operation.resolve(message.result);
    else operation.reject(new Error(message.error));
  });
  const fail = error => {
    clearTimeout(timer); readyReject(error);
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`${name} encerrou (${code})`)));
  const info = await ready;
  return { ...info, child, name, output: () => output, rpc(type, code) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout do comando em ${name}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, type, code });
    });
  } };
}

const evaluate = (peer, code) => peer.rpc('evaluate', code);
const click = (peer, id) => evaluate(peer, `document.getElementById(${JSON.stringify(id)}).click()`);
const senders = `window.smoke.connections.filter(pc => pc.connectionState !== 'closed' && pc.getSenders().some(sender => sender.track)).length`;
const receivers = `window.smoke.connections.filter(pc => pc.connectionState !== 'closed' && !pc.getSenders().some(sender => sender.track)).length`;

async function waitFor(peer, expression, description, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(peer, expression)) return;
    await delay(100);
  }
  const debug = await evaluate(peer, `({error: document.getElementById('error').textContent, status: document.getElementById('p2p-status').textContent,
    users: document.getElementById('peers').textContent, streams: document.getElementById('streams').textContent,
    connections: window.smoke.connections.map(pc => ({state: pc.connectionState, signaling: pc.signalingState, ice: pc.iceConnectionState}))})`);
  throw new Error(`${description} (${peer.name}): ${JSON.stringify(debug)}`);
}

async function watch(peer, target) {
  const targetLiteral = JSON.stringify(target);
  const selector = `[...document.querySelectorAll('#peers li')].find(li => li.textContent.startsWith(${targetLiteral} + ' ·'))?.querySelector('button')`;
  await waitFor(peer, `Boolean(${selector})`, `Botão Assistir ${target}`);
  await evaluate(peer, `(${selector}).click()`);
  await waitFor(peer, `document.getElementById('p2p-status').textContent === ${JSON.stringify('Assistindo ' + target)}`, `Assistindo ${target}`);
  await waitFor(peer, `document.getElementById('p2p-video').videoWidth > 0`, 'Vídeo recebido');
  await waitFor(peer, `document.getElementById('connection-mode').textContent.startsWith('🟢 Direta') && /^RTT: \\d+ ms$/.test(document.getElementById('connection-rtt').textContent)`, 'Modo direto e RTT no dashboard');
}

async function verifyMedia(peer) {
  await delay(500);
  const result = await evaluate(peer, `(async () => {
    const pc = window.smoke.connections.findLast(pc => pc.connectionState === 'connected' && !pc.getSenders().some(sender => sender.track));
    const stats = await pc.getStats();
    const transport = [...stats.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId);
    const pair = stats.get(transport?.selectedCandidatePairId);
    return { localPort: stats.get(pair?.localCandidateId)?.port,
      media: [...stats.values()].filter(s => s.type === 'inbound-rtp').map(s => ({codec: stats.get(s.codecId)?.mimeType, frames: s.framesDecoded, bytes: s.bytesReceived})) };
  })()`);
  assert.ok(result.media.some(s => s.codec === 'video/H264' && s.frames > 5), 'H.264 decodificado');
  assert.ok(result.media.some(s => s.codec === 'audio/opus' && s.bytes > 0), 'Opus recebido');
  assert.ok(peer.udpPorts.includes(result.localPort), 'Chromium utiliza a faixa UDP anunciada/mapeada');
  console.log(`${peer.name}: ${JSON.stringify(result)}`);
}

(async () => {
  const a = await launch('A');
  const b = await launch('B', a);
  await click(b, 'start-stream');
  await waitFor(a, `document.querySelector('#peers li[data-streaming="true"]')?.textContent.startsWith('B ·')`, 'B anunciado');
  const c = await launch('C', a); // Valida snapshot de stream já ativo no welcome.
  console.log(`Instâncias locais: ${[a, b, c].map(p => `${p.name} ${p.dashboard} ${p.url}`).join(' | ')}`);
  for (const peer of [a, b, c]) await waitFor(peer, `document.querySelectorAll('#peers li[data-peer-id]').length === 3`, 'Presença dos três peers');
  // Usa os botões de link reais e força uma primeira rota local inválida.
  // O endpoint seguinte precisa funcionar mantendo o mesmo pin TLS.
  await click(a, 'generate-link');
  await waitFor(a, `document.getElementById('invitation-link').value.startsWith('self-live://join?data=')`, 'Convite gerado');
  const invitation = decodeAccessLink(await evaluate(a, `document.getElementById('invitation-link').value`));
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const closedPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const fallbackLink = encodeAccessLink({ ...invitation, endpoints: [
    { type: 'ipv4-local', url: `wss://127.0.0.1:${closedPort}`, priority: 4 }, ...invitation.endpoints
  ] });
  await click(c, 'leave');
  await waitFor(a, `document.querySelectorAll('#peers li[data-peer-id]').length === 2`, 'C saiu antes da importação');
  await evaluate(c, `document.getElementById('access-link').value = ${JSON.stringify(fallbackLink)};
    document.getElementById('password').value = 'senha'; document.getElementById('join').requestSubmit();`);
  await waitFor(c, `document.getElementById('connection').textContent.startsWith('Conectado')`, 'Convite tentou fallback WSS');
  await waitFor(a, `document.querySelectorAll('#peers li[data-peer-id]').length === 3`, 'C entrou pelo convite');
  assert.ok(c.output().includes('Endpoint ipv4-local falhou'), 'Log da rota que falhou');
  // Simula eventos main→preload→página; não acessa um roteador real.
  const simulated = { network: { status: 'cgnat', ipv4Status: 'cgnat' }, wsPort: new URL(c.url).port,
    udpPorts: c.udpPorts, ipv6: false, portMapping: { tcp: null, udp: null, method: null, status: 'unavailable' } };
  await c.rpc('connectivity', simulated);
  await waitFor(c, `!document.getElementById('cgnat-warning').hidden && window.selfLive.portMapping.status === 'unavailable'`, 'CGNAT e getter atualizado por IPC');
  await click(c, 'connection-help');
  assert.ok(await evaluate(c, `document.getElementById('connectivity-help').open && document.getElementById('connectivity-instructions').textContent.includes('TURN resolve')`), 'Modal explica sinalização CGNAT');
  await click(c, 'close-connectivity-help');
  simulated.network = { status: 'nat', ipv4Status: 'nat' };
  simulated.portMapping = { tcp: { externalPort: Number(new URL(c.url).port), protocol: 'tcp' },
    udp: { externalPort: c.udpPorts[0], protocol: 'udp' }, method: 'pcp', status: 'mapped' };
  await c.rpc('connectivity', simulated);
  await waitFor(c, `window.selfLive.portMapping.method === 'pcp' && window.selfLive.portMapping.status === 'mapped' && document.getElementById('mapping-tcp').textContent.includes('mapeada via PCP') && document.getElementById('cgnat-warning').hidden`, 'PCP e getter atualizado por IPC');
  for (const peer of [a, b, c]) {
    assert.equal(await evaluate(peer, `document.getElementById('network-status').textContent`),
      peer.endpoints.some(e => e.family === 'IPv6') ? 'IPv6 disponível' : 'Apenas IPv4');
    assert.equal(await evaluate(peer, `document.querySelectorAll('#endpoints li').length`), peer.endpoints.length);
    const hidden = await peer.rpc('close-window');
    assert.equal(hidden.destroyed, false, 'X não destrói a janela');
    assert.equal(peer.child.exitCode, null, 'X não encerra o app');
  }
  await watch(a, 'B'); await watch(c, 'B');
  await waitFor(b, `${senders} === 2`, 'Dois viewers simultâneos de B');
  await verifyMedia(a); await verifyMedia(c);

  // Parar um viewer libera somente sua conexão; a captura e o outro viewer seguem.
  await click(a, 'stop-watch');
  await waitFor(b, `${senders} === 1`, 'Parar de Assistir removeu apenas A');
  await verifyMedia(c);
  await watch(a, 'B');
  await waitFor(b, `${senders} === 2`, 'A voltou a assistir B');

  await click(a, 'start-stream');
  await waitFor(c, `document.querySelectorAll('#streams li[data-peer-id]').length === 2`, 'Duas streams na sala');
  await watch(c, 'A');
  await waitFor(b, `${senders} === 1`, 'Troca removeu conexão C → B');
  await waitFor(a, `${senders} === 1`, 'Nova conexão C → A');
  assert.equal(await evaluate(c, receivers), 1, 'C mantém só um receiver');
  await verifyMedia(c);

  await click(b, 'stop-stream');
  await waitFor(a, `document.getElementById('p2p-status').textContent === 'Streamer parou de transmitir'`, 'A recebeu stop de B');
  assert.equal(await evaluate(c, `document.getElementById('p2p-status').textContent`), 'Assistindo A', 'Stop de B não afeta C assistindo A');
  await verifyMedia(c);

  await click(b, 'start-stream'); await watch(c, 'B');
  await waitFor(a, `${senders} === 0`, 'Troca removeu conexão C → A');
  await click(b, 'stop-stream');
  await waitFor(c, `document.getElementById('p2p-status').textContent === 'Streamer parou de transmitir' && document.getElementById('p2p-video').srcObject === null`, 'C recebeu stop do streamer atual');
  assert.equal(await evaluate(c, receivers), 0, 'C encerrou seu receiver');

  await click(b, 'start-stream'); await watch(c, 'B'); await watch(a, 'B');
  await waitFor(b, `${senders} === 2`, 'Dois viewers antes da saída');
  for (const pid of await c.rpc('processes')) processIds.add(pid);
  const exited = new Promise(resolve => c.child.once('exit', resolve));
  await c.rpc('quit'); assert.equal(await exited, 0);
  for (const peer of [a, b]) await waitFor(peer, `document.querySelectorAll('#peers li[data-peer-id]').length === 2 && ![...document.querySelectorAll('#peers li')].some(li => li.textContent.startsWith('C ·'))`, 'C removido da presença');
  await waitFor(b, `${senders} === 1`, 'Saída de C liberou sua conexão');
  await verifyMedia(a);
  console.log('Sala com três processos validada: presença, múltiplos viewers, troca, stop isolado e saída.');

  // B sai pela ação real Sair do tray enquanto A está assistindo.
  for (const pid of await b.rpc('processes')) processIds.add(pid);
  const exitedB = new Promise(resolve => b.child.once('exit', resolve));
  await b.rpc('quit'); assert.equal(await exitedB, 0);
  await waitFor(a, `document.getElementById('p2p-status').textContent === 'Streamer desconectado' && document.getElementById('p2p-video').srcObject === null`, 'Viewer liberado após saída do streamer');
  for (const stage of ['Parando transmissão', 'Fechando conexões WebRTC', 'Fechando WebSocket', 'Encerrando app']) {
    assert.ok(b.output().includes(stage), `Log ${stage}`);
  }
  assert.ok(!b.output().includes('UnhandledPromiseRejection'), 'Sem promise rejeitada no shutdown');
  for (const pid of await a.rpc('processes')) processIds.add(pid);
  const exitedA = new Promise(resolve => a.child.once('exit', resolve));
  await a.rpc('quit'); assert.equal(await exitedA, 0);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  for (let i = 0; [...processIds].some(alive) && i < 40; i++) await delay(100);
  assert.deepEqual([...processIds].filter(alive), [], 'Nenhum processo Electron do teste ficou pendurado');
  console.log('Shutdown do tray e endpoints validados; todos os processos Electron do teste encerraram.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise(resolve => {
    child.once('exit', resolve); child.kill();
  })));
});

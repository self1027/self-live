const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { X509Certificate } = require('node:crypto');
const selfsigned = require('selfsigned');
const WebSocket = require('ws');
const { startRelay } = require('../relay/server');
const { startServers } = require('../src/main/server');
const { passwordHash } = require('../src/shared/crypto');
const { readRelayConfig, roomToken, relayKey, RelayClient, attachHostRelay, installRelayIpc } = require('../src/main/relay-client');
const { encodeAccessLink, decodeAccessLink } = require('../src/main/access-link');
const loadRenderer = require('../scripts/load-renderer-module');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(10); }
  throw new Error('Timeout esperando peer');
}

test('configuração: default, desativação, namespace e URL/pin inválidos', () => {
  assert.equal(readRelayConfig({}, 'local').url, 'wss://relay.murilod.dev:8443');
  assert.equal(readRelayConfig({ SELF_LIVE_RELAY_URL: '' }, 'local'), null);
  const config = readRelayConfig({ SELF_LIVE_RELAY_ROOM: 'override', SELF_LIVE_RELAY_FINGERPRINT: Array(32).fill('aa').join(':') }, 'local');
  assert.equal(config.room, roomToken('override'));
  assert.equal(config.fingerprint, 'AA'.repeat(32));
  for (const url of ['ws://localhost', 'wss://secret@localhost', 'wss://localhost/private', 'wss://localhost?room=x']) {
    assert.throws(() => readRelayConfig({ SELF_LIVE_RELAY_URL: url }, 'local'));
  }
  assert.throws(() => readRelayConfig({ SELF_LIVE_RELAY_FINGERPRINT: 'short' }, 'local'));
});

test('convite preserva pins independentes do host e relay, ordena relay antes da LAN', () => {
  const link = encodeAccessLink({ node_id: 'host', name: 'Host', room: 'local', fingerprint: Array(32).fill('AA').join(':'),
    endpoints: [ { type: 'ipv4-local', priority: 4, url: 'wss://127.0.0.1:4000' },
      { type: 'relay', priority: 3, url: 'wss://relay.example.com:8443', fingerprint: 'BB'.repeat(32), room: roomToken('local'), host: 'proxy-host' } ] });
  const decoded = decodeAccessLink(link);
  assert.equal(decoded.endpoints[0].type, 'relay');
  assert.notEqual(decoded.endpoints[0].fingerprint, decoded.fingerprint.replace(/:/g, ''));
  assert.equal(decoded.endpoints[0].host, 'proxy-host');
});

test('convite público inclui IPv6, IPv4, relay sem pin e LAN; convite antigo continua válido', () => {
  const payload = { node_id: 'host', name: 'Host', room: 'local', fingerprint: Array(32).fill('AA').join(':'),
    endpoints: [
      { type: 'lan', url: 'wss://192.168.1.2:4000', priority: 4 },
      { type: 'relay', url: 'wss://relay.murilod.dev:8443', priority: 3, room: roomToken('local'), host: 'proxy-host' },
      { type: 'ipv4-direct', url: 'wss://38.211.234.50:4000', priority: 2 },
      { type: 'ipv6', url: 'wss://[2606:4700::1234]:4000', priority: 1 }
    ] };
  const access = decodeAccessLink(encodeAccessLink(payload));
  assert.deepEqual(access.endpoints.map(e => e.type), ['ipv6', 'ipv4-direct', 'relay', 'lan']);
  assert.equal(Object.hasOwn(access.endpoints[2], 'fingerprint'), false);
  const old = decodeAccessLink(encodeAccessLink({ ...payload, endpoints: payload.endpoints.filter(e => e.type !== 'relay') }));
  assert.equal(old.endpoints.length, 3);
  const minimal = decodeAccessLink(encodeAccessLink({ ...payload, endpoints: [
    { type: 'relay', url: 'wss://relay.murilod.dev:8443', priority: 3 }
  ] })).endpoints[0];
  assert.equal(minimal.room, roomToken(payload.room));
  assert.equal(Object.hasOwn(minimal, 'host'), false, 'Sem host no link, descobrir pelo registro');
  assert.equal(Object.hasOwn(minimal, 'fingerprint'), false);
});

test('sem pin um certificado self-signed é rejeitado e WSS local permanece utilizável', async t => {
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1 });
  const relay = await startRelay({ key: cert.private, cert: cert.cert, host: '127.0.0.1', port: 0, log() {} });
  const servers = await startServers('ca-test', passwordHash('password', 'ca-test'));
  const logs = [];
  const client = attachHostRelay(servers, { url: `wss://127.0.0.1:${relay.port}`, room: roomToken('ca-test'),
    hash: passwordHash('password', 'ca-test'), key: relayKey('password', 'ca-test'), log: line => logs.push(line) });
  t.after(async () => { await client.close(); await servers.close(); await relay.close(); });
  await until(() => client.status.state === 'offline' && client.reconnects > 0);
  assert.equal(relay.rooms.size, 0, 'Sem enviar autenticador antes de validar CA');
  const direct = new WebSocket(servers.wsUrl, { rejectUnauthorized: false });
  t.after(() => direct.terminate()); await once(direct, 'open');
  const welcome = once(direct, 'message');
  direct.send(JSON.stringify({ type: 'hello', node_id: 'direct', room: 'ca-test', password_hash: client.hash, endpoints: [] }));
  assert.equal(JSON.parse((await welcome)[0]).type, 'welcome');
  assert.match(logs.join('\n'), /\[relay\] Reconectando \(tentativa 1\)/);
  assert.doesNotMatch(logs.join('\n'), /127\.0\.0\.1|password|ca-test|direct/);
});

test('rejeição 4001 no relay encerra fallback sem circular credenciais', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  let opened = 0;
  await assert.rejects(connectSignaling({ endpoints: [
    { type: 'relay', url: 'wss://relay.example.com', priority: 3 },
    { type: 'ipv4-local', url: 'wss://127.0.0.1:4000', priority: 4 }
  ], log() {}, hello: {}, makeSocket() {
    opened++;
    const socket = { close() {}, send() {} };
    queueMicrotask(() => socket.onclose({ code: 4001 })); return socket;
  } }), { name: 'AuthenticationError' });
  assert.equal(opened, 1);
});

test('peers WSS diretos e via relay compartilham sala e roteiam SDP/ICE cifrados', { timeout: 10000 }, async t => {
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1 });
  const relay = await startRelay({ key: cert.private, cert: cert.cert, host: '127.0.0.1', port: 0, log() {} });
  const servers = await startServers('mixed', passwordHash('strong-password', 'mixed'));
  const host = attachHostRelay(servers, { url: `wss://127.0.0.1:${relay.port}`, room: roomToken('mixed'),
    hash: passwordHash('strong-password', 'mixed'), key: relayKey('strong-password', 'mixed'),
    fingerprint: new X509Certificate(cert.cert).fingerprint256.replace(/:/g, '') });
  t.after(async () => { await host.close(); await servers.close(); await relay.close(); });
  await once(host, 'registered');
  const direct = new WebSocket(servers.wsUrl, { rejectUnauthorized: false });
  t.after(() => direct.terminate()); await once(direct, 'open');
  const directMessages = []; direct.on('message', raw => directMessages.push(JSON.parse(raw)));
  direct.send(JSON.stringify({ type: 'hello', node_id: 'direct', room: 'mixed', password_hash: host.hash, endpoints: [], name: 'Direct' }));
  await until(() => directMessages.some(m => m.type === 'welcome'));
  const remote = new RelayClient({ url: host.url, room: host.room, fingerprint: host.fingerprint,
    nodeId: 'remote', role: 'viewer', hash: host.hash, key: host.key });
  t.after(() => remote.close());
  const remoteMessages = [], wire = [];
  remote.on('data', body => remoteMessages.push(body));
  remote.on('registered', () => {
    relay.rooms.get(host.room).peers.get(remote.nodeId).ws.on('message', raw => wire.push(raw.toString()));
    remote.send(host.nodeId, { type: 'hello', node_id: 'remote', name: 'Remote', room: 'mixed', password_hash: host.hash, endpoints: [] });
  });
  remote.start(); await until(() => remoteMessages.some(m => m.type === 'welcome'));
  assert.ok(remoteMessages[0].peers.some(p => p.node_id === 'direct'));
  await until(() => directMessages.some(m => m.type === 'user_joined' && m.node_id === 'remote'));
  direct.send(JSON.stringify({ type: 'offer', from: 'direct', to: 'remote', sdp: 'private-sdp' }));
  await until(() => remoteMessages.some(m => m.sdp === 'private-sdp'));
  remote.send(host.nodeId, { type: 'ice', from: 'remote', to: 'direct', candidate: 'private-ice' });
  await until(() => directMessages.some(m => m.candidate === 'private-ice'));
  assert.doesNotMatch(wire.join('\n'), /private-ice|private-sdp|strong-password|"mixed"/);
  remote.send(host.nodeId, { type: 'goodbye', node_id: 'remote' });
  await until(() => directMessages.some(m => m.type === 'user_left' && m.node_id === 'remote'));
  assert.equal(servers.room.peers.has('remote'), false);
});

test('IPC relay rejeita sender externo, destino fora do convite e identidade forjada', async () => {
  const handlers = new Map();
  installRelayIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    trusted: event => { if (!event.trusted) throw new Error('IPC não autorizado'); }, getWindow: () => null,
    getAccess: () => ({ room: 'local', endpoints: [] }), getSecret: () => null, getHostRelay: () => null });
  for (const name of ['relay-open', 'relay-close']) await assert.rejects(Promise.resolve().then(() => handlers.get(name)({}, {}, {})), /IPC não autorizado/);
  for (const name of ['relay-status', 'relay-send']) assert.throws(() => handlers.get(name)({}, '{}'), /IPC não autorizado/);
  await assert.rejects(handlers.get('relay-open')({ trusted: true }, { url: 'wss://evil.example.com' }, {}), /Relay não autorizado/);
  assert.throws(() => handlers.get('relay-send')({ trusted: true }, JSON.stringify({ from: 'spoofed' })), /Identidade inválida/);
});

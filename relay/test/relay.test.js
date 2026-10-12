const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const https = require('node:https');
const selfsigned = require('selfsigned');
const WebSocket = require('ws');
const { startRelay } = require('../server');
const { RelayClient, relayKey, roomToken, seal, open } = require('../../src/main/relay-client');
const { X509Certificate } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let certificate;
async function fixture(t, options = {}) {
  certificate ||= selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1 });
  const tls = await certificate;
  const logs = [];
  const relay = await startRelay({ key: tls.private, cert: tls.cert, host: '127.0.0.1', port: 0, log: line => logs.push(line), ...options });
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); await relay.close(); });
  async function connect(id, hash = 'a'.repeat(64), room = 'private-room', role = 'viewer') {
    const ws = new WebSocket(`wss://127.0.0.1:${relay.port}`, { rejectUnauthorized: false });
    clients.push(ws); await once(ws, 'open');
    const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
    const result = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'register', room, node_id: id, password_hash: hash, role }));
    const [raw] = await result;
    return { ws, messages, registration: JSON.parse(raw) };
  }
  return { relay, logs, connect, tls };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Timeout esperando evento');
}
test('registro, hash inválido, presença, goodbye e destruição da última sala', async t => {
  const { relay, connect, logs } = await fixture(t);
  const a = await connect('private-full-node-a', undefined, undefined, 'host');
  assert.equal(a.registration.type, 'registered');
  const bad = await connect('bad-peer', 'b'.repeat(64));
  assert.deepEqual(bad.registration, { type: 'register_rejected', reason: 'invalid_password' });
  assert.equal((await once(bad.ws, 'close'))[0], 4001);
  const b = await connect('private-full-node-b');
  await until(() => a.messages.some(m => m.type === 'user_joined'));
  b.ws.send(JSON.stringify({ type: 'goodbye', from: 'private-full-node-b' }));
  await until(() => a.messages.some(m => m.type === 'user_left'));
  assert.equal(a.messages.filter(m => m.type === 'user_left').length, 1);
  a.ws.close(); await until(() => relay.rooms.size === 0);
  assert.doesNotMatch(logs.join('\n'), /private-room|private-full-node|127\.0\.0\.1|aaaaaaaa/);
});
test('roteia envelope opaco na sala, descarta from forjado, destino ausente e outra sala', async t => {
  const { connect } = await fixture(t);
  const a = await connect('a'), b = await connect('b'), c = await connect('c', undefined, 'other');
  const offer = { type: 'offer', from: 'a', to: 'b', payload: 'opaque-ciphertext' };
  a.ws.send(JSON.stringify(offer)); await until(() => b.messages.some(m => m.type === 'offer'));
  assert.deepEqual(b.messages.find(m => m.type === 'offer'), offer);
  a.ws.send(JSON.stringify({ ...offer, from: 'forged' }));
  a.ws.send(JSON.stringify({ ...offer, to: 'c' }));
  a.ws.send(JSON.stringify({ ...offer, type: 'unsupported' }));
  await delay(30);
  assert.equal(b.messages.filter(m => m.type === 'offer').length, 1);
  assert.equal(c.messages.filter(m => m.type === 'offer').length, 0);
});
test('101 mensagens por segundo fecham com 4029', async t => {
  const { connect } = await fixture(t);
  const { ws } = await connect('rate');
  const closed = once(ws, 'close');
  for (let i = 0; i < 101; i++) ws.send(JSON.stringify({ type: 'ice', from: 'rate', to: 'missing' }));
  assert.equal((await closed)[0], 4029);
});
test('limites de sala/IP e peers, identidade duplicada e tamanho máximo', async t => {
  const { connect } = await fixture(t, { maxRoomsPerIp: 1, maxPeersPerRoom: 2 });
  await connect('a'); await connect('b');
  for (const [id, room] of [['c', 'private-room'], ['a', 'private-room'], ['d', 'other']]) {
    const result = await connect(id, undefined, room);
    assert.equal(result.registration.type, 'register_rejected');
  }
});
test('health conta salas/peers; mensagem acima de 256KiB fecha', async t => {
  const { relay, connect } = await fixture(t);
  const { ws } = await connect('large');
  const health = await new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${relay.port}/health`, { rejectUnauthorized: false }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(body) }));
    }).on('error', reject);
  });
  assert.equal(health.status, 'ok'); assert.equal(health.rooms, 1); assert.equal(health.peers, 1);
  const closed = once(ws, 'close'); ws.send('x'.repeat(262145)); assert.equal((await closed)[0], 1009);
});
test('heartbeat preserva peer com pong e termina peer sem pong', async t => {
  const { relay, connect } = await fixture(t, { idleMs: 20, pongMs: 20 });
  const { ws } = await connect('alive'); await delay(80); assert.equal(ws.readyState, 1);
  ws._autoPong = false;
  await once(ws, 'close'); await until(() => relay.rooms.size === 0);
});
test('TLS obrigatório e cifragem autenticada não usa hash como chave', async () => {
  await assert.rejects(startRelay(), /TLS obrigatório/);
  const key = relayKey('password-strong', 'room');
  const envelope = { type: 'offer', from: 'a', to: 'b' };
  const sealed = seal(key, envelope, { sdp: 'private-SDP', candidate: 'private-ICE', room: 'secret-room' });
  assert.doesNotMatch(JSON.stringify(sealed), /private-SDP|private-ICE|secret-room/);
  assert.equal(open(key, sealed).sdp, 'private-SDP');
  assert.throws(() => open(key, { ...sealed, to: 'c' }));
  assert.throws(() => open(Buffer.alloc(32), sealed));
  assert.notEqual(roomToken('room'), 'room');
});
test('pin errado não transmite registro; reconexão mantém identidade e payload cifrado', async t => {
  const { relay, tls } = await fixture(t);
  const url = `wss://127.0.0.1:${relay.port}`;
  const options = { url, room: roomToken('room'), key: relayKey('password', 'room'), hash: 'a'.repeat(64), role: 'viewer' };
  const wrong = new RelayClient({ ...options, fingerprint: '0'.repeat(64) });
  t.after(() => wrong.close()); wrong.start(); await delay(100);
  assert.equal(relay.rooms.size, 0); await wrong.close();
  const fingerprint = new X509Certificate(tls.cert).fingerprint256.replace(/:/g, '');
  const client = new RelayClient({ ...options, fingerprint, nodeId: 'stable-id' });
  t.after(() => client.close());
  const registered = once(client, 'registered'); client.start(); await registered;
  assert.ok(relay.rooms.get(options.room).peers.has('stable-id'));
  const again = once(client, 'registered'); client.ws.terminate(); await again;
  assert.ok(relay.rooms.get(options.room).peers.has('stable-id'));
});

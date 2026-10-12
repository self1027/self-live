const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../scripts/load-renderer-module');

function sockets(scenarios) {
  const created = [];
  const makeSocket = url => {
    const socket = { url, sent: [], close(code) { this.closed = code; }, send(data) { this.sent.push(JSON.parse(data)); } };
    created.push(socket);
    const scenario = scenarios[created.length - 1];
    queueMicrotask(() => scenario?.(socket));
    return socket;
  };
  return { created, makeSocket };
}
const welcome = socket => {
  socket.onopen(); socket.onmessage({ data: JSON.stringify({ type: 'welcome', peers: [], streams: [] }) });
};
const endpoints = [
  { type: 'ipv4-manual', url: 'wss://191.10.20.30:4000', priority: 3 },
  { type: 'ipv6', url: 'wss://[2607:f8b0:4000::1]:4000', priority: 1 }
];

test('sinalização tenta por prioridade e preserva eventos imediatamente após welcome', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  const { created, makeSocket } = sockets([
    socket => socket.onerror({}),
    socket => { welcome(socket); socket.onmessage({ data: JSON.stringify({ type: 'user_joined', node_id: 'late-peer' }) }); }
  ]);
  const logs = [], received = [];
  const result = await connectSignaling({ endpoints, makeSocket, log: line => logs.push(line),
    hello: { type: 'hello', password_hash: 'private-hash', node_id: 'viewer' } });
  assert.ok(created[0].url.includes('2607:f8b0'));
  assert.equal(created[0].closed, 1000);
  assert.equal(result.endpoint.priority, 3);
  assert.equal(result.welcome.type, 'welcome');
  assert.equal(created[1].sent[0].password_hash, 'private-hash');
  result.bind({ onMessage: event => received.push(JSON.parse(event.data)) });
  assert.equal(received[0].node_id, 'late-peer');
  assert.match(logs.join('\n'), /191\.10\.x\.x:4000/);
  assert.match(logs.join('\n'), /\[2607:f8b0:…\]:4000/);
  assert.doesNotMatch(logs.join('\n'), /191\.10\.20\.30|2607:f8b0:4000|private-hash/);
});

test('timeout inclui o handshake: socket aberto sem welcome tenta o próximo', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  const { created, makeSocket } = sockets([socket => socket.onopen(), welcome]);
  const logs = [];
  const result = await connectSignaling({ endpoints, makeSocket, timeoutMs: 15, hello: {}, log: line => logs.push(line) });
  assert.equal(created[0].closed, 1000);
  assert.equal(result.socket, created[1]);
  assert.match(logs.join('\n'), /timeout de conexão/);
});

test('senha rejeitada interrompe tentativas sem repetir credenciais nos endpoints', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  const { created, makeSocket } = sockets([socket => socket.onclose({ code: 1008, reason: 'private-server-detail' }), welcome]);
  const logs = [];
  await assert.rejects(connectSignaling({ endpoints, makeSocket, hello: {}, log: line => logs.push(line) }), { name: 'AuthenticationError' });
  assert.equal(created.length, 1);
  assert.doesNotMatch(logs.join('\n'), /private-server-detail/);
});

test('cancelar a entrada fecha socket pendente e não inicia próximo endereço', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  const controller = new AbortController();
  const { created, makeSocket } = sockets([() => controller.abort(), welcome]);
  await assert.rejects(connectSignaling({ endpoints, makeSocket, signal: controller.signal, hello: {}, log() {} }), { name: 'AbortError' });
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, 1000);
});

test('nenhum endpoint acessível informa diagnóstico; URLs com credenciais não são abertas', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  const { created, makeSocket } = sockets([socket => socket.onerror({})]);
  await assert.rejects(connectSignaling({ endpoints: [{ type: 'configured', url: 'wss://secret:credential@example.test:4000', priority: 1 }, endpoints[0]],
    makeSocket, log() {} }), { name: 'ConnectivityError' });
  assert.equal(created.length, 1);
});

test('endereço de diagnóstico mascara também IPv4 literal normalizado pela URL', async () => {
  const { maskedEndpoint } = await loadRenderer('signaling.js');
  assert.equal(maskedEndpoint('wss://191.10.20.30:4000'), '191.10.x.x:4000');
  assert.equal(maskedEndpoint('wss://example.test'), 'example.test:443');
  assert.equal(maskedEndpoint('wss://[2607:f8b0:4000::1]:4000'), '[2607:f8b0:…]:4000');
  assert.equal(maskedEndpoint('broken'), 'endereço inválido');
});

test('close após welcome fica guardado até instalar os handlers do dashboard', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  const { makeSocket } = sockets([socket => { welcome(socket); socket.onclose({ code: 1000 }); }]);
  const result = await connectSignaling({ endpoints: [endpoints[0]], makeSocket, hello: {}, log() {} });
  const closed = [];
  result.bind({ onClose: event => closed.push(event.code) });
  assert.deepEqual(closed, [1000]);
});

test('entrada já cancelada não abre socket nem agenda outra tentativa', async () => {
  const { connectSignaling } = await loadRenderer('signaling.js');
  const controller = new AbortController(); controller.abort();
  const { created, makeSocket } = sockets([welcome]);
  await assert.rejects(connectSignaling({ endpoints, makeSocket, signal: controller.signal, log() {} }), { name: 'AbortError' });
  assert.equal(created.length, 0);
});

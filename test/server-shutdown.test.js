const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { startServers } = require('../src/main/server');
const { passwordHash } = require('../src/shared/crypto');

function nextMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Timeout de evento')); }, 2000);
    function receive(raw) {
      const message = JSON.parse(raw);
      if (predicate(message)) { clearTimeout(timer); socket.off('message', receive); resolve(message); }
    }
    socket.on('message', receive);
  });
}
async function join(url, nodeId) {
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  await once(socket, 'open');
  const welcome = nextMessage(socket, m => m.type === 'welcome');
  socket.send(JSON.stringify({ type: 'hello', room: 'teste', password_hash: passwordHash('senha', 'teste'), node_id: nodeId, endpoints: [] }));
  await welcome; return socket;
}

test('goodbye remove presença antes de close 1000 e não duplica user_left', async t => {
  const servers = await startServers('teste', passwordHash('senha', 'teste'));
  t.after(() => servers.close());
  const a = await join(servers.wsUrl, 'a'), b = await join(servers.wsUrl, 'b');
  const events = [];
  a.on('message', raw => events.push(JSON.parse(raw)));
  const left = nextMessage(a, m => m.type === 'user_left' && m.node_id === 'b');
  const closed = once(b, 'close');
  b.send(JSON.stringify({ type: 'goodbye', node_id: 'b' }));
  await left;
  assert.equal(servers.room.peers.has('b'), false);
  assert.equal((await closed)[0], 1000);
  await servers.close();
  assert.equal(events.filter(m => m.type === 'user_left' && m.node_id === 'b').length, 1);
});

test('WSS aceita IPv4 e IPv6 na mesma porta e fecha clients normalmente', async t => {
  const servers = await startServers('teste', passwordHash('senha', 'teste'));
  t.after(() => servers.close());
  const a = await join(servers.wsUrl, 'ipv4');
  const peers = [a];
  if (servers.bindings.includes('::')) {
    peers.push(await join(`wss://[::1]:${servers.wsPort}`, 'ipv6'));
  }
  const closes = peers.map(peer => once(peer, 'close'));
  await servers.close();
  assert.ok((await Promise.all(closes)).every(([code]) => code === 1000));
  assert.equal(servers.room.peers.size, 0);
});

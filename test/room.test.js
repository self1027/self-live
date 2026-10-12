const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { startServers } = require('../src/main/server');
const { passwordHash } = require('../src/shared/crypto');

function nextMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Timeout de evento da sala')); }, 3000);
    function receive(raw) {
      const message = JSON.parse(raw);
      if (predicate(message)) { clearTimeout(timer); socket.off('message', receive); resolve(message); }
    }
    socket.on('message', receive);
  });
}

const metadata = (node, id) => ({ type: 'stream_started', node_id: node, stream_id: id,
  codec: 'h264', res: '1920x1080', fps: 60, bitrate: 10000000 });

test('presença sem eco, snapshot de stream ativo, stop independente e limpeza ao sair', async t => {
  const servers = await startServers('sala', passwordHash('senha', 'sala'));
  t.after(() => servers.close());
  async function join(id) {
    const socket = new WebSocket(servers.wsUrl, { rejectUnauthorized: false });
    socket.messages = [];
    socket.on('message', raw => socket.messages.push(JSON.parse(raw)));
    await once(socket, 'open');
    const welcome = nextMessage(socket, m => m.type === 'welcome');
    socket.send(JSON.stringify({ type: 'hello', room: 'sala', password_hash: passwordHash('senha', 'sala'), node_id: id, name: id, endpoints: [] }));
    return { socket, welcome: await welcome };
  }
  const { socket: a } = await join('a');
  const joinedB = nextMessage(a, m => m.type === 'user_joined' && m.node_id === 'b');
  const { socket: b } = await join('b'); await joinedB;
  const startedB = nextMessage(a, m => m.type === 'stream_started' && m.node_id === 'b');
  b.send(JSON.stringify(metadata('b', 'b-1'))); await startedB;
  const { socket: c, welcome } = await join('c');
  assert.equal(welcome.peers.length, 3);
  assert.equal(welcome.peers.find(p => p.node_id === 'b').streaming, true);
  assert.deepEqual(welcome.streams, [metadata('b', 'b-1')]);
  assert.equal(c.messages.some(m => m.type === 'user_joined' && m.node_id === 'c'), false);
  assert.equal(b.messages.some(m => m.type === 'user_joined' && m.node_id === 'b'), false);

  const startedA = nextMessage(c, m => m.type === 'stream_started' && m.node_id === 'a');
  a.send(JSON.stringify(metadata('a', 'a-1'))); await startedA;
  const stopped = nextMessage(c, m => m.type === 'stream_stopped' && m.node_id === 'b');
  b.send(JSON.stringify({ type: 'stream_stopped', node_id: 'b', stream_id: 'b-1' })); await stopped;
  assert.equal(servers.room.streams.has('b'), false);
  assert.equal(servers.room.streams.has('a'), true, 'Parar B não remove A');

  const restarted = nextMessage(c, m => m.type === 'stream_started' && m.stream_id === 'b-2');
  b.send(JSON.stringify(metadata('b', 'b-2'))); await restarted;
  b.send(JSON.stringify({ type: 'stream_stopped', node_id: 'b', stream_id: 'b-1' }));
  // Uma mensagem relay subsequente serve de barreira para o stop anterior.
  const barrier = nextMessage(c, m => m.type === 'watch_request');
  b.send(JSON.stringify({ type: 'watch_request', from: 'b', to: 'c' })); await barrier;
  assert.equal(servers.room.streams.get('b').stream_id, 'b-2');

  const streamRemoved = nextMessage(c, m => m.type === 'stream_stopped' && m.stream_id === 'b-2');
  const userRemoved = nextMessage(a, m => m.type === 'user_left' && m.node_id === 'b');
  b.close(); await Promise.all([streamRemoved, userRemoved]);
  assert.equal(servers.room.peers.has('b'), false);
  assert.equal(servers.room.streams.has('b'), false);
  a.close(); c.close();
});

test('peer não pode anunciar ou parar stream de outro peer', async t => {
  const servers = await startServers('sala', passwordHash('senha', 'sala'));
  t.after(() => servers.close());
  const socket = new WebSocket(servers.wsUrl, { rejectUnauthorized: false });
  await once(socket, 'open');
  const welcome = nextMessage(socket, m => m.type === 'welcome');
  socket.send(JSON.stringify({ type: 'hello', room: 'sala', password_hash: passwordHash('senha', 'sala'), node_id: 'impostor', endpoints: [] }));
  await welcome;
  const closed = once(socket, 'close');
  socket.send(JSON.stringify(metadata('outro-peer', 'fake-stream')));
  assert.equal((await closed)[0], 1008);
  assert.equal(servers.room.streams.size, 0);
});

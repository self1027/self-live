const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { startServers } = require('../src/main/server');
const { passwordHash } = require('../src/shared/crypto');

function waitMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Timeout da sinalização')); }, 3000);
    function receive(raw) {
      const message = JSON.parse(raw);
      if (predicate(message)) { clearTimeout(timer); socket.off('message', receive); resolve(message); }
    }
    socket.on('message', receive);
  });
}

test('relay autenticado de watch/SDP/ICE, destino ausente e proteção contra remetente falso', async t => {
  const servers = await startServers('p2p', passwordHash('senha', 'p2p'), { httpPort: 0, wsPort: 0 });
  t.after(() => servers.close());
  async function join(id) {
    const socket = new WebSocket(servers.wsUrl, { rejectUnauthorized: false });
    await once(socket, 'open');
    const welcome = waitMessage(socket, m => m.type === 'welcome');
    socket.send(JSON.stringify({ type: 'hello', room: 'p2p', password_hash: passwordHash('senha', 'p2p'), node_id: id, name: id, endpoints: [] }));
    await welcome;
    return socket;
  }
  const a = await join('a'), b = await join('b');
  for (const type of ['watch_request', 'offer', 'answer', 'ice', 'stop_watching', 'watch_rejected']) {
    const message = { type, from: 'a', to: 'b', session_id: 'call-1', sdp: 'opaque-sdp', candidate: { candidate: 'opaque-ice' } };
    const received = waitMessage(b, m => m.type === type);
    a.send(JSON.stringify(message));
    assert.deepEqual(await received, message);
  }
  const missing = waitMessage(a, m => m.type === 'error');
  a.send(JSON.stringify({ type: 'offer', from: 'a', to: 'absent', session_id: 'call-2' }));
  assert.equal((await missing).code, 'peer_not_found');
  const closed = once(a, 'close');
  a.send(JSON.stringify({ type: 'offer', from: 'b', to: 'a' }));
  assert.equal((await closed)[0], 1008);
  b.close(); await once(b, 'close');
});

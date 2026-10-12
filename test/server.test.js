const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { startServers } = require('../src/main/server');
const { passwordHash } = require('../src/shared/crypto');
const { once } = require('node:events');

test('dashboard, handshake WSS, presença e rejeição de senha incorreta', async t => {
  const servers = await startServers('teste', passwordHash('senha', 'teste'));
  t.after(() => servers.close());
  const page = await fetch(servers.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Self Live/);
  assert.equal((await fetch(servers.url + '/..%2fmain/main.js')).status, 404);
  const connect = async (id, password) => {
    // Exceção TLS limitada a este teste com certificado efêmero.
    const ws = new WebSocket(servers.wsUrl, { rejectUnauthorized: false });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', room: 'teste', node_id: id, password_hash: passwordHash(password, 'teste'), endpoints: [] }));
    return ws;
  };
  const a = await connect('a', 'senha');
  const [raw] = await once(a, 'message');
  assert.equal(JSON.parse(raw).type, 'welcome');
  const joined = new Promise(resolve => a.on('message', data => { const m = JSON.parse(data); if (m.type === 'user_joined' && m.node_id === 'b') resolve(m); }));
  const b = await connect('b', 'senha');
  await joined;
  const left = new Promise(resolve => a.on('message', data => { const m = JSON.parse(data); if (m.type === 'user_left') resolve(m); }));
  b.close(); assert.equal((await left).node_id, 'b');
  const invalid = await connect('invalid', 'errada');
  const [code] = await once(invalid, 'close'); assert.equal(code, 1008);
  a.close(); await once(a, 'close');
  // O close do cliente pode ocorrer antes do callback close no servidor.
  for (let attempt = 0; servers.room.peers.size && attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(servers.room.peers.size, 0);
});

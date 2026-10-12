const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../scripts/load-renderer-module');

test('ICE mantém STUN e pede credenciais efêmeras a cada nova conexão', async () => {
  const { buildIceServers } = await loadRenderer('ice.js');
  let requests = 0;
  const api = { generateTurnCredentials: async nodeId => {
    assert.equal(nodeId, 'peer1');
    return { username: `${++requests}:peer1`, credential: 'ephemeral', urls: 'turn:example.test:3478' };
  } };
  const first = await buildIceServers('peer1', api);
  const second = await buildIceServers('peer1', api);
  assert.equal(requests, 2);
  assert.equal(first[0].urls, 'stun:stun.l.google.com:19302');
  assert.equal(first[1].username, '1:peer1');
  assert.equal(second[1].username, '2:peer1');
  assert.deepEqual(Object.keys(first[1]).sort(), ['credential', 'urls', 'username']);
  assert.deepEqual(await buildIceServers('peer1', { generateTurnCredentials: async () => null }), [first[0]]);
});

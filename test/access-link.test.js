const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAccessEndpoints, encodeAccessLink, decodeAccessLink } = require('../src/main/access-link');

const fingerprint = Array(32).fill('aB').join(':');
const sample = () => ({
  node_id: 'peer-a', name: 'Peer A', room: 'sala-local', fingerprint,
  endpoints: [{ type: 'ipv4-local', url: 'wss://127.0.0.1:4000', priority: 4 },
    { type: 'ipv6', url: 'wss://[2606:4700::1234]:4000', priority: 1 }]
});
const rawLink = payload => `self-live://join?data=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

test('link transporta pin TLS e endpoints ordenados sem incluir senha ou segredo', () => {
  const decoded = decodeAccessLink(encodeAccessLink(sample()));
  assert.equal(decoded.fingerprint, fingerprint.toUpperCase());
  assert.deepEqual(decoded.endpoints.map(endpoint => endpoint.type), ['ipv6', 'ipv4-local']);
  assert.equal(decoded.node_id, 'peer-a');
  assert.equal(decoded.room, 'sala-local');
  assert.throws(() => encodeAccessLink({ ...sample(), password: 'sensitive' }), { code: 'ERR_ACCESS_LINK' });
  assert.throws(() => decodeAccessLink(rawLink({ ...sample(), secret: 'sensitive' })), { code: 'ERR_ACCESS_LINK' });
});

test('link rejeita endpoints com credenciais, caminho arbitrário ou tipo/escopo incoerente', () => {
  const invalid = [
    { type: 'ipv4-direct', url: 'ws://8.8.8.8:4000', priority: 2 },
    { type: 'ipv4-direct', url: 'wss://user:password@8.8.8.8:4000', priority: 2 },
    { type: 'ipv4-direct', url: 'wss://8.8.8.8:4000/hidden', priority: 2 },
    { type: 'ipv4-direct', url: 'wss://8.8.8.8:4000?secret=value', priority: 2 },
    { type: 'ipv4-direct', url: 'wss://127.0.0.1:4000', priority: 2 },
    { type: 'ipv4-local', url: 'wss://8.8.8.8:4000', priority: 4 },
    { type: 'ipv6', url: 'wss://[fe80::1]:4000', priority: 1 },
    { type: 'ipv6', url: 'wss://[2001:db8::1]:4000', priority: 1 },
    { type: 'ipv4-manual', url: 'wss://8.8.8.8:4000', priority: 1 },
    { type: 'ipv4-direct', url: 'wss://8.8.8.8:4000', priority: 2, credential: 'secret' },
    { type: 'ipv4-direct', url: 'wss://8.8.8.8:4000', priority: 2, method: 'invalid' }
  ];
  for (const endpoint of invalid) {
    assert.throws(() => decodeAccessLink(rawLink({ ...sample(), endpoints: [endpoint] })), { code: 'ERR_ACCESS_LINK' });
  }
});

test('link rejeita dados truncados, fingerprints inválidos, duplicatas e payload excessivo', () => {
  for (const link of ['self-live://join?data=!', 'self-live://elsewhere?data=e30',
    'https://join?data=e30', 'self-live://join?data=e30&data=e30', 'self-live://join/path?data=e30',
    'self-live://join?data=' + 'a'.repeat(18000)]) {
    assert.throws(() => decodeAccessLink(link), { code: 'ERR_ACCESS_LINK' });
  }
  const badPayloads = [{ ...sample(), fingerprint: 'ab:cd' }, { ...sample(), name: 'a\nb' },
    { ...sample(), node_id: '../arbitrary' }, { ...sample(), endpoints: [] },
    { ...sample(), endpoints: Array(17).fill(sample().endpoints[0]) },
    { ...sample(), endpoints: [sample().endpoints[0], sample().endpoints[0]] }];
  for (const payload of badPayloads) assert.throws(() => decodeAccessLink(rawLink(payload)), { code: 'ERR_ACCESS_LINK' });
});

test('lista publica IPv6 primeiro, porta TCP externa mapeada e fallback LAN/loopback', () => {
  const endpoints = [{ ip: '192.168.1.5', family: 'IPv4' }, { ip: '2606:4700::1234', family: 'IPv6' }];
  const result = buildAccessEndpoints({ endpoints, publicIp: '8.8.8.8', wsPort: 4000,
    mapping: { method: 'upnp', tcp: { externalPort: 4500, protocol: 'tcp' } },
    networkStatus: { status: 'public', ipv4Status: 'nat' }, bindings: ['::', '0.0.0.0'] });
  assert.deepEqual(result, [
    { type: 'ipv6', url: 'wss://[2606:4700::1234]:4000', priority: 1 },
    { type: 'ipv4-direct', url: 'wss://8.8.8.8:4500', priority: 2, method: 'upnp' },
    { type: 'ipv4-local', url: 'wss://192.168.1.5:4000', priority: 4 },
    { type: 'ipv4-local', url: 'wss://127.0.0.1:4000', priority: 4 }
  ]);
});

test('CGNAT não anuncia porta externa mesmo com UPnP; NAT desconhecido anuncia apenas candidato manual', () => {
  const options = { endpoints: [{ ip: '192.168.1.5' }], publicIp: '8.8.8.8', wsPort: 4000,
    mapping: { method: 'pcp', tcp: { externalPort: 4500 } } };
  const blocked = buildAccessEndpoints({ ...options, networkStatus: 'cgnat' });
  assert.deepEqual(blocked.map(endpoint => endpoint.type), ['ipv4-local', 'ipv4-local']);
  const unknown = buildAccessEndpoints({ ...options, networkStatus: 'unknown' });
  assert.deepEqual(unknown[0], { type: 'ipv4-manual', url: 'wss://8.8.8.8:4000', priority: 3, method: 'manual' });
  assert.equal(unknown.some(endpoint => endpoint.type === 'ipv4-direct'), false);
  const disabled = buildAccessEndpoints({ ...options, mapping: { status: 'disabled', tcp: null }, networkStatus: 'unknown' });
  assert.deepEqual(disabled[0], unknown[0]);
  const manual = buildAccessEndpoints({ endpoints: [{ ip: '192.168.1.5' }], publicIp: '8.8.8.8',
    wsPort: 4000, networkStatus: 'nat' });
  assert.deepEqual(manual[0], { type: 'ipv4-manual', url: 'wss://8.8.8.8:4000', priority: 3, method: 'manual' });
});

test('bind restrito não anuncia interfaces inacessíveis nem uma porta inválida', () => {
  const endpoints = [{ ip: '192.168.1.5' }, { ip: '2606:4700::1234' }, { ip: '8.8.8.8' }];
  const result = buildAccessEndpoints({ endpoints, publicIp: '8.8.8.8', wsPort: 4000,
    networkStatus: 'public', bindings: ['127.0.0.1'] });
  assert.deepEqual(result, [{ type: 'ipv4-local', url: 'wss://127.0.0.1:4000', priority: 4 }]);
  assert.deepEqual(buildAccessEndpoints({ endpoints, wsPort: 0 }), []);
  const direct = buildAccessEndpoints({ endpoints: [{ ip: '8.8.8.8' }], wsPort: 4000, bindings: ['8.8.8.8'] });
  assert.deepEqual(direct, [{ type: 'ipv4-direct', url: 'wss://8.8.8.8:4000', priority: 2 }]);
});

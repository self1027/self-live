const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getPreferredEndpoints, detectCgnat, detectDoubleNat, getObservedPublicIp } = require('../src/main/network');

test('ordena IPv6 global, IPv4 privado e IPv4 público e exclui escopos locais/reservados', () => {
  const address = (ip, internal = false) => ({ address: ip, internal });
  const endpoints = getPreferredEndpoints({
    Ethernet: [address('8.8.8.8'), address('192.168.1.5'), address('2606:4700::1234'), address('2606:4700::1234')],
    WiFi: [address('172.16.0.2'), address('10.1.1.2'), address('2001:4860:4860::8888')],
    ignored: ['::', '::1', 'fe80::1%Ethernet', 'fc00::1', 'fdff::1', 'ff02::1', '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001',
      '3fff::1', '3fff:fff:abcd::1', '2001:2::1',
      '::ffff:192.168.1.5', '127.0.0.1', '169.254.1.2', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']
      .map(ip => address(ip)),
    internal: [address('2606:4700::abcd', true)],
    empty: undefined
  });
  assert.deepEqual(endpoints, [
    { ip: '2606:4700::1234', family: 'IPv6', iface: 'Ethernet' },
    { ip: '2001:4860:4860::8888', family: 'IPv6', iface: 'WiFi' },
    { ip: '192.168.1.5', family: 'IPv4', iface: 'Ethernet' },
    { ip: '172.16.0.2', family: 'IPv4', iface: 'WiFi' },
    { ip: '10.1.1.2', family: 'IPv4', iface: 'WiFi' },
    { ip: '8.8.8.8', family: 'IPv4', iface: 'Ethernet' }
  ]);
});

test('limites da faixa privada 172.16–31 e interfaces ausentes', () => {
  assert.deepEqual(getPreferredEndpoints({}), []);
  const endpoints = getPreferredEndpoints({ eth: ['172.15.0.1', '172.16.0.1', '172.31.0.1', '172.32.0.1'].map(address => ({ address })) });
  assert.deepEqual(endpoints.map(e => e.ip), ['172.16.0.1', '172.31.0.1', '172.15.0.1', '172.32.0.1']);
});

test('detecção de NAT compara saída IPv4 com endpoints e retorna apenas estado', async () => {
  const endpoints = [{ ip: '192.168.1.5', family: 'IPv4', iface: 'Ethernet' }];
  let requested;
  const fetchImpl = async (url, options) => {
    requested = { url, options };
    return { ok: true, text: async () => '8.8.8.8\n' };
  };
  assert.deepEqual(await detectCgnat({ endpoints, fetchImpl }), { status: 'nat' });
  assert.equal(requested.url, 'https://api.ipify.org');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(requested.options.signal.aborted, true);
  assert.deepEqual(await detectCgnat({ endpoints: [...endpoints, { ip: '8.8.8.8', family: 'IPv4', iface: 'WAN' }], fetchImpl }), { status: 'direct' });
  // Ter IPv6 global não torna a consulta IPv4 uma prova de CGNAT ou falha IPv6.
  assert.deepEqual(await detectCgnat({ endpoints: [{ ip: '2606:4700::1', family: 'IPv6', iface: 'Ethernet' }], fetchImpl }), { status: 'nat' });
});

test('consulta indisponível ou resposta não pública fica informativa e não rejeita', async () => {
  const endpoints = [];
  const responses = ['invalid', '::1', '192.168.1.2', '100.64.0.1', '127.0.0.1', '203.0.113.1'];
  for (const ip of responses) {
    assert.deepEqual(await detectCgnat({ endpoints, fetchImpl: async () => ({ ok: true, text: async () => ip }) }), { status: 'unknown' });
  }
  assert.deepEqual(await detectCgnat({ endpoints, fetchImpl: async () => ({ ok: false }) }), { status: 'unknown' });
  assert.deepEqual(await detectCgnat({ endpoints, fetchImpl: async () => { throw new Error('offline'); } }), { status: 'unknown' });
  assert.deepEqual(await detectCgnat({ endpoints, fetchImpl: null }), { status: 'unknown' });
});

test('timeout limita tanto fetch pendurado quanto leitura da resposta', async () => {
  let signal;
  assert.deepEqual(await detectCgnat({ endpoints: [], timeoutMs: 20, fetchImpl: (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), { status: 'unknown' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(await detectCgnat({ endpoints: [], timeoutMs: 20, fetchImpl: async () => ({
    ok: true, text: () => new Promise(() => {})
  }) }), { status: 'unknown' });
});

test('NAT simples reutiliza a consulta pública e compara com WAN sem segunda HTTP', async () => {
  const endpoints = [{ ip: '192.168.1.5', family: 'IPv4', iface: 'Ethernet' }];
  let queries = 0;
  const fetchImpl = async () => {
    queries++;
    return { ok: true, text: async () => '8.8.8.8' };
  };
  assert.deepEqual(await detectCgnat({ endpoints, fetchImpl }), { status: 'nat' });
  assert.deepEqual(await detectDoubleNat({ endpoints, publicIp: getObservedPublicIp(),
    getWanAddress: async () => '8.8.8.8' }), { status: 'nat', ipv4Status: 'nat' });
  assert.equal(queries, 1);
});

test('consulta padrão reutiliza o cache no mesmo boot e mantém IP no main', async () => {
  const previousFetch = globalThis.fetch;
  let queries = 0;
  globalThis.fetch = async () => {
    queries++;
    return { ok: true, text: async () => '9.9.9.9' };
  };
  try {
    assert.deepEqual(await detectCgnat({ endpoints: [] }), { status: 'nat' });
    assert.deepEqual(await detectCgnat({ endpoints: [{ ip: '9.9.9.9' }] }), { status: 'direct' });
    assert.deepEqual(await detectDoubleNat({ endpoints: [{ ip: '192.168.1.5' }],
      getWanAddress: async () => '9.9.9.9' }), { status: 'nat', ipv4Status: 'nat' });
    assert.equal(queries, 1);
    assert.equal(getObservedPublicIp(), '9.9.9.9');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('WAN privada/CGNAT diferente da saída distingue NAT a montante de NAT simples', async () => {
  const endpoints = [{ ip: '192.168.1.5', family: 'IPv4', iface: 'Ethernet' }];
  for (const wan of ['100.64.1.10', '10.2.1.1', '9.9.9.9']) {
    assert.deepEqual(await detectDoubleNat({ endpoints, publicIpPromise: Promise.resolve('8.8.8.8'),
      getWanAddress: async () => wan }), { status: 'cgnat', ipv4Status: 'cgnat' });
  }
  // IP público na própria interface não depende de um roteador descoberta.
  assert.deepEqual(await detectDoubleNat({ endpoints: [{ ip: '8.8.8.8' }], publicIp: '8.8.8.8' }),
    { status: 'public', ipv4Status: 'public' });
});

test('IPv6 global preserva rota pública e registra separadamente CGNAT do IPv4', async () => {
  const endpoints = [{ ip: '2606:4700::1234' }, { ip: '192.168.1.5' }];
  assert.deepEqual(await detectDoubleNat({ endpoints, publicIp: '8.8.8.8',
    getWanAddress: async () => '100.64.1.10' }), { status: 'public', ipv4Status: 'cgnat' });
  assert.deepEqual(await detectDoubleNat({ endpoints, publicIp: null }),
    { status: 'public', ipv4Status: 'unknown' });
});

test('WAN ausente ou inválida não afirma CGNAT e timeout não bloqueia diagnóstico', async () => {
  const endpoints = [{ ip: '192.168.1.5' }];
  for (const wan of [null, 'invalid', '::1', '0.0.0.0', '127.0.0.1', '224.0.0.1', '169.254.1.2']) {
    assert.deepEqual(await detectDoubleNat({ endpoints, publicIp: '8.8.8.8',
      getWanAddress: async () => wan }), { status: 'unknown', ipv4Status: 'unknown' });
  }
  assert.deepEqual(await detectDoubleNat({ endpoints, publicIp: '8.8.8.8',
    getWanAddress: async () => { throw new Error('offline'); } }), { status: 'unknown', ipv4Status: 'unknown' });
  assert.deepEqual(await detectDoubleNat({ endpoints, publicIp: '8.8.8.8', timeoutMs: 20,
    getWanAddress: () => new Promise(() => {}) }), { status: 'unknown', ipv4Status: 'unknown' });
  assert.deepEqual(await detectDoubleNat({ endpoints, timeoutMs: 20,
    getPublicIp: () => new Promise(() => {}) }), { status: 'unknown', ipv4Status: 'unknown' });
});

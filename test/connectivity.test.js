const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { detectDoubleNat } = require('../src/main/network');
const { buildAccessEndpoints } = require('../src/main/access-link');

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// Executa a orquestração de produção, substituindo somente as operações que
// consultariam a Internet/roteador. Classificação e construção de URLs são reais.
function loadConnectivity({ publicIp = '8.8.8.8', wanIp = publicIp, wanReady } = {}) {
  const mapReady = deferred();
  const calls = { open: [], close: 0, wan: 0, nat: [], doubleNat: [], endpoints: [], factories: [] };
  let state, emit;
  const dependencies = {
    './portmapper': { createPortMapper(options) {
      calls.factories.push(options); emit = options.onUpdate;
      state = { tcp: null, udp: null, method: null, status: options.mode === 'off' ? 'disabled' : 'checking' };
      return {
        getStatus: () => structuredClone(state),
        openPorts(args) {
          calls.open.push(args);
          return mapReady.promise.then(result => {
            state = result ? { ...result, status: 'mapped' } : { tcp: null, udp: null, method: null, status: 'unavailable' };
            emit(); return result;
          }, error => {
            state = { tcp: null, udp: null, method: null, status: 'unavailable' };
            emit(); throw error;
          });
        },
        getWanAddress() { calls.wan++; return wanReady?.promise || Promise.resolve(wanIp); },
        async closePorts() {
          calls.close++; state = { tcp: null, udp: null, method: null, status: 'disabled' }; emit();
        }
      };
    } },
    './network': {
      async detectCgnat(args) { calls.nat.push(args); return { status: publicIp ? 'nat' : 'unknown' }; },
      getObservedPublicIp: () => publicIp,
      detectDoubleNat(args) { calls.doubleNat.push(args); return detectDoubleNat(args); }
    },
    './access-link': { buildAccessEndpoints(args) { calls.endpoints.push(args); return buildAccessEndpoints(args); } }
  };
  const context = { module: { exports: {} }, process: { env: {} }, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Dependência sem mock: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/connectivity.js'), 'utf8'), context,
    { filename: 'src/main/connectivity.js' });
  return { ...context.module.exports, calls, mapReady,
    updateMapping: next => { state = structuredClone(next); emit(); } };
}

function instance(module, overrides = {}) {
  const updates = [];
  const connectivity = module.createConnectivity({
    servers: { wsPort: 4000, bindings: ['::', '0.0.0.0'] },
    endpoints: [{ ip: '192.168.1.5', family: 'IPv4', iface: 'Ethernet' }],
    udpPorts: [50000, 50001], mode: 'on', ttl: 7200,
    onUpdate: snapshot => updates.push(structuredClone(snapshot)), ...overrides
  });
  return { connectivity, updates };
}
const mapped = { tcp: { externalPort: 4000, protocol: 'tcp' },
  udp: { externalPort: 50000, protocol: 'udp', ports: [{ internalPort: 50000, externalPort: 50000 }, { internalPort: 50001, externalPort: 50001 }] },
  method: 'upnp' };

test('boot publica snapshot imediatamente e mantém captura/UI independentes da descoberta do roteador', async () => {
  const module = loadConnectivity();
  const { connectivity, updates } = instance(module);
  const operation = connectivity.start();
  assert.equal(typeof operation.then, 'function');
  assert.equal(connectivity.start(), operation, 'Iniciar duas vezes reutiliza a operação');
  assert.equal(module.calls.open.length, 1);
  assert.equal(updates.length, 1, 'O primeiro snapshot não aguarda UPnP');
  assert.equal(updates[0].portMapping.status, 'checking');
  assert.equal(updates[0].network.status, 'unknown');
  assert.deepEqual(updates[0].udpPorts, [50000, 50001]);
  assert.equal(updates[0].wsPort, 4000);
  assert.deepEqual(await connectivity.natStatus(), { status: 'nat' }, 'Consulta pública pode terminar enquanto portas aguardam');
  assert.equal(module.calls.doubleNat.length, 0, 'WAN só é consultada após a tentativa de mapeamento');
  module.mapReady.resolve(mapped); await operation;
  assert.equal(updates.at(-1).network.status, 'nat');
  assert.equal(updates.at(-1).portMapping.status, 'mapped');
  assert.equal(module.calls.wan, 1);
  assert.equal(module.calls.nat.length, 1, 'A observação do IP público é reutilizada');
  assert.equal(module.calls.doubleNat[0].publicIp, '8.8.8.8');
  assert.equal(module.calls.doubleNat[0].timeoutMs, 8000);
  assert.doesNotMatch(JSON.stringify(updates), /8\.8\.8\.8/, 'IPC informa estados sem expor o IP observado');
});

test('link usa o mapeamento atual; perda de lease publica estado e remove o endpoint automático', async () => {
  const module = loadConnectivity();
  const { connectivity, updates } = instance(module);
  const operation = connectivity.start(); module.mapReady.resolve(mapped); await operation;
  const endpoints = connectivity.endpoints();
  assert.ok(endpoints.some(endpoint => endpoint.type === 'ipv4-direct' && endpoint.url === 'wss://8.8.8.8:4000' && endpoint.method === 'upnp'));
  assert.equal(module.calls.endpoints.at(-1).mapping.tcp.externalPort, 4000);
  assert.equal(module.calls.endpoints.at(-1).networkStatus.ipv4Status, 'nat');
  assert.deepEqual(structuredClone(module.calls.open[0]), { tcpPort: 4000, udpPort: 50000, udpPorts: [50000, 50001], ttl: 7200 });
  const count = updates.length;
  module.updateMapping({ tcp: null, udp: null, method: null, status: 'unavailable', reason: 'timeout' });
  assert.equal(updates.length, count + 1, 'Atualizações do mapper continuam chegando ao renderer');
  assert.equal(updates.at(-1).portMapping.status, 'unavailable');
  assert.equal(updates.at(-1).portMapping.reason, 'timeout');
  assert.ok(connectivity.endpoints().some(endpoint => endpoint.type === 'ipv4-manual'));
  assert.ok(connectivity.endpoints().every(endpoint => endpoint.type !== 'ipv4-direct'));
});

test('CGNAT detectado após mapear não anuncia a WAN como endpoint público alcançável', async () => {
  const module = loadConnectivity({ wanIp: '100.64.1.10' });
  const { connectivity, updates } = instance(module);
  const operation = connectivity.start(); module.mapReady.resolve(mapped); await operation;
  assert.equal(updates.at(-1).network.status, 'cgnat');
  assert.equal(updates.at(-1).network.ipv4Status, 'cgnat');
  assert.equal(updates.at(-1).portMapping.status, 'mapped', 'Sucesso no roteador doméstico não prova acesso pela operadora');
  assert.ok(connectivity.endpoints().every(endpoint => endpoint.type === 'ipv4-local'));
});

test('off e bind somente localhost não mapeiam portas nem consultam a WAN', async () => {
  for (const overrides of [{ mode: 'off' }, { servers: { wsPort: 4000, bindings: ['127.0.0.1', '::1'] } }]) {
    const module = loadConnectivity();
    const { connectivity, updates } = instance(module, overrides);
    await connectivity.start();
    assert.equal(module.calls.factories[0].mode, 'off');
    assert.equal(module.calls.open.length, 0);
    assert.equal(module.calls.wan, 0);
    assert.equal(module.calls.doubleNat[0].getWanAddress, undefined);
    assert.equal(updates.at(-1).portMapping.status, 'disabled');
    assert.equal(updates.at(-1).network.status, 'unknown');
    await connectivity.closePorts();
    assert.equal(module.calls.close, 1);
  }
});

test('falha de mapeamento mantém diagnóstico sem rejeitar a operação de boot', async () => {
  const module = loadConnectivity();
  const { connectivity, updates } = instance(module);
  const operation = connectivity.start(); module.mapReady.reject(new Error('Roteador indisponível'));
  await operation;
  assert.equal(updates.at(-1).portMapping.status, 'unavailable');
  assert.equal(updates.at(-1).network.status, 'nat');
  assert.ok(connectivity.endpoints().some(endpoint => endpoint.type === 'ipv4-manual'));
});

test('closePorts durante descoberta impede novas publicações e a consulta WAN posterior', async () => {
  const module = loadConnectivity();
  const { connectivity, updates } = instance(module);
  const operation = connectivity.start();
  const count = updates.length;
  await connectivity.closePorts();
  assert.equal(module.calls.close, 1);
  module.mapReady.resolve(mapped); await operation;
  assert.equal(updates.length, count, 'Resultados tardios não enviam IPC após shutdown');
  assert.equal(module.calls.doubleNat.length, 0);
  assert.equal(module.calls.wan, 0);
  assert.equal(connectivity.start(), operation, 'Shutdown não reinicia a descoberta');
});

test('closePorts também bloqueia IPC quando a comparação WAN já está em andamento', async () => {
  const wanReady = deferred();
  const module = loadConnectivity({ wanReady });
  const { connectivity, updates } = instance(module);
  const operation = connectivity.start(); module.mapReady.resolve(mapped);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(module.calls.wan, 1);
  await connectivity.closePorts();
  const count = updates.length;
  wanReady.resolve('8.8.8.8'); await operation;
  assert.equal(updates.length, count);
});

test('configuração aceita on/off/auto e TTL dentro dos limites; rejeita valores ambíguos', () => {
  const { readPortMappingConfig } = loadConnectivity();
  assert.deepEqual(structuredClone(readPortMappingConfig({})), { mode: 'on', ttl: 7200 });
  for (const mode of ['on', 'off', 'auto']) {
    for (const ttl of ['1200', '7200', '86400']) {
      assert.deepEqual(structuredClone(readPortMappingConfig({ SELF_LIVE_UPNP: mode, SELF_LIVE_UPNP_TTL: ttl })), { mode, ttl: Number(ttl) });
    }
  }
  for (const mode of ['ON', 'disabled', ' auto ']) assert.throws(() => readPortMappingConfig({ SELF_LIVE_UPNP: mode }), /SELF_LIVE_UPNP/);
  for (const ttl of ['1199', '86401', '-1', '1200.5', 'abc', 'Infinity']) {
    assert.throws(() => readPortMappingConfig({ SELF_LIVE_UPNP_TTL: ttl }), /SELF_LIVE_UPNP_TTL/);
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPortMapper, upnpAdapter, pmpFactory } = require('../src/main/portmapper');
const { buildMapRequest, parseMapResponse, createPcpGateway } = require('../src/main/pcp');

const route = { gateway: '192.168.1.1', address: '192.168.1.50' };
const error = code => Object.assign(new Error(code), { code });

function fixture(method = 'pcp', options = {}) {
  const calls = [];
  const intervals = [];
  const cleared = [];
  const logs = [];
  const statuses = [];
  const gateways = {};
  const dependencies = {
    getRoute: async () => route,
    setInterval(callback, ms) { const interval = { callback, ms }; intervals.push(interval); return interval; },
    clearInterval(interval) { cleared.push(interval); },
    attemptTimeoutMs: 40, cleanupTimeoutMs: 30
  };
  for (const candidate of ['pcp', 'pmp', 'upnp']) {
    gateways[candidate] = {
      async map(port, address, opts) {
        calls.push({ action: 'map', method: candidate, port, address, ...opts });
        if (candidate !== method) throw error('UNSUPPORTED');
        if (options.failPort === port || options.failRenew && calls.filter(call => call.action === 'map' && call.method === candidate).length > 2) throw error('PORT_CONFLICT');
        if (options.hangMap) return new Promise(() => {});
        return { externalPort: options.externalPort || port, externalHost: '8.8.8.8', internalPort: port,
          internalHost: address, lifetime: options.lifetime };
      },
      async unmap(port, opts) { calls.push({ action: 'unmap', method: candidate, port, ...opts }); },
      async externalIp() { calls.push({ action: 'externalIp', method: candidate }); return '100.64.0.1'; },
      async stop() { calls.push({ action: 'stop', method: candidate }); }
    };
    dependencies[`${candidate}Gateway`] = async () => { calls.push({ action: 'discover', method: candidate }); return gateways[candidate]; };
  }
  const mapper = createPortMapper({ dependencies, mode: options.mode || 'on',
    log: { info: message => logs.push(message), warn: message => logs.push(message) }, onUpdate: status => statuses.push(status) });
  return { mapper, calls, intervals, cleared, logs, statuses, gateways, dependencies };
}

for (const [method, expected] of [['pcp', 'pcp'], ['pmp', 'nat-pmp'], ['upnp', 'upnp']]) {
  test(`mapeia TCP/UDP com fallback até ${expected}, sem autoRefresh paralelo`, async () => {
    const f = fixture(method);
    const mapped = await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 });
    assert.deepEqual(mapped, { tcp: { externalPort: 4000, protocol: 'tcp' },
      udp: { externalPort: 5000, protocol: 'udp', ports: [{ internalPort: 5000, externalPort: 5000, protocol: 'udp' }] }, method: expected });
    const successful = f.calls.filter(call => call.action === 'map' && call.method === method);
    assert.deepEqual(successful.map(call => [call.port, call.protocol, call.externalPort, call.ttl]), [
      [4000, 'tcp', 4000, 7200], [5000, 'udp', 5000, 7200]
    ]);
    assert.ok(successful.every(call => call.autoRefresh === false && call.address === route.address));
    assert.equal(f.mapper.getStatus().status, 'mapped');
    assert.equal(f.intervals[0].ms, 6600_000);
    assert.equal(f.statuses.at(-1).status, 'mapped');
    assert.ok(!JSON.stringify(f.statuses).includes('8.8.8.8'));
    assert.ok(!JSON.stringify(f.logs).includes('8.8.8.8'));
    await f.mapper.closePorts();
    const deleted = f.calls.filter(call => call.action === 'unmap' && call.method === method);
    assert.deepEqual(deleted.map(call => [call.port, call.protocol]), [[4000, 'tcp'], [5000, 'udp']]);
    assert.equal(f.mapper.getStatus().status, 'disabled');
    assert.equal(f.cleared[0], f.intervals[0]);
  });
}

test('todos os protocolos indisponíveis retornam null e motivo fixo', async () => {
  const f = fixture('none');
  assert.equal(await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 }), null);
  assert.deepEqual(f.calls.filter(call => call.action === 'discover').map(call => call.method), ['pcp', 'pmp', 'upnp']);
  assert.equal(f.mapper.getStatus().status, 'unavailable');
  assert.equal(f.mapper.getStatus().reason, 'unsupported');
  assert.equal(f.intervals.length, 0);
  assert.match(f.logs[0], /port forwarding manual ou use IPv6/);
  await f.mapper.closePorts();
});

test('mode off não descobre roteador e mode auto mantém falhas silenciosas', async () => {
  const off = fixture('pcp', { mode: 'off' });
  assert.equal(await off.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 }), null);
  assert.equal(await off.mapper.getWanAddress(), null);
  assert.equal(off.calls.length, 0);
  assert.equal(off.mapper.getStatus().status, 'disabled');
  const auto = fixture('none', { mode: 'auto' });
  assert.equal(await auto.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 }), null);
  assert.deepEqual(auto.logs, []);
  await off.mapper.closePorts();
  await auto.mapper.closePorts();
});

test('uma falha parcial remove os leases da tentativa antes do próximo protocolo', async () => {
  const f = fixture('pcp', { failPort: 5001 });
  assert.equal(await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000, udpPorts: [5000, 5001, 5002] }), null);
  const removed = f.calls.filter(call => call.action === 'unmap' && call.method === 'pcp');
  assert.deepEqual(removed.map(call => call.port), [4000, 5000, 5001]);
  const firstNext = f.calls.findIndex(call => call.action === 'discover' && call.method === 'pmp');
  assert.ok(f.calls.slice(0, firstNext).some(call => call.action === 'stop' && call.method === 'pcp'));
  assert.ok(!f.calls.some(call => call.action === 'map' && call.port === 5002));
  assert.equal(f.mapper.getStatus().reason, 'port_conflict');
  await f.mapper.closePorts();
});

test('recusa porta externa diferente e remove exatamente a externa recebida', async () => {
  const f = fixture('pcp', { externalPort: 4001 });
  assert.equal(await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 }), null);
  assert.ok(f.calls.some(call => call.action === 'unmap' && call.method === 'pcp' && call.externalPort === 4001));
  await f.mapper.closePorts();
});

test('renova toda a faixa UDP dez minutos antes do TTL e close cancela timer', async () => {
  const f = fixture();
  const ports = Array.from({ length: 16 }, (_, index) => 5000 + index);
  const mapped = await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000, udpPorts: ports, ttl: 1200 });
  assert.equal(mapped.udp.ports.length, 16);
  assert.equal(f.intervals[0].ms, 600_000);
  await f.intervals[0].callback();
  assert.equal(f.calls.filter(call => call.action === 'map').length, 34);
  await f.mapper.closePorts();
  await f.intervals[0].callback();
  assert.equal(f.calls.filter(call => call.action === 'map').length, 34);
  assert.equal(f.calls.filter(call => call.action === 'unmap').length, 17);
});

test('lease menor concedido pelo roteador renova antes da expiração real', async () => {
  const f = fixture('pcp', { lifetime: 300 });
  await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 });
  assert.equal(f.intervals[0].ms, 150_000);
  await f.mapper.closePorts();
});

test('falha de renovação limpa o estado e não mantém anúncio de portas expiradas', async () => {
  const f = fixture('pcp', { failRenew: true });
  await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 });
  await f.intervals[0].callback();
  assert.equal(f.mapper.getStatus().status, 'unavailable');
  assert.equal(f.mapper.getStatus().reason, 'port_conflict');
  assert.equal(f.mapper.getStatus().tcp, null);
  assert.equal(f.mapper.getStatus().udp, null);
  await f.mapper.closePorts();
});

test('timeout não bloqueia fallback nem encerramento, e TTL inválido não envia pedidos', async () => {
  const f = fixture('pcp', { hangMap: true });
  assert.equal(await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 }), null);
  assert.ok(f.calls.some(call => call.action === 'discover' && call.method === 'upnp'));
  await f.mapper.closePorts();
  const invalid = fixture();
  assert.equal(await invalid.mapper.openPorts({ tcpPort: 4000, udpPort: 5000, ttl: 600 }), null);
  assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.mapper.getStatus().reason, 'invalid_configuration');
  await invalid.mapper.closePorts();
});

test('shutdown durante descoberta aborta operação e não cria novos protocolos', async () => {
  let finish;
  const f = fixture();
  f.dependencies.pcpGateway = async () => new Promise(resolve => { finish = resolve; });
  const mapper = createPortMapper({ dependencies: f.dependencies, log: { info() {}, warn() {} } });
  const opened = mapper.openPorts({ tcpPort: 4000, udpPort: 5000 });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await mapper.closePorts();
  finish(f.gateways.pcp);
  assert.equal(await opened, null);
  assert.ok(!f.calls.some(call => call.action === 'map'));
  assert.equal(mapper.getStatus().status, 'disabled');
});

test('WAN reutiliza resultado privado e descoberta somente leitura não mapeia', async () => {
  const f = fixture();
  assert.equal(await f.mapper.getWanAddress(), '100.64.0.1');
  assert.equal(await f.mapper.getWanAddress(), '100.64.0.1');
  assert.equal(f.calls.filter(call => call.action === 'externalIp').length, 1);
  assert.ok(!f.calls.some(call => call.action === 'map'));
  await f.mapper.closePorts();
});

test('SOAP remove somente a descrição/processo dono e informa protocolo exato', async () => {
  const calls = [];
  let entry = null;
  const device = {
    async run(service, action, args) {
      calls.push({ service, action, args: Object.fromEntries(args) });
      if (action === 'GetSpecificPortMappingEntry') {
        if (!entry) throw new Error('Code 714 - NoSuchEntryInArray');
        return { 'u:GetSpecificPortMappingEntryResponse': entry };
      }
      if (action === 'AddPortMapping') {
        const data = Object.fromEntries(args);
        entry = { NewInternalClient: data.NewInternalClient, NewInternalPort: data.NewInternalPort,
          NewPortMappingDescription: data.NewPortMappingDescription };
        return {};
      }
      if (action === 'DeletePortMapping') { entry = null; return {}; }
    }
  };
  const gateway = { getGateway: async () => device, externalIp: async () => '8.8.8.8', stop: async () => {} };
  const adapter = upnpAdapter(gateway, 'Self Live test nonce');
  entry = { NewInternalClient: '192.168.1.99', NewInternalPort: 5000, NewPortMappingDescription: 'other app' };
  await assert.rejects(adapter.map(5000, route.address, { protocol: 'udp', ttl: 7200 }), { code: 'PORT_CONFLICT' });
  await adapter.unmap(5000, { protocol: 'udp' });
  assert.ok(!calls.some(call => call.action === 'DeletePortMapping'));
  entry = null;
  await adapter.map(5000, route.address, { protocol: 'udp', ttl: 7200 });
  await adapter.unmap(5000, { protocol: 'udp' });
  const deleted = calls.find(call => call.action === 'DeletePortMapping');
  assert.equal(deleted.args.NewProtocol, 'UDP');
  assert.equal(deleted.args.NewExternalPort, 5000);
  assert.equal(calls.find(call => call.action === 'AddPortMapping').args.NewLeaseDuration, 7200);
  assert.equal(entry, null);
});

test('PCP wire valida nonce, opcode, protocolo e porta; solicita PREFER_FAILURE', async () => {
  const nonce = Buffer.alloc(12, 7);
  const request = buildMapRequest({ address: route.address, port: 5000, protocol: 'udp', ttl: 7200, nonce });
  assert.equal(request.length, 64);
  assert.equal(request[0], 2);
  assert.equal(request[1], 1);
  assert.equal(request[36], 17);
  assert.equal(request[60], 2);
  assert.equal(request.readUInt32BE(4), 7200);
  assert.deepEqual([...request.subarray(18, 24)], [255, 255, 192, 168, 1, 50]);
  assert.deepEqual([...request.subarray(44, 60)], [...Array(10).fill(0), 255, 255, 0, 0, 0, 0]);
  const response = Buffer.from(request.subarray(0, 60));
  response[1] = 0x81;
  response[54] = response[55] = 255;
  response.set([8, 8, 8, 8], 56);
  assert.deepEqual(parseMapResponse(response, request), { externalPort: 5000, externalHost: '8.8.8.8', lifetime: 7200 });
  response[24] = 8;
  assert.equal(parseMapResponse(response, request), null);
  response[3] = 11;
  assert.throws(() => parseMapResponse(response, request), { code: 'PCP_11' });
});

test('PCP mantém nonce ao renovar/deletar e ignora datagramas de outro servidor', async () => {
  const sent = [];
  let closed = 0;
  class Socket extends EventEmitter {
    bind(_port, _address, callback) { setImmediate(callback); }
    send(request, port, host, callback) {
      sent.push(Buffer.from(request));
      const response = Buffer.from(request.subarray(0, 60));
      response[1] = 0x81;
      response[54] = response[55] = 255;
      response.set([8, 8, 8, 8], 56);
      callback();
      this.emit('message', response, { address: '192.168.1.99', port });
      setImmediate(() => this.emit('message', response, { address: host, port }));
    }
    close() { closed++; }
  }
  const pcp = createPcpGateway({ ...route, createSocket: () => new Socket() });
  assert.equal((await pcp.map(5000, route.address, { protocol: 'udp', ttl: 7200 })).externalPort, 5000);
  await pcp.map(5000, route.address, { protocol: 'udp', ttl: 7200 });
  await pcp.unmap(5000, { protocol: 'udp' });
  assert.ok(sent[0].subarray(24, 36).equals(sent[1].subarray(24, 36)));
  assert.ok(sent[0].subarray(24, 36).equals(sent[2].subarray(24, 36)));
  assert.equal(sent[2].readUInt32BE(4), 0);
  assert.equal(sent[2].length, 60); // Deletion does not need optional PREFER_FAILURE.
  assert.equal(closed, 3);
  await pcp.stop();
});

test('PCP UNSUPP_OPTION tenta MAP sem opção uma vez e conserva nonce nas próximas operações', async () => {
  const sent = [];
  class Socket extends EventEmitter {
    bind(_port, _address, callback) { setImmediate(callback); }
    send(request, port, host, callback) {
      sent.push(Buffer.from(request));
      let response;
      if (request.length === 64) {
        response = Buffer.alloc(24);
        response[0] = 2;
        response[1] = 0x81;
        response[3] = 5; // UNSUPP_OPTION.
      } else {
        response = Buffer.from(request);
        response[1] = 0x81;
        response.set([8, 8, 8, 8], 56);
      }
      callback();
      setImmediate(() => this.emit('message', response, { address: host, port }));
    }
    close() {}
  }
  const pcp = createPcpGateway({ ...route, timeoutMs: 100, createSocket: () => new Socket() });
  assert.equal((await pcp.map(5000, route.address, { protocol: 'udp', ttl: 7200 })).externalPort, 5000);
  await pcp.map(5001, route.address, { protocol: 'udp', ttl: 7200 });
  await pcp.unmap(5000, { protocol: 'udp' });
  assert.deepEqual(sent.map(request => request.length), [64, 60, 60, 60]);
  assert.ok(sent[0].subarray(24, 36).equals(sent[1].subarray(24, 36)));
  assert.ok(sent[0].subarray(24, 36).equals(sent[3].subarray(24, 36)));
  assert.equal(sent[3].readUInt32BE(4), 0);
  await pcp.stop();
});

test('NAT-PMP upstream usa portas UDP efêmeras distintas por instância, sem contatar roteador', async () => {
  const gateways = [];
  try {
    for (let index = 0; index < 2; index++) {
      const gateway = await pmpFactory({ gateway: '127.0.0.1', address: '127.0.0.1' });
      gateways.push(gateway);
      if (!gateway.listening) await new Promise((resolve, reject) => {
        gateway.socket.once('listening', resolve);
        gateway.socket.once('error', reject);
      });
    }
    const first = gateways[0].socket.address().port;
    const second = gateways[1].socket.address().port;
    assert.notEqual(first, 5350);
    assert.notEqual(second, 5350);
    assert.notEqual(first, second);
    assert.ok(first > 0 && second > 0);
    assert.equal(gateways[0].queue.length, 0);
    assert.equal(gateways[1].queue.length, 0);
  } finally { await Promise.all(gateways.map(gateway => gateway.stop())); }
});

test('timeout de remoção registra aviso fixo e ainda encerra o gateway', async () => {
  const f = fixture();
  f.gateways.pcp.unmap = () => new Promise(() => {});
  await f.mapper.openPorts({ tcpPort: 4000, udpPort: 5000 });
  await f.mapper.closePorts();
  assert.ok(f.logs.some(message => /timeout ao remover leases/.test(message)));
  assert.ok(f.calls.some(call => call.action === 'stop' && call.method === 'pcp'));
  assert.equal(f.mapper.getStatus().status, 'disabled');
});

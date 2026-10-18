const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createPortMapper } = require('../src/main/portmapper');
const realNetwork = require('../src/main/network');

function fixture({ publicIp = '8.8.8.8', wanIp = publicIp, method = 'pcp', routeReady, env = {}, onUpdate } = {}) {
  const calls = [], updates = [], intervals = [];
  const network = { ...realNetwork,
    getPreferredEndpoints: () => [{ ip: '192.168.1.50', family: 'IPv4', iface: 'Ethernet' }],
    detectCgnat: async () => ({ status: publicIp ? 'nat' : 'unknown' }),
    getObservedPublicIp: () => publicIp
  };
  const deps = {
    getRoute: () => routeReady || Promise.resolve({ address: '192.168.1.50', gateway: '192.168.1.1' }),
    setInterval(callback) { intervals.push(callback); return { unref() {} }; }, clearInterval() {}
  };
  for (const protocol of ['pcp', 'pmp', 'upnp']) deps[`${protocol}Gateway`] = async () => ({
    async map(port, address, options) {
      calls.push({ action: 'map', method: protocol, port, address, protocol: options.protocol, ttl: options.ttl });
      if (protocol !== method) throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED' });
      return { externalPort: port, externalHost: wanIp, lifetime: 300 };
    },
    async unmap(port, options) { calls.push({ action: 'unmap', port, protocol: options.protocol }); },
    async externalIp() { return wanIp; }, async stop() {}
  });
  function load(file, dependencies) {
    const context = { module: { exports: {} }, process, require: name => dependencies[name] || require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    return context.module.exports;
  }
  const connectivity = load('src/main/connectivity.js', {
    './network': network, './access-link': require('../src/main/access-link'),
    './portmapper': { createPortMapper: options => createPortMapper({ ...options, dependencies: deps, log: { info() {}, warn() {} } }) }
  });
  const module = load('src/native-mvp/network.js', { '../main/network': network, '../main/connectivity': connectivity });
  const create = overrides => module.createNativeNetwork({
    servers: { wsPort: 4000, bindings: ['::', '0.0.0.0'] }, udpPorts: [50000, 50001], env,
    onUpdate(value) { updates.push(value); onUpdate?.(value); }, ...overrides
  });
  return { create, calls, updates, intervals };
}

const host = { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.50 50001 typ host generation 0 ufrag abc', sdpMLineIndex: 0, generation: 2 };

test('native network maps automatically and emits only sanitized status; listener failures cannot break startup', async () => {
  const f = fixture({ onUpdate() { throw new Error('UI unavailable'); } }), network = f.create();
  assert.equal(network.mappedIce(host), null);
  await network.start();
  assert.deepEqual(f.calls.filter(call => call.action === 'map').map(call => [call.port, call.protocol, call.ttl]),
    [[4000, 'tcp', 7200], [50000, 'udp', 7200], [50001, 'udp', 7200]]);
  assert.equal(network.snapshot().portMapping.status, 'mapped');
  assert.ok(network.endpoints().some(endpoint => endpoint.type === 'ipv4-direct' && endpoint.method === 'pcp'));
  assert.ok(f.updates.some(value => value.status === 'mapped' && value.method === 'pcp'));
  assert.ok(f.updates.every(value => value.type === 'port-mapping' && Object.keys(value).every(key => ['type', 'status', 'method', 'reason'].includes(key))));
  assert.doesNotMatch(JSON.stringify([f.updates, network.snapshot()]), /192\.168\.1\.50|8\.8\.8\.8|candidate|abc/);
  await network.closePorts();
  assert.deepEqual(f.calls.filter(call => call.action === 'unmap').map(call => call.port), [4000, 50000, 50001]);
});

test('off and loopback-only signaling create no router leases', async () => {
  for (const overrides of [{ env: { SELF_LIVE_UPNP: 'off' } }, { servers: { wsPort: 4000, bindings: ['127.0.0.1'] } }]) {
    const f = fixture(), network = f.create(overrides);
    await network.start();
    assert.equal(f.calls.length, 0);
    assert.equal(network.snapshot().portMapping.status, 'disabled');
    assert.equal(network.mappedIce(host), null);
    await network.closePorts();
  }
});

test('mapped ICE candidate corresponds to the real UDP socket and preserves ICE generation', async () => {
  const f = fixture(), network = f.create(); await network.start();
  const value = network.mappedIce(host);
  assert.equal(value.candidate, 'candidate:sl1 1 UDP 1694498815 8.8.8.8 50001 typ srflx raddr 192.168.1.50 rport 50001 generation 0 ufrag abc');
  assert.equal(value.sdpMLineIndex, 0); assert.equal(value.generation, 2);
  assert.equal(host.candidate.includes('srflx'), false, 'The native candidate remains unchanged');
  for (const candidate of [
    host.candidate.replace('192.168.1.50', '192.168.56.1'), host.candidate.replace('50001', '50002'),
    host.candidate.replace('UDP', 'TCP'), host.candidate.replace('typ host', 'typ relay'),
    host.candidate.replace('192.168.1.50', 'computer.local'), host.candidate.replace('192.168.1.50', '::1'),
    host.candidate.replace('2130706431', '-1'), `${host.candidate}\r\ninvalid`
  ]) assert.equal(network.mappedIce({ ...host, candidate }), null, 'Only genuine mapped native UDP host candidates qualify');
  assert.equal(network.mappedIce(null), null);
  await network.closePorts();
  assert.equal(network.mappedIce(host), null);
});

test('CGNAT and unknown external connectivity never generate mapped ICE', async () => {
  for (const options of [{ wanIp: '100.64.1.10' }, { wanIp: '9.9.9.9' }, { publicIp: null }, { wanIp: null }]) {
    const f = fixture(options), network = f.create(); await network.start();
    assert.equal(network.mappedIce(host), null);
    await network.closePorts();
  }
});

test('native networking inherits PCP to NAT-PMP to UPnP fallback', async () => {
  for (const [method, expected] of [['pmp', 'nat-pmp'], ['upnp', 'upnp']]) {
    const f = fixture({ method }), network = f.create(); await network.start();
    assert.equal(network.snapshot().portMapping.method, expected);
    assert.ok(network.mappedIce(host));
    await network.closePorts();
  }
});

test('cancel during discovery suppresses late status and cannot create mappings', async () => {
  let resolveRoute;
  const routeReady = new Promise(resolve => { resolveRoute = resolve; });
  const f = fixture({ routeReady }), network = f.create();
  const started = network.start(), count = f.updates.length;
  await network.closePorts();
  resolveRoute({ address: '192.168.1.50', gateway: '192.168.1.1' }); await started;
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, count);
  assert.equal(network.mappedIce(host), null);
});

test('invalid UDP ranges are rejected before any router discovery', () => {
  const f = fixture();
  for (const udpPorts of [[], [0], [65536], [50000, 50002], [50000, 50000], [50000.5], Array.from({ length: 65 }, (_, index) => 50000 + index)]) {
    assert.throws(() => f.create({ udpPorts }), /UDP/);
  }
  assert.equal(f.calls.length, 0);
});

test('real native ICE validates its UDP range and binds host candidates inside it', {
  skip: process.platform !== 'win32' || process.env.SELF_LIVE_NATIVE_RANGE_TEST !== '1', timeout: 30000
}, async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { createInterface } = require('node:readline');
  const { NativeVideo } = require('../src/native-mvp/controller');
  const { selectMediaPorts } = require('../src/main/media-ports');
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-range-test-'));
  const fixture = spawn(path.resolve(__dirname, '../native/bin/native-mvp-test-window.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: fixture.stdout });
  t.after(() => { lines.close(); fixture.kill(); });
  const source = JSON.parse((await once(lines, 'line'))[0]);
  const native = new NativeVideo({ executable: path.resolve(__dirname, '../native/bin/native-video.exe'),
    runtime: path.resolve(__dirname, '../.native-deps/gstreamer'), registry: path.join(folder, 'registry.bin') });
  t.after(() => native.close());
  const available = await native.request('list');
  assert.ok(available.windows.some(window => window.id === source.window));
  await native.request('start', { window: source.window, fps: 30, height: 720, bitrateKbps: 4000 });
  for (const range of [{ udpMin: 50000 }, { udpMax: 50015 }, { udpMin: 0, udpMax: 10 },
    { udpMin: 50001, udpMax: 50000 }, { udpMin: 1, udpMax: 65536 }, { udpMin: 1.5, udpMax: 10 },
    { udpMin: '50000', udpMax: 50015 }, { udpMin: null, udpMax: 50015 }]) {
    await assert.rejects(native.request('connect', { generation: 1, ...range }), /UDP|numerico/);
  }
  const range = await selectMediaPorts();
  const candidates = [];
  let resolveCandidate;
  const gathered = new Promise(resolve => { resolveCandidate = resolve; });
  native.on('event', value => {
    if (value.type === 'ice' && value.generation === 2) {
      const parts = value.candidate.split(/\s+/);
      if (parts[2]?.toLowerCase() === 'udp' && parts[7] === 'host') {
        candidates.push(Number(parts[5])); resolveCandidate();
      }
    }
  });
  await native.request('connect', { generation: 2, udpMin: range.min, udpMax: range.max });
  let deadline;
  try { await Promise.race([gathered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Native host ICE candidate missing')), 10000); })]); }
  finally { clearTimeout(deadline); }
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(port => port >= range.min && port <= range.max), 'Every real native host UDP socket uses the configured mapped range');
  await native.request('disconnect');
  await native.request('connect', { generation: 3 });
  await native.request('disconnect');
});

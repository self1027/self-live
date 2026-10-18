const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { encodeAccessLink, decodeAccessLink } = require('../src/main/access-link');

// Executa main/turn de produção em um ambiente isolado. Só recursos Electron,
// rede e bandeja são simulados: o teste usa os handlers IPC realmente registrados.
async function boot(overrides = {}, options = {}) {
  const root = path.join(__dirname, '..');
  const handlers = new Map();
  const logs = [];
  const errors = [];
  const appEvents = new Map();
  const env = {
    SELF_LIVE_TURN_URL: 'turn:72.61.63.75:3478?transport=udp',
    SELF_LIVE_TURN_SECRET: 'abc', SELF_LIVE_TURN_TTL: '3600',
    SELF_LIVE_RELAY_URL: '',
    SELF_LIVE_ICE_TRANSPORT_POLICY: 'relay', ...overrides
  };
  const servers = {
    url: 'http://127.0.0.1:3000', wsUrl: 'wss://127.0.0.1:4000',
    fingerprint: options.fingerprint || Array(32).fill('AA').join(':'), wsPort: 4000,
    bindings: ['::', '0.0.0.0'], close: async () => {}
  };
  const endpoints = [
    { ip: '2606:4700::1', family: 'IPv6', iface: 'Ethernet' },
    { ip: '72.61.63.75', family: 'IPv4', iface: 'Ethernet' }
  ];
  let startup;
  let window;
  let envAtWindow;
  let quitCalls = 0;
  let certificateVerifier;
  let beforeRequest;
  let requestFilter;
  const session = {
    setCertificateVerifyProc(callback) { certificateVerifier = callback; },
    webRequest: { onBeforeRequest(filter, callback) { requestFilter = filter; beforeRequest = callback; } }
  };
  const mediaRange = { min: 50000, max: 50015, ports: Array.from({ length: 16 }, (_, index) => 50000 + index) };
  const connectionState = {
    network: { status: 'nat', ipv4Status: 'nat' },
    portMapping: { tcp: null, udp: null, method: null, status: 'disabled' },
    wsPort: 4000, udpPorts: mediaRange.ports, ipv6: true
  };
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: () => 'isolated-test-profile',
      whenReady: () => ({ then(callback) {
        const promise = Promise.resolve().then(callback);
        return { catch(handler) { startup = promise.catch(handler); return startup; } };
      } }),
      on: (name, callback) => appEvents.set(name, callback),
      quit: () => { quitCalls++; }
    },
    BrowserWindow: class {
      constructor(options) {
        envAtWindow = { ...env };
        this.options = options;
        this.webContents = {
          mainFrame: { url: servers.url + '/' },
          setWindowOpenHandler() {}, on() {}, send() {},
          setWebRTCUDPPortRange: range => { this.udpPortRange = range; }
        };
        window = this;
      }
      on() {}
      hide() {}
      show() {}
      focus() {}
      isDestroyed() { return false; }
      async loadURL(url) { this.webContents.mainFrame.url = url + '/'; }
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    session: { fromPartition: () => session },
    Menu: { setApplicationMenu() {} },
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }) }
  };
  const context = vm.createContext({
    URL, process: { env, pid: 4242 },
    Date: class extends Date { static now() { return 1700000000999; } },
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(level =>
      [level, (...args) => logs.push({ level, text: args.join(' ') })]))
  });
  function execute(relative, requireModule) {
    const filename = path.join(root, relative);
    const module = { exports: {} };
    const wrapper = vm.runInContext(`(function(require, module, exports, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`, context, { filename });
    wrapper(requireModule, module, module.exports, path.dirname(filename));
    return module.exports;
  }
  const turn = execute('src/main/turn.js', require);
  const modules = {
    './diagnostic-settings': { createDiagnosticSettings: () => ({ load:()=>({loggingEnabled:false,gpuPriorityEnabled:false,adaptiveQuality:true}), save:value=>value }) },
    './gpu-priority': { createGpuPriority: () => ({ setEnabled:async()=>({enabled:false,state:'disabled'}),
      snapshot:()=>({enabled:false,state:'disabled'}),refresh:async()=>{} }) },
    './capture-state': {createCaptureState:()=>({sample:async()=>({available:false})})},
    './media-audit': { createMediaAudit: () => ({ start:()=>({enabled:true}),sample() {},stop() {},setEnabled(){},pauseSampling(){},event(){},exportReport:()=>({samples:0}) }) },
    './share-preferences': { createSharePreferences: () => ({ load: () => ({}), save: value => value }) },
    electron,
    './server': { startServers: async () => servers },
    './capture': { setupCaptureHandlers: () => ({ sources: async () => [], select() {} }) },
    './tray': { createTray: () => ({ update() {}, destroy() {} }) },
    './shutdown': { createShutdown: () => async () => {} },
    './network': { getPreferredEndpoints: () => endpoints, detectCgnat: async () => ({ status: 'nat' }) },
    './connectivity': {
      readPortMappingConfig: () => ({ mode: 'off', ttl: 7200 }),
      createConnectivity: () => ({
        start: async () => {}, closePorts: async () => {},
        natStatus: async () => ({ status: 'nat' }), snapshot: () => connectionState,
        endpoints: () => [{ type: 'ipv4-local', url: servers.wsUrl, priority: 4 }]
      })
    },
    './access-link': { encodeAccessLink, decodeAccessLink },
    './media-ports': { selectMediaPorts: async () => mediaRange },
    './turn': turn,
    './application-audio': { createApplicationAudio: () => ({ stop() {}, start: async () => ({ enabled: false }) }) },
    './pilot-config': {
      applyPilotDefaults: require('../src/main/pilot-config').applyPilotDefaults,
      createPilotConfig: () => ({ snapshot: () => ({ name: 'Peer 4242', room: 'sala-local', relayUrl: '', upnp: 'off' }), password: () => 'self-live-local' })
    },
    './relay-client': require('../src/main/relay-client'),
    '../shared/crypto': require('../src/shared/crypto')
  };
  execute('src/main/main.js', name => {
    if (Object.hasOwn(modules, name)) return modules[name];
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Dependência não simulada: ${name}`);
  });
  await startup;
  assert.deepEqual(errors, []);
  assert.equal(quitCalls, 0);
  const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const verify = (hostname, data) => {
    let result;
    certificateVerifier({ hostname, certificate: { data } }, value => { result = value; });
    return result;
  };
  const allowRequest = url => {
    let result;
    beforeRequest({ url }, value => { result = value; });
    return !result.cancel;
  };
  return { handlers, trusted, window, env, envAtWindow, logs, appEvents,
    verify, allowRequest, requestFilter, mediaRange, servers };
}

test('main mantém segredo privado, limpa ambiente antes do renderer e entrega apenas credenciais efêmeras', async () => {
  const f = await boot();
  assert.equal(Object.hasOwn(f.envAtWindow, 'SELF_LIVE_TURN_SECRET'), false);
  assert.equal(Object.hasOwn(f.env, 'SELF_LIVE_TURN_SECRET'), false);
  assert.equal(f.window.options.webPreferences.contextIsolation, true);
  assert.equal(f.window.options.webPreferences.nodeIntegration, false);
  assert.equal(f.window.udpPortRange.min, f.mediaRange.min);
  assert.equal(f.window.udpPortRange.max, f.mediaRange.max);

  const config = f.handlers.get('config')(f.trusted);
  assert.equal(config.turnEnabled, true);
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(JSON.stringify(config).includes('abc'), false);
  assert.equal(Object.hasOwn(config, 'secret'), false);
  assert.equal(Object.hasOwn(config, 'credential'), false);
  assert.equal(Object.hasOwn(config, 'username'), false);

  const credentials = f.handlers.get('generate-turn-credentials')(f.trusted, 'peer1');
  assert.deepEqual(Object.keys(credentials).sort(), ['credential', 'urls', 'username']);
  assert.equal(credentials.username, '1700003600:peer1');
  assert.equal(credentials.credential, 'exhOMpobqfo424mU9fmvpgQQVoY=');
  assert.equal(credentials.urls, 'turn:72.61.63.75:3478?transport=udp');
  const networkStatus = await f.handlers.get('network-status')(f.trusted);
  assert.equal(networkStatus.status, 'nat');
  assert.deepEqual(Object.keys(networkStatus), ['status']);
  assert.equal(f.logs.some(({ text }) => /abc|72\.61\.63\.75|2606:4700::1|exhOMpobqfo424mU9fmvpgQQVoY=/.test(text)), false);
  assert.equal(f.logs.some(({ text }) => text.includes('TURN configurado: [IP oculto]:3478, TTL=3600s')), true);
});

test('handlers TURN/configuração rejeitam outro sender, subframe e origem alterada', async () => {
  const f = await boot();
  for (const name of ['config', 'generate-turn-credentials', 'network-status', 'connectivity',
    'generate-access-link', 'use-access-link', 'pilot-settings', 'pilot-password', 'pilot-save', 'pilot-restart',
    'application-audio-start', 'application-audio-stop', 'application-audio-sources',
    'diagnostic-settings', 'diagnostic-settings-save', 'diagnostic-sample', 'diagnostic-event', 'diagnostic-export',
    'gpu-priority-status', 'media-audit-start','capture-source-state','capture-recover','capture-confirm']) {
    const invoke = event => f.handlers.get(name)(event, 'peer1');
    await assert.rejects(async () => invoke({ ...f.trusted, sender: {} }), /IPC não autorizado/);
    await assert.rejects(async () => invoke({ ...f.trusted, senderFrame: { url: f.trusted.senderFrame.url } }), /IPC não autorizado/);
    const previousUrl = f.trusted.senderFrame.url;
    try {
      f.trusted.senderFrame.url = 'http://127.0.0.1:3000.evil.example/';
      await assert.rejects(async () => invoke(f.trusted), /IPC não autorizado/);
      f.trusted.senderFrame.url = 'https://example.com/';
      await assert.rejects(async () => invoke(f.trusted), /IPC não autorizado/);
    } finally {
      f.trusted.senderFrame.url = previousUrl;
    }
  }
  assert.throws(() => f.handlers.get('generate-turn-credentials')(f.trusted, 'peer:invalid'), /nodeId inválido/);
});

test('main sem segredo retorna TURN desabilitado e mantém política padrão all', async () => {
  const f = await boot({ SELF_LIVE_TURN_SECRET: undefined, SELF_LIVE_ICE_TRANSPORT_POLICY: undefined });
  const config = f.handlers.get('config')(f.trusted);
  assert.equal(config.turnEnabled, false);
  assert.equal(config.iceTransportPolicy, 'all');
  assert.equal(f.handlers.get('generate-turn-credentials')(f.trusted, 'peer1'), null);
  assert.equal(f.logs.some(({ text }) => text.includes('sem SELF_LIVE_TURN_SECRET')), true);
  assert.equal(f.logs.some(({ text }) => /72\.61\.63\.75|abc/.test(text)), false);
});

test('main aceita URL pública de relay forçada sem fingerprint e preserva WSS local', async () => {
  const url = 'wss://relay.murilod.dev:8443';
  const f = await boot({ SELF_LIVE_RELAY_URL: url, SELF_LIVE_SIGNAL_URL: url });
  const config = f.handlers.get('config')(f.trusted);
  assert.equal(config.signalEndpoints[0].type, 'relay');
  assert.equal(config.signalEndpoints[0].url, url);
  assert.equal(config.signalEndpoints[0].fingerprint, undefined);
  assert.equal(config.localWsUrl, f.servers.wsUrl);
  assert.equal(f.handlers.get('relay-status')(f.trusted).status, 'disabled');
  assert.equal(typeof f.handlers.get('hash')(f.trusted, 'password', config.room), 'string');
});

test('importar link permite somente seus endpoints e o pin remoto prevalece no mesmo hostname', async () => {
  const selfsigned = require('selfsigned');
  const [own, target] = await Promise.all([
    selfsigned.generate([{ name: 'commonName', value: 'self-live-own' }], { keySize: 2048, algorithm: 'sha256' }),
    selfsigned.generate([{ name: 'commonName', value: 'self-live-target' }], { keySize: 2048, algorithm: 'sha256' })
  ]);
  const ownFingerprint = new X509Certificate(own.cert).fingerprint256;
  const targetFingerprint = new X509Certificate(target.cert).fingerprint256;
  const f = await boot({}, { fingerprint: ownFingerprint });
  const endpoint = { type: 'ipv4-local', url: 'wss://127.0.0.1:4010', priority: 4 };
  const invitation = { node_id: 'target-peer', name: 'Target', room: 'target-room',
    fingerprint: targetFingerprint, endpoints: [endpoint] };
  const link = encodeAccessLink(invitation);

  assert.equal(f.allowRequest(f.servers.wsUrl), true);
  assert.equal(f.allowRequest(endpoint.url), false);
  assert.equal(f.verify('127.0.0.1', own.cert), 0);
  assert.equal(f.verify('127.0.0.1', target.cert), -2);
  assert.equal(f.verify('example.com', target.cert), -3);

  const imported = f.handlers.get('use-access-link')(f.trusted, link);
  assert.deepEqual(imported, invitation);
  assert.equal(f.allowRequest(endpoint.url), true);
  assert.equal(f.allowRequest('wss://127.0.0.1:4011'), false);
  assert.equal(f.allowRequest(endpoint.url + '/hidden'), false);
  assert.equal(f.allowRequest(endpoint.url + '?unexpected=value'), false);
  assert.equal(f.verify('127.0.0.1', target.cert), 0);
  assert.equal(f.verify('127.0.0.1', own.cert), -2);

  assert.equal(JSON.stringify(imported).includes('abc'), false);
  assert.equal(JSON.stringify(f.handlers.get('connectivity')(f.trusted)).includes('abc'), false);
  assert.deepEqual(decodeAccessLink(f.handlers.get('generate-access-link')(f.trusted, 'peer1')), invitation);
  assert.throws(() => f.handlers.get('hash')(f.trusted, 'room-password', 'sala-local'), /Entrada inválida/);
  assert.equal(typeof f.handlers.get('hash')(f.trusted, 'room-password', 'target-room'), 'string');

  f.handlers.get('use-access-link')(f.trusted, '');
  assert.equal(f.allowRequest(endpoint.url), false);
  assert.equal(f.verify('127.0.0.1', own.cert), 0);
  assert.equal(f.verify('127.0.0.1', target.cert), -2);
  assert.equal(typeof f.handlers.get('hash')(f.trusted, 'room-password', 'sala-local'), 'string');
  assert.equal(f.logs.some(({ text }) => /abc|room-password|exhOMpobqfo424mU9fmvpgQQVoY=/.test(text)), false);
});

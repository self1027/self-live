const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('preload mantém snapshots relay e signaling atualizados sem expor transporte/chave', async () => {
  const listeners = new Map();
  const page = { window: {} };
  const ctx = vm.createContext(page);
  const contextBridge = {
    exposeInMainWorld: (name, value) => { page.window[name] = value; },
    executeInMainWorld: ({ func }) => vm.runInContext(`(${func.toString()})()`, ctx)
  };
  const ipcRenderer = {
    on: (name, fn) => listeners.set(name, fn), removeListener() {}, send() {},
    invoke: async name => name === 'connectivity' ? { portMapping: {} } :
      name === 'relay-status' ? { status: 'online', url: 'wss://relay.murilod.dev:8443', reconnects: 0 } : null
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge, ipcRenderer }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  const api = page.window.selfLive;
  assert.equal(api.relay.status, 'online');
  assert.equal(api.relay.url, 'wss://relay.murilod.dev:8443');
  const event = value => listeners.get('relay-event')({}, value);
  event({ kind: 'status', value: { status: 'reconnecting', reconnects: 2, backoff: 4 } });
  event({ kind: 'host-status', value: { status: 'offline', reconnects: 9 } });
  assert.equal(api.relay.status, 'reconnecting');
  assert.equal(api.relay.reconnects, 2);
  assert.equal(api.relay.backoff, 4);
  assert.ok(Object.isFrozen(api.relay));
  assert.equal(api.relay.key, undefined);
  api.setSignaling('relay'); assert.equal(api.signaling, 'relay');
  api.setSignaling('direct'); assert.equal(api.signaling, 'direct');
  api.setSignaling('invalid'); assert.equal(api.signaling, 'direct');
  await api.relayClose(); assert.equal(api.relay.status, 'offline');
});

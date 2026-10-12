const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createShutdown } = require('../src/main/shutdown');
const fs = require('node:fs');
const path = require('node:path');

test('shutdown aguarda ACK correto antes dos servidores, é idempotente e sai com código 0', async () => {
  const ipcMain = new EventEmitter(), contents = new EventEmitter();
  contents.mainFrame = {}; contents.isDestroyed = () => false;
  const steps = [];
  contents.send = (_channel, token) => {
    steps.push('renderer');
    ipcMain.emit('shutdown-complete', { sender: new EventEmitter() }, token); // Outro renderer não libera saída.
    setImmediate(() => ipcMain.emit('shutdown-complete', { sender: contents, senderFrame: contents.mainFrame }, token));
  };
  const shutdown = createShutdown({ app: { exit: code => steps.push(`exit:${code}`) }, ipcMain,
    getWindow: () => ({ webContents: contents }), getServers: () => ({ close: async () => steps.push('servers') }),
    closePorts: async () => steps.push('ports'),
    getTray: () => ({ tray: { destroy: () => steps.push('tray') } }) });
  const operation = shutdown();
  assert.equal(shutdown(), operation);
  await operation;
  assert.deepEqual(steps, ['renderer', 'ports', 'servers', 'tray', 'exit:0']);
  assert.equal(ipcMain.listenerCount('shutdown-complete'), 0);
});

test('shutdown aguarda remoção de portas antes de fechar o WSS', async () => {
  const steps = [];
  let releasePorts;
  const portsFinished = new Promise(resolve => { releasePorts = resolve; });
  const shutdown = createShutdown({
    app: { exit: code => steps.push(`exit:${code}`) }, ipcMain: new EventEmitter(),
    getWindow: () => undefined, getServers: () => ({ close: async () => steps.push('servers') }),
    getTray: () => undefined, closePorts: async () => {
      steps.push('ports:start');
      await portsFinished;
      steps.push('ports:end');
    }
  });
  const operation = shutdown();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steps, ['ports:start']);
  releasePorts();
  await operation;
  assert.deepEqual(steps, ['ports:start', 'ports:end', 'servers', 'exit:0']);
});

test('falha ao remover portas não impede fechamento do WSS nem exit 0', async () => {
  const steps = [];
  const shutdown = createShutdown({
    app: { exit: code => steps.push(`exit:${code}`) }, ipcMain: new EventEmitter(),
    getWindow: () => undefined, getServers: () => ({ close: async () => steps.push('servers') }),
    getTray: () => undefined, closePorts: async () => { steps.push('ports'); throw new Error('Router offline'); }
  });
  await shutdown();
  assert.deepEqual(steps, ['ports', 'servers', 'exit:0']);
});

test('prazo padrão de três segundos também força saída com remoção de portas travada', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const steps = [];
  const shutdown = createShutdown({
    app: { exit: code => steps.push(`exit:${code}`) }, ipcMain: new EventEmitter(),
    getWindow: () => undefined, getServers: () => ({ close: async () => steps.push('servers') }),
    getTray: () => undefined, closePorts: async () => { steps.push('ports'); await new Promise(() => {}); }
  });
  const operation = shutdown();
  await Promise.resolve();
  t.mock.timers.tick(2999);
  assert.deepEqual(steps, ['ports']);
  t.mock.timers.tick(1);
  await operation;
  assert.deepEqual(steps, ['ports', 'exit:0']);
  t.mock.timers.tick(3000);
  assert.equal(steps.filter(step => step === 'exit:0').length, 1);
});

test('timeout força saída mesmo com servidor pendurado; falha de cleanup não bloqueia exit', async () => {
  let exits = 0;
  const shutdown = createShutdown({ app: { exit: code => { assert.equal(code, 0); exits++; } }, ipcMain: new EventEmitter(),
    getWindow: () => undefined, getServers: () => ({ close: () => new Promise(() => {}) }),
    getTray: () => ({ tray: { destroy: () => { throw new Error('Falha de teste'); } } }), timeoutMs: 50 });
  await shutdown();
  assert.equal(exits, 1);
});

test('renderer continua após falha e envia goodbye antes de close 1000', async () => {
  const { shutdownMedia } = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../src/renderer/shutdown.js')).toString('base64'));
  const steps = [], logs = [];
  const socket = new EventTarget();
  socket.readyState = 1;
  socket.send = data => steps.push(JSON.parse(data).type);
  socket.close = code => { steps.push(`close:${code}`); socket.readyState = 3; queueMicrotask(() => socket.dispatchEvent(new Event('close'))); };
  const track = { stop: () => steps.push('track') };
  const media = {
    stream: { getTracks: () => [track] }, outgoing: new Map(),
    stopStreaming: () => { throw new TypeError('Falha de teste'); },
    stopWatching: () => steps.push('stop_watching')
  };
  await shutdownMedia({ media, stream: media.stream, socket, nodeId: 'me', log: (...args) => logs.push(args) });
  assert.deepEqual(steps, ['stop_watching', 'track', 'goodbye', 'close:1000']);
  assert.ok(logs.some(([stage, error]) => stage === 'Parando transmissão' && error === 'TypeError'));
});

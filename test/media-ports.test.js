const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { selectMediaPorts, MEDIA_PORT_COUNT } = require('../src/main/media-ports');

async function reservePort(port) {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ port, address: '0.0.0.0', exclusive: true }, resolve);
    });
    return socket;
  } catch (error) {
    await release(socket);
    throw error;
  }
}
function release(socket) {
  return new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });
}

test('seleciona faixa contígua de 16 portas UDP e libera todos os sockets antes de retornar', async () => {
  const range = await selectMediaPorts();
  assert.equal(MEDIA_PORT_COUNT, 16);
  assert.ok(Number.isInteger(range.min) && range.min >= 1024);
  assert.equal(range.max, range.min + MEDIA_PORT_COUNT - 1);
  assert.ok(range.max <= 65535);
  assert.deepEqual(range.ports, Array.from({ length: MEDIA_PORT_COUNT }, (_, offset) => range.min + offset));
  const sockets = [];
  try {
    // Rebinding all ports proves that even the first ephemeral socket and the
    // remaining probes were closed before Chromium receives the selected range.
    for (const port of range.ports) sockets.push(await reservePort(port));
  } finally { await Promise.all(sockets.map(release)); }
});

test('respeita uma porta base configurada e rejeita intervalo que excede os limites', async () => {
  const free = await selectMediaPorts();
  const configured = await selectMediaPorts(free.min);
  assert.deepEqual(configured, free);
  for (const invalid of [0, -1, 1023, 65535, 5000.5, '5000', null]) {
    await assert.rejects(selectMediaPorts(invalid), /SELF_LIVE_MEDIA_PORT.*UDP/);
  }
});

test('conflito no meio da faixa falha claramente e libera probes anteriores', async () => {
  const range = await selectMediaPorts();
  const busy = await reservePort(range.min + 5);
  const probes = [];
  try {
    await assert.rejects(selectMediaPorts(range.min), /Faixa UDP configurada indisponível/);
    for (const port of range.ports.slice(0, 5)) probes.push(await reservePort(port));
    // The selector must not accidentally close another process's existing socket.
    assert.equal(busy.address().port, range.min + 5);
  } finally { await Promise.all([...probes, busy].map(release)); }
});

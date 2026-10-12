const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../scripts/load-renderer-module');
test('qualidade limita Full HD, preserva proporções e nunca amplia a fonte', async () => {
  const { captureSize } = await loadRenderer('capture-quality.js');
  assert.deepEqual(captureSize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(captureSize(1366, 768), { width: 1366, height: 768 });
  assert.deepEqual(captureSize(1920, 1080, '144'), { width: 256, height: 144 });
  assert.deepEqual(captureSize(640, 360, '1080'), { width: 640, height: 360 });
  assert.deepEqual(captureSize(2560, 1080), { width: 1920, height: 810 });
  assert.deepEqual(captureSize(1080, 1920), { width: 607, height: 1080 });
});
test('captura aplica resolução e fps antes do envio e libera tracks ao falhar', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
  let applied, stops = 0, fail = false;
  const video = { getSettings: () => ({ width: 1920, height: 1080 }), stop: () => stops++,
    applyConstraints: async constraints => { applied = constraints; if (fail) throw new Error('Não suportado'); } };
  const audio = { stop: () => stops++ };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async () => ({
    getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio]
  }) } } });
  const { captureSystemMedia } = await loadRenderer('webrtc.js');
  for (const fps of [15, 30, 60]) {
    await captureSystemMedia({ resolution: '480', fps });
    assert.equal(applied.height.max, 480); assert.equal(applied.frameRate.max, fps);
  }
  fail = true;
  await assert.rejects(captureSystemMedia({ resolution: '144', fps: 15 }), /Não suportado/);
  assert.equal(stops, 2);
});

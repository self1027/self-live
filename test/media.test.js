const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../scripts/load-renderer-module');
const loadMedia = () => loadRenderer('webrtc.js');

test('teste local captura com constraints de games e libera tracks se negociação falhar', async t => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  });
  let options, applied, stopped = 0, closed = 0;
  let dimensions = {width:3840,height:2160};
  const video = { kind: 'video', stop: () => stopped++, getSettings: () => dimensions, applyConstraints: async value => { applied = value; dimensions = {width:value.width.max,height:value.height.max}; } };
  const audio = { kind: 'audio', stop: () => stopped++ };
  const stream = { getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio] };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getDisplayMedia: async constraints => { options = constraints; return stream; } }
  } });
  const { startLocalLoopbackTest } = await loadMedia();
  const preview = { srcObject: null, play: async () => {} };
  await assert.rejects(startLocalLoopbackTest({
    preview, bitrate: 10000000,
    loopback: { start: async captured => { assert.equal(captured, stream); throw new Error('Codec indisponível'); }, stop: () => closed++ }
  }), /Codec indisponível/);
  assert.equal(applied.width.max, 1920);
  assert.equal(applied.height.max, 1080);
  assert.equal(options.video.frameRate.ideal, 60);
  assert.equal(options.audio, false, 'getDisplayMedia nunca captura a mistura do sistema');
  assert.equal(video.contentHint, 'motion');
  assert.equal(stopped, 2);
  assert.equal(closed, 1);
  assert.equal(preview.srcObject, null);
});

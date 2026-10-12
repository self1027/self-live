const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audioPolicy } = require('../src/main/application-audio');
test('áudio recusa chamadas, navegadores, próprio processo e aplicativos com várias janelas', () => {
  for (const executable of ['Discord.exe', 'DiscordPTB.exe', 'ms-teams.exe', 'Zoom.exe', 'Slack.exe', 'WhatsApp.exe', 'chrome.exe', 'firefox.exe', 'Self Live.exe']) {
    assert.ok(audioPolicy({ pid: 123, windows: 1, executable }, 456));
  }
  assert.ok(audioPolicy({ pid: 456, windows: 1, executable: 'game.exe' }, 456));
  assert.ok(audioPolicy({ pid: 123, windows: 2, executable: 'game.exe' }, 456));
  assert.ok(audioPolicy({ pid: 123, windows: 0, executable: 'game.exe' }, 456));
  assert.ok(audioPolicy({ pid: 123, windows: 1 }, 456));
  assert.ok(audioPolicy({ pid: 123, windows: 1, executable: 'C:\\game.exe' }, 456));
  assert.equal(audioPolicy({ pid: 123, windows: 1, executable: 'game.exe' }, 456), null);
});

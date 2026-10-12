const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharePreferences } = require('../src/main/share-preferences');
test('Preferências persistem entre instâncias sem senha, fonte ou identificadores transitórios', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'self-live-preferences-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createSharePreferences(directory);
  const value = { audioMode: 'on', applications: ['Call.exe'], manual: 'Other.exe', bitrate: '6000000', resolution: '720', fps: '30' };
  assert.equal(store.load().bitrate, '10000000');
  store.save({ ...value, password: 'secret', source: 'window:123' });
  assert.deepEqual(createSharePreferences(directory).load(), value);
  assert.ok(!fs.readFileSync(path.join(directory, 'share-preferences.json'), 'utf8').includes('secret'));
  assert.throws(() => store.save({ ...value, applications: ['../secret.exe'] }));
  assert.throws(() => store.save({ ...value, resolution: '2160' }));
  assert.throws(() => store.save({ ...value, fps: '120' }));
  assert.deepEqual(store.load(), value);
  fs.writeFileSync(path.join(directory, 'share-preferences.json'), '{broken');
  assert.equal(store.load().audioMode, 'on');
  assert.deepEqual(store.load().applications, ['Discord.exe']);
});
test('preferências anteriores migram sem perder áudio e bitrate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'self-live-preferences-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const old = { audioMode: 'none', applications: [], manual: '', bitrate: '6000000' };
  fs.writeFileSync(path.join(directory, 'share-preferences.json'), JSON.stringify(old));
  assert.deepEqual(createSharePreferences(directory).load(), { ...old, resolution: 'auto', fps: '60' });
  for (const mode of ['window', 'include', 'exclude']) {
    fs.writeFileSync(path.join(directory, 'share-preferences.json'), JSON.stringify({ ...old, audioMode:mode, applications:['Call.exe'], manual:'Other.exe' }));
    const migrated = createSharePreferences(directory).load();
    assert.equal(migrated.audioMode, 'on');
    assert.deepEqual(migrated.applications, mode === 'exclude' ? ['Discord.exe','Call.exe'] : ['Discord.exe']);
    assert.equal(migrated.manual, mode === 'exclude' ? 'Other.exe' : '');
  }
});

test('Discord desmarcado e Sem áudio sobrevivem ao reinício sem restaurar exclusão', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'self-live-preferences-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createSharePreferences(directory);
  for (const audioMode of ['on','none']) {
    store.save({audioMode,applications:[],manual:'',bitrate:'10000000'});
    assert.equal(createSharePreferences(directory).load().audioMode,audioMode);
    assert.deepEqual(createSharePreferences(directory).load().applications,[]);
  }
});

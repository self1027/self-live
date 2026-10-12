const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPilotConfig, applyPilotDefaults } = require('../src/main/pilot-config');
const storage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'self-live-pilot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('piloto gera sala/senha exclusivas, persiste e não grava senha em texto puro', t => {
  const directory = fixture(t);
  const first = createPilotConfig(directory, storage);
  const password = first.password();
  const second = createPilotConfig(directory, storage);
  assert.equal(second.password(), password);
  assert.deepEqual(second.snapshot(), first.snapshot());
  assert.ok(password.length >= 24);
  assert.ok(!fs.readFileSync(first.snapshot().file, 'utf8').includes(password));
  const other = createPilotConfig(fixture(t), storage);
  assert.notEqual(other.snapshot().room, first.snapshot().room);
  assert.notEqual(other.password(), password);
  assert.equal(first.snapshot().passwordEncrypted, undefined);
  assert.equal(first.snapshot().nameChosen, false);
});
test('nome escolhido persiste sem mudar sala ou senha; vazio e controles são rejeitados', t => {
  const directory = fixture(t), config = createPilotConfig(directory, storage);
  const room = config.snapshot().room, password = config.password();
  for (const value of ['', '   ', 'x'.repeat(129), 'Nome\nOutro']) assert.throws(() => config.saveName(value));
  assert.equal(config.snapshot().nameChosen, false);
  assert.equal(config.saveName('  Murilo  '), 'Murilo');
  const restored = createPilotConfig(directory, storage);
  assert.equal(restored.snapshot().name, 'Murilo'); assert.equal(restored.snapshot().nameChosen, true);
  assert.equal(restored.snapshot().room, room); assert.equal(restored.password(), password);
});
test('perfis antigos preservam nomes personalizados e pedem confirmação do nome padrão', t => {
  const directory = fixture(t), config = createPilotConfig(directory, storage);
  const raw = JSON.parse(fs.readFileSync(config.snapshot().file, 'utf8'));
  delete raw.nameChosen;
  for (const [name, chosen] of [['Meu PC', false], ['Meu apelido', true]]) {
    fs.writeFileSync(config.snapshot().file, JSON.stringify({ ...raw, name }));
    const restored = createPilotConfig(directory, storage);
    assert.equal(restored.snapshot().nameChosen, chosen);
    assert.equal(restored.snapshot().name, name);
  }
});
test('salvar mantém senha omitida, troca senha fornecida e preserva arquivo após erro', t => {
  const directory = fixture(t), config = createPilotConfig(directory, storage);
  const password = config.password();
  config.save({ ...config.snapshot(), name: 'PC A', relayUrl: '' });
  assert.equal(config.password(), password);
  config.save({ ...config.snapshot(), password: 'senha-nova-aleatoria' });
  assert.equal(createPilotConfig(directory, storage).password(), 'senha-nova-aleatoria');
  const before = fs.readFileSync(config.snapshot().file, 'utf8');
  for (const value of [{ password: 'fraca' }, { relayUrl: 'ws://host' }, { upnp: 'invalid' }, { room: '' }]) {
    assert.throws(() => config.save({ ...config.snapshot(), ...value }));
    assert.equal(fs.readFileSync(config.snapshot().file, 'utf8'), before);
  }
});
test('sem armazenamento seguro não grava senha; configuração corrompida não é substituída', t => {
  const directory = fixture(t);
  assert.throws(() => createPilotConfig(directory, { isEncryptionAvailable: () => false }));
  assert.ok(!fs.existsSync(path.join(directory, 'pilot-config.json')));
  fs.writeFileSync(path.join(directory, 'pilot-config.json'), '{invalid');
  assert.throws(() => createPilotConfig(directory, storage));
  assert.equal(fs.readFileSync(path.join(directory, 'pilot-config.json'), 'utf8'), '{invalid');
});
test('env explícita prevalece, vazio desativa relay, defaults não incluem segredo TURN', () => {
  const env = { SELF_LIVE_RELAY_URL: '', SELF_LIVE_NAME: 'Externo' };
  applyPilotDefaults(env, { name: 'Local', room: 'sala', relayUrl: 'wss://host', upnp: 'off' }, 'senha');
  assert.equal(env.SELF_LIVE_RELAY_URL, '');
  assert.equal(env.SELF_LIVE_NAME, 'Externo');
  assert.equal(env.SELF_LIVE_PASSWORD, 'senha');
  assert.equal(env.SELF_LIVE_TURN_SECRET, undefined);
});

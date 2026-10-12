const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readTurnConfig, generateTurnCredentials } = require('../src/main/turn');

function logger() {
  const messages = [];
  return { messages, info: text => messages.push(text), warn: text => messages.push(text) };
}

test('credenciais TURN seguem o vetor HMAC-SHA1, base64 e timestamp de expiração', () => {
  const config = { secret: 'abc', ttl: 3600, urls: 'turn:turn.example:3478?transport=udp' };
  const credentials = generateTurnCredentials(config, 'peer1', { now: () => 1700000000999 });
  assert.deepEqual(credentials, {
    username: '1700003600:peer1', credential: 'exhOMpobqfo424mU9fmvpgQQVoY=', urls: config.urls
  });
  assert.equal('secret' in credentials, false);
  const fresh = generateTurnCredentials(config, 'peer1', { now: () => 1700000300000 });
  assert.equal(fresh.username, '1700003900:peer1');
  assert.notEqual(fresh.credential, credentials.credential);
});

test('TURN ausente ou incompleto usa STUN-only e não loga segredos', () => {
  const log = logger();
  assert.equal(readTurnConfig({}, log), null);
  assert.equal(readTurnConfig({ SELF_LIVE_TURN_SECRET: 'abc' }, log), null);
  assert.equal(log.messages.length, 0);
  assert.equal(readTurnConfig({ SELF_LIVE_TURN_URL: 'turn:turn.example' }, log), null);
  assert.match(log.messages[0], /sem SELF_LIVE_TURN_SECRET/);
  assert.equal(generateTurnCredentials(null, 'peer1'), null);
});

test('configuração TURN valida URL e TTL e mascara IPs nos logs', () => {
  const secret = 'a'.repeat(64);
  const log = logger();
  const config = readTurnConfig({ SELF_LIVE_TURN_URL: 'turn:72.61.63.75:3478?transport=udp', SELF_LIVE_TURN_SECRET: secret }, log);
  assert.deepEqual(config, { urls: 'turn:72.61.63.75:3478?transport=udp', secret, ttl: 3600 });
  assert.match(log.messages[0], /\[IP oculto\]:3478, TTL=3600s/);
  assert.equal(log.messages.some(message => message.includes(secret) || message.includes('72.61.63.75')), false);

  const ipv6 = readTurnConfig({ SELF_LIVE_TURN_URL: 'turn:[2606:4700::1]:3478?transport=tcp', SELF_LIVE_TURN_SECRET: secret, SELF_LIVE_TURN_TTL: '120' }, log);
  assert.equal(ipv6.ttl, 120);
  assert.equal(log.messages.some(message => message.includes('2606:4700::1')), false);
  const tls = readTurnConfig({ SELF_LIVE_TURN_URL: 'turns:turn.example?transport=tcp', SELF_LIVE_TURN_SECRET: secret }, log);
  assert.equal(tls.urls, 'turns:turn.example?transport=tcp');
  assert.match(log.messages.at(-1), /turn.example:5349/);
});

test('valores inválidos não chegam ao Chromium nem aparecem nos diagnósticos', () => {
  const secret = 'private-shared-secret';
  const invalidUrls = [
    'https://turn.example', 'turn://turn.example', 'turn:user:password@turn.example:3478',
    'turn:turn.example:0', 'turn:turn.example:65536', 'turn:999.1.1.1:3478',
    'turn:turn.example?transport=invalid', 'turn:turn.example?transport=udp&secret=x',
    'turn:turn.example/path', 'turn:[not-ipv6]:3478', 'turns:turn.example?transport=udp'
  ];
  const log = logger();
  for (const url of invalidUrls) {
    assert.equal(readTurnConfig({ SELF_LIVE_TURN_URL: url, SELF_LIVE_TURN_SECRET: secret }, log), null);
  }
  for (const ttl of ['0', '59', '86401', '-1', '1.5', 'not-a-number']) {
    assert.equal(readTurnConfig({ SELF_LIVE_TURN_URL: 'turn:turn.example', SELF_LIVE_TURN_SECRET: secret, SELF_LIVE_TURN_TTL: ttl }, log), null);
  }
  assert.equal(log.messages.every(message => !message.includes(secret) && !message.includes('password') && !message.includes('999.1.1.1')), true);
});

test('nodeId rejeita separadores e tamanho excessivo sem repetir o valor no erro', () => {
  const config = { secret: 'abc', ttl: 3600, urls: 'turn:turn.example' };
  for (const nodeId of ['', 'peer:1', 'peer\n1', 'a'.repeat(129), null]) {
    assert.throws(() => generateTurnCredentials(config, nodeId), /nodeId inválido/);
  }
  assert.throws(() => generateTurnCredentials(config, 'peer1', { now: () => NaN }), /Relógio inválido/);
});

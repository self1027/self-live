const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/connection-stats.js'));
const load = import('data:text/javascript;base64,' + source.toString('base64'));
const report = (...entries) => new Map(entries.map(entry => [entry.id, entry]));
const candidates = (localType = 'host', remoteType = 'srflx') => [
  { id: 'local', type: 'local-candidate', candidateType: localType, address: '192.168.1.2' },
  { id: 'remote', type: 'remote-candidate', candidateType: remoteType, address: '192.168.1.3' }
];
const pair = extra => ({ id: 'pair', type: 'candidate-pair', state: 'succeeded',
  localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.02, ...extra });

test('Chromium: transport selecionado prevalece sobre par nominated antigo e não expõe endereços', async () => {
  const { getConnectionDiagnostics } = await load;
  const result = getConnectionDiagnostics(report(
    ...candidates('relay', 'host'),
    { id: 'old-local', type: 'local-candidate', candidateType: 'host', address: '192.168.1.4' },
    pair({ id: 'old-pair', localCandidateId: 'old-local', nominated: true }),
    pair({ currentRoundTripTime: 0.18 }),
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }
  ));
  assert.deepEqual(result, { mode: 'relay', family: 'IPv4', localType: 'relay', remoteType: 'host',
    rttMs: 180, quality: 'fair' });
  assert.ok(!JSON.stringify(result).includes('192.168.'));
});

test('selected legado e nominated são alternativas; par failed nunca é selecionado', async () => {
  const { getConnectionDiagnostics } = await load;
  const stats = report(...candidates(), pair({ selected: true }),
    pair({ id: 'failed', state: 'failed', currentRoundTripTime: 10, selected: true }),
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'failed' });
  assert.equal(getConnectionDiagnostics(stats).mode, 'direct');
  assert.equal(getConnectionDiagnostics(stats).rttMs, 20);
  stats.get('pair').selected = false;
  stats.get('pair').nominated = true;
  assert.equal(getConnectionDiagnostics(stats).mode, 'direct');
  stats.get('pair').nominated = false;
  assert.equal(getConnectionDiagnostics(stats).mode, 'unknown', 'Succeeded sozinho não significa selecionado');
});

test('relay em qualquer ponta e ausência de par direto succeeded geram diagnóstico sem causa inventada', async () => {
  const { getConnectionDiagnostics } = await load;
  for (const types of [['relay', 'host'], ['srflx', 'relay'], ['relay', 'relay']]) {
    const result = getConnectionDiagnostics(report(...candidates(...types), pair({ selected: true })));
    assert.equal(result.mode, 'relay');
    assert.equal(result.relayReason, 'Nenhum par direto bem-sucedido observado nas estatísticas');
    assert.ok(!/CGNAT|firewall/.test(result.relayReason));
  }
});

test('IPv6 reconhece address, ip legado e família explícita; mDNS mantém família desconhecida', async () => {
  const { getConnectionDiagnostics } = await load;
  for (const fields of [{ address: '2001:db8::1' }, { address: undefined, ip: '2001:db8::2' },
    { address: undefined, family: 'IPv6' }, { address: undefined, addressFamily: 6 }]) {
    const [local, remote] = candidates('prflx', 'host');
    Object.assign(remote, fields);
    assert.equal(getConnectionDiagnostics(report(local, remote, pair({ nominated: true }))).family, 'IPv6');
  }
  const [local, remote] = candidates();
  local.address = 'hidden-local.local'; remote.address = 'hidden-remote.local';
  const result = getConnectionDiagnostics(report(local, remote, pair({ nominated: true })));
  assert.equal(result.family, null);
  assert.equal(result.mode, 'direct');
});

test('RTT ausente, null, negativo, não finito ou textual não gera qualidade verde falsa', async () => {
  const { getConnectionDiagnostics } = await load;
  for (const currentRoundTripTime of [undefined, null, -1, NaN, Infinity, 1e308, '0.04']) {
    const result = getConnectionDiagnostics(report(...candidates(), pair({ selected: true, currentRoundTripTime })));
    assert.equal(result.rttMs, null);
    assert.equal(result.quality, 'unknown');
  }
});

test('qualidade respeita limites de 100 e 250 ms, incluindo RTT zero válido', async () => {
  const { getConnectionDiagnostics } = await load;
  for (const [seconds, quality] of [[0, 'good'], [0.099, 'good'], [0.1, 'fair'],
    [0.249, 'fair'], [0.25, 'poor'], [0.6, 'poor']]) {
    const result = getConnectionDiagnostics(report(...candidates(), pair({ selected: true, currentRoundTripTime: seconds })));
    assert.equal(result.rttMs, seconds * 1000);
    assert.equal(result.quality, quality);
  }
});

test('estatísticas incompletas não supõem conexão direta e suportam tipos legados no par', async () => {
  const { getConnectionDiagnostics } = await load;
  assert.deepEqual(getConnectionDiagnostics(new Map()), { mode: 'unknown', family: null,
    localType: null, remoteType: null, rttMs: null, quality: 'unknown' });
  assert.equal(getConnectionDiagnostics(report(pair({ selected: true }))).mode, 'unknown');
  assert.equal(getConnectionDiagnostics(report(pair({ selected: true,
    localCandidateType: 'host', remoteCandidateType: 'prflx' }))).mode, 'direct');
});

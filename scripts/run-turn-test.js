// Runner independente: testes unitários sempre; relay real somente com env TURN.
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

test('TURN: geração e validação de credenciais (unitários)', { timeout: 20000 }, async () => {
  const env = { ...process.env };
  // Os testes unitários usam segredos fictícios; nunca recebem o segredo real.
  for (const key of Object.keys(env)) {
    if (key.startsWith('SELF_LIVE_TURN_')) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, ['--test', 'test/turn.test.js'], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.resume();
  child.stderr.resume();
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout dos testes unitários TURN.')); }, 15000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Não foi possível iniciar os testes unitários TURN.')); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, 'Testes unitários TURN falharam; execute node --test test/turn.test.js para detalhes com fixtures fictícias.');
});

const configured = Boolean(process.env.SELF_LIVE_TURN_URL?.trim() && process.env.SELF_LIVE_TURN_SECRET?.trim());
test('TURN: dois peers locais negociam por relay e recebem dados', {
  skip: configured ? false : 'URL/segredo TURN ausentes; integração opcional.', timeout: 40000
}, async context => {
  const result = await new Promise((resolve, reject) => {
    let electron;
    try { electron = require('electron'); }
    catch { reject(new Error('Electron indisponível para o teste TURN.')); return; }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [path.join(__dirname, 'turn-integration-peer.js')], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    // O Chromium pode escrever IPs/URIs nos seus próprios diagnósticos. Nunca
    // encaminhamos stdout/stderr brutos; resultados chegam em um IPC restrito.
    child.stdout.resume();
    child.stderr.resume();
    let report;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('O processo Electron não concluiu o teste TURN no prazo.'));
    }, 30000);
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      // Copiamos apenas campos previstos, sem transportar logs/erros do browser.
      if (message.ok === true) report = { ok: true, localType: message.localType, remoteType: message.remoteType, peerCount: message.peerCount, received: message.received };
      else if (message.unavailable === true) report = { unavailable: true };
      else if (message.failed === true) report = { failed: true };
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Não foi possível iniciar Electron para o teste TURN.')); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!report || code !== 0) reject(new Error('Teste TURN terminou sem um resultado válido.'));
      else resolve(report);
    });
  });
  if (result.unavailable) {
    context.skip('TURN indisponível ou sem candidatos relay; integração opcional não executada.');
    return;
  }
  assert.equal(result.failed, undefined, 'Candidatos relay foram obtidos, mas a negociação/validação TURN falhou.');
  assert.equal(result.ok, true, 'Conexão TURN validada.');
  assert.equal(result.peerCount, 2, 'Ambos os peers locais devem ser validados.');
  assert.equal(result.localType, 'relay', 'Candidato local selecionado deve ser relay em ambos os peers.');
  assert.equal(result.remoteType, 'relay', 'Candidato remoto selecionado deve ser relay em ambos os peers.');
  assert.equal(result.received, true, 'Dados devem atravessar o par de candidatos selecionado.');
});

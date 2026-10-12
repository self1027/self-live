const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const electron = require('electron');
const children = [];
let nextId = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(name, host) {
  const env = { ...process.env, SELF_LIVE_SMOKE_NAME: name };
  delete env.ELECTRON_RUN_AS_NODE;
  if (host) { env.SELF_LIVE_SMOKE_URL = host.url; env.SELF_LIVE_SMOKE_FINGERPRINT = host.fingerprint; }
  else { delete env.SELF_LIVE_SMOKE_URL; delete env.SELF_LIVE_SMOKE_FINGERPRINT; }
  const child = spawn(electron, [path.join(__dirname, 'room-smoke-peer.js')], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); process.stdout.write(data); });
  child.stderr.on('data', data => { output += data.toString(); process.stderr.write(data); });
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error(`Timeout ao iniciar ${name}`)), 20000);
  child.on('message', message => {
    if (message.type === 'ready') { clearTimeout(timer); readyResolve(message); return; }
    const operation = pending.get(message.id);
    if (!operation) return;
    clearTimeout(operation.timer); pending.delete(message.id);
    if (message.ok) operation.resolve(message.result);
    else operation.reject(new Error(message.error));
  });
  const fail = error => {
    clearTimeout(timer); readyReject(error);
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`${name} encerrou (${code})`)));
  const info = await ready;
  return { ...info, child, name, output: () => output, rpc(type, code) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout do comando em ${name}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, type, code });
    });
  } };
}


const fs = require('node:fs');
const evaluate = (peer, code) => peer.rpc('evaluate', code);
const click = (peer, id) => evaluate(peer, `document.getElementById(${JSON.stringify(id)}).click()`);
async function waitFor(peer, expression) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(peer, expression)) return;
    await delay(100);
  }
  throw new Error(`Estado não alcançado: ${expression}`);
}
async function view(peer, name) {
  await waitFor(peer, `document.body.dataset.view === '${name}'`);
  assert.equal(await evaluate(peer, `['landing','room','streaming','watching'].filter(name => !document.getElementById('view-' + name).classList.contains('hidden')).join()`), name);
}
const screenshots = path.resolve(__dirname, '../docs/screenshots');
async function screenshot(peer, name) { await delay(200); await peer.rpc('screenshot', path.join(screenshots, `${name}.png`)); }
(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  process.env.SELF_LIVE_SMOKE_LANDING = '1';
  const a = await launch('A');
  await view(a, 'landing');
  assert.equal(await evaluate(a, `document.getElementById('start-stream').getClientRects().length`), 0);
  assert.equal(await evaluate(a, `document.getElementById('logging-enabled').checked`), false);
  await click(a, 'logging-enabled');
  await waitFor(a, `document.getElementById('logging-enabled').checked`);
  await screenshot(a, 'landing'); console.log('1. Landing: somente criar/entrar — OK');
  await click(a, 'entry-join');
  assert.ok(await evaluate(a, `document.getElementById('create-panel').hidden && !document.getElementById('join-panel').hidden`));
  await screenshot(a, 'landing-join');
  await click(a, 'entry-create');
  await click(a, 'create-room'); await view(a, 'room');
  assert.equal(await evaluate(a, `getComputedStyle(document.querySelector('main')).overflow`), 'hidden');
  assert.equal(await evaluate(a, `getComputedStyle(document.querySelector('#view-room aside')).overflowY`), 'auto');
  await click(a, 'open-diagnostics');
  assert.ok(await evaluate(a, `document.getElementById('diagnostics-dialog').open && document.getElementById('signaling-mode').getClientRects().length > 0`));
  await click(a, 'close-diagnostics');
  assert.equal(await evaluate(a, `document.getElementById('start-stream').getClientRects().length`), 0);
  await screenshot(a, 'room'); console.log('2. Sala sem controles de transmissão — OK');
  await click(a, 'want-stream');
  await waitFor(a, `document.getElementById('share-dialog').open && Boolean(document.querySelector('.source-tile:not(:disabled)'))`);
  assert.equal(await evaluate(a, `document.getElementById('source').value`), '');
  assert.equal(await evaluate(a, `document.getElementById('start-stream').disabled`), true);
  assert.equal(await evaluate(a, `document.getElementById('share-advanced').open`), false);
  await evaluate(a, `document.getElementById('share-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))`);
  assert.equal(await evaluate(a, `document.getElementById('share-dialog').open`), false);
  assert.equal(await evaluate(a, `Boolean(document.getElementById('preview').srcObject)`), false);
  await click(a, 'want-stream');
  await waitFor(a, `document.getElementById('share-dialog').open && Boolean(document.querySelector('.source-tile:not(:disabled)'))`);
  await evaluate(a, `document.querySelector('.source-tile').click()`);
  await waitFor(a, `document.getElementById('source-preview-image').naturalWidth > 0`);
  assert.equal(await evaluate(a, `document.getElementById('source-preview-image').hidden`), false);
  assert.deepEqual(await evaluate(a, `[...document.getElementById('resolution').options].map(option=>option.value)`), ['auto', '144', '240', '360']);
  await screenshot(a, 'share-image');
  assert.equal(await evaluate(a, `document.getElementById('audio-mode').value`), 'on');
  assert.equal(await evaluate(a, `document.getElementById('share-advanced').contains(document.getElementById('audio-mode'))`), true);
  assert.equal(await evaluate(a, `document.getElementById('audio-choice').hidden`), false);
  assert.equal(await evaluate(a, `[...document.getElementById('audio-app').options].find(option=>option.value==='Discord.exe').selected`), true);
  assert.equal(await evaluate(a, `[...document.getElementById('audio-app').options].find(option=>option.value==='Discord.exe').disabled`), false);
  await evaluate(a, `document.getElementById('audio-mode').value='none'; document.getElementById('audio-mode').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(a, `document.getElementById('audio-choice').hidden`), true);
  await evaluate(a, `document.getElementById('audio-mode').value='on'; document.getElementById('audio-mode').dispatchEvent(new Event('change'))`);
  await evaluate(a, `const option=new Option('Discord','window:123:0'); document.getElementById('source').add(option); document.getElementById('source').value=option.value; document.getElementById('source').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(a, `document.getElementById('audio-choice').hidden`), true);
  assert.ok(await evaluate(a, `document.getElementById('capture-audio-info').textContent.includes('se aplicam')`));
  await evaluate(a, `document.querySelector('.source-tile').click()`);
  assert.equal(await evaluate(a, `document.getElementById('audio-choice').hidden`), false);
  await evaluate(a, `document.getElementById('audio-manual').value='C:/call.exe'`);
  await click(a, 'start-stream');
  assert.ok(await evaluate(a, `document.getElementById('share-error').textContent.includes('.exe')`));
  assert.equal(await evaluate(a, `Boolean(document.getElementById('preview').srcObject)`), false);
  await evaluate(a, `document.getElementById('audio-manual').value=''`);
  console.log('Audio simples: padrao ligado e exclusoes condicionais - OK');
  await screenshot(a, 'share-audio');
  await evaluate(a, `document.getElementById('share-advanced').open=true`);
  await evaluate(a, `document.getElementById('preset').value='6000000'`);
  await evaluate(a, `document.getElementById('resolution').value='240'; document.getElementById('resolution').dispatchEvent(new Event('change')); document.getElementById('capture-fps').value='15'`);
  await screenshot(a, 'share-quality');
  assert.equal(await evaluate(a, `document.getElementById('audio-mode').value`), 'on');
  await evaluate(a, `document.getElementById('share-advanced').open=false`);
  await screenshot(a, 'share-review');
  await click(a, 'start-stream'); await view(a, 'streaming');
  assert.equal(await evaluate(a, `document.getElementById('share-dialog').open`), false);
  assert.equal((await evaluate(a, `window.selfLive.sharePreferences()`)).bitrate, '6000000');
  assert.equal((await evaluate(a, `window.selfLive.sharePreferences()`)).resolution, '240');
  assert.equal((await evaluate(a, `window.selfLive.sharePreferences()`)).fps, '15');
  assert.equal((await evaluate(a, `window.selfLive.sharePreferences()`)).audioMode, 'on');
  assert.deepEqual((await evaluate(a, `window.selfLive.sharePreferences()`)).applications, ['Discord.exe']);
  console.log('Modal único: prévias, cancelamento, validação, opções avançadas e preferências — OK');
  await waitFor(a, `document.getElementById('preview').videoWidth > 0`);
  assert.equal(await evaluate(a, `[...document.querySelectorAll('#streams button,#peers button')].filter(button => button.getClientRects().length).length`), 0);
  delete process.env.SELF_LIVE_SMOKE_LANDING;
  const b = await launch('B', a);
  await waitFor(b, `Boolean(document.querySelector('#streams button'))`);
  await evaluate(b, `document.querySelector('#streams button').click()`);
  await view(b, 'watching');
  await waitFor(b, `document.getElementById('p2p-video').videoWidth > 0`);
  await delay(2500);
  await screenshot(a, 'streaming'); console.log('3. Transmissão com preview, sem assistir — OK');
  await screenshot(b, 'watching'); console.log('4. Viewer com vídeo recebido — OK');
  assert.ok(await evaluate(b, `document.body.classList.contains('watching-theater') && getComputedStyle(document.querySelector('#view-watching aside')).display === 'none'`));
  assert.ok(await evaluate(b, `document.getElementById('p2p-video').getBoundingClientRect().height > innerHeight * 0.7`));
  const theaterWidth = await evaluate(b, `document.getElementById('p2p-video').getBoundingClientRect().width`);
  await click(b, 'theater-toggle');
  assert.ok(await evaluate(b, `!document.body.classList.contains('watching-theater') && document.getElementById('p2p-video').getBoundingClientRect().width < ${theaterWidth}`));
  await screenshot(b, 'watching-panels');
  await click(b, 'fullscreen-toggle');
  await waitFor(b, `document.fullscreenElement?.id === 'watch-player-container'`);
  await click(b, 'fullscreen-toggle');
  await waitFor(b, `document.fullscreenElement === null`);
  await click(b, 'theater-toggle');
  console.log('Modo teatro, painéis retráteis e tela cheia — OK');
  await click(b, 'play-pause'); assert.equal(await evaluate(b, `document.getElementById('p2p-video').paused`), true);
  await click(b, 'play-pause'); await click(b, 'p2p-sound');
  assert.equal(await evaluate(b, `document.getElementById('p2p-video').muted`), false);
  assert.equal(await evaluate(a, `document.getElementById('logging-indicator').hidden`),false);
  assert.equal(await evaluate(a, `document.getElementById('logging-enabled').disabled`),true);
  assert.equal(await evaluate(a, `document.getElementById('experimental-fps').disabled`),true);
  await click(a,'adaptive-enabled');
  await waitFor(a, `!document.getElementById('experimental-fps').disabled`);
  await click(a,'preview-hidden');
  await waitFor(a, `document.getElementById('preview') === null`);
  await evaluate(a, `document.getElementById('experimental-resolution').value='1280x720';document.getElementById('experimental-resolution').dispatchEvent(new Event('change'))`);
  await waitFor(a, `!document.getElementById('experimental-resolution').disabled`);
  await evaluate(a, `document.getElementById('experimental-fps').value='30';document.getElementById('experimental-fps').dispatchEvent(new Event('change'))`);
  await waitFor(a, `!document.getElementById('experimental-fps').disabled`);
  await click(a,'cpu-capture');
  assert.equal(await evaluate(a, `document.getElementById('cpu-capture').checked`),false);
  await evaluate(a, `document.getElementById('experimental-source').value='window:synthetic';document.getElementById('experimental-source').dispatchEvent(new Event('change'))`);
  await waitFor(a, `!document.getElementById('experimental-source').disabled && document.getElementById('experiment-feedback').textContent.includes('FONTE ATUALIZADA')`);
  await delay(2200);
  assert.ok(await evaluate(b, `document.getElementById('p2p-video').videoWidth > 0 && window.smoke.connections.at(-1).connectionState === 'connected'`));
  await click(a,'preview-hidden'); await waitFor(a, `document.getElementById('preview')?.videoWidth > 0`);
  await click(a,'export-diagnostic'); await waitFor(a, `document.getElementById('experiment-feedback').textContent.startsWith('EXPORTADO')`);
  console.log('Controles a quente: preview removido, qualidade/FPS, CPU indisponível, fonte e exportação — OK');
  await click(b, 'stop-watch'); await view(b, 'room'); console.log('5. Parar de assistir retorna à sala — OK');
  assert.ok(await evaluate(b, `!document.body.classList.contains('watching-theater') && document.fullscreenElement === null`));
  await click(a, 'stop-stream'); await view(a, 'room'); console.log('6. Parar transmissão retorna à sala — OK');
  const audit = await a.rpc('audit');
  assert.equal(audit[0].type,'start'); assert.equal(audit.at(-1).type,'end');
  const encoded = audit.flatMap(record=>record.connections || []).flatMap(connection=>connection.rows).filter(row=>row.type==='outbound-rtp');
  assert.ok(encoded.some(row=>row.encodedFps>0 && row.sendKbps>0 && Number.isFinite(row.encodeMs)), 'O log deve medir envio real entre peers.');
  assert.ok(!JSON.stringify(audit).includes('candidate') && !JSON.stringify(audit).includes('node_id') && !JSON.stringify(audit).includes('password'));
  console.log('Log por transmissão: taxas reais, encoding, encerramento e privacidade — OK');
  await click(b, 'leave'); await view(b, 'landing'); await click(a, 'leave'); await view(a, 'landing'); console.log('7. Sair retorna à landing — OK');
  const palette = await evaluate(a, `({ background:getComputedStyle(document.body).backgroundColor, accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), transform:getComputedStyle(document.getElementById('create-room')).textTransform })`);
  assert.deepEqual(palette, { background:'rgb(5, 5, 5)', accent:'#2ecc71', transform:'none' });
  assert.ok(await evaluate(a, `[...document.querySelectorAll('.icon-button')].every(button=>button.getAttribute('aria-label') && button.title && button.querySelector('svg'))`));
  console.log('8. Paleta preservada, texto legível e ícones acessíveis — OK');
  console.log(`Screenshots: ${screenshots}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of children) { if (child.connected) child.send({ id: ++nextId, type:'quit' }); }
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { if (child.exitCode === null) child.kill(); resolve(); }, 5000).unref(); })));
});

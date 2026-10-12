// Exercita o main real e safeStorage em um perfil temporário de QA.
const { app, BrowserWindow, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', process.argv[2]);
const phase = process.argv[3];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
require(process.argv[4] || '../src/main/main');
app.whenReady().then(async () => {
  let window;
  for (let attempt = 0; attempt < 100; attempt++) {
    window = BrowserWindow.getAllWindows()[0];
    if (window && !window.webContents.isLoading() && window.webContents.getURL().startsWith('http://127.0.0.1:')) break;
    await delay(100);
  }
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  await delay(300);
  assert.equal(await evaluate('document.body.dataset.view'), 'landing');
  const settings = await evaluate('window.selfLive.pilotSettings()');
  assert.equal(settings.upnp, 'off');
  if (phase === 'save') {
    assert.equal(await evaluate(`document.getElementById('user-name').value`), '');
    assert.ok(await evaluate(`document.getElementById('create-room').disabled && document.querySelector('#join button').disabled`));
    assert.ok((await evaluate('window.selfLive.config()')).requiresName);
    await evaluate(`document.getElementById('user-name').value='   '; document.getElementById('user-name').dispatchEvent(new Event('input'))`);
    assert.ok(await evaluate(`document.getElementById('create-room').disabled`));
    await evaluate(`document.getElementById('user-name').value='Meu usuário'; document.getElementById('user-name').dispatchEvent(new Event('input')); document.getElementById('identity-form').requestSubmit()`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await evaluate('window.selfLive.config()')).requiresName) break;
      await delay(100);
    }
    assert.equal((await evaluate('window.selfLive.config()')).name, 'Meu usuário');
    assert.equal((await evaluate('window.selfLive.config()')).requiresName, false);
    await evaluate(`window.selfLive.saveSharePreferences({audioMode:'exclude', applications:['Call.exe'], manual:'Other.exe', bitrate:'6000000', resolution:'720', fps:'30'})`);
    assert.ok(settings.room.startsWith('piloto-'));
    await evaluate(`document.getElementById('pilot-settings').click()`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate(`document.getElementById('pilot-dialog').open`)) break;
      await delay(100);
    }
    assert.ok(await evaluate(`document.getElementById('pilot-dialog').open`));
    await evaluate(`document.getElementById('pilot-name').value='PC piloto'; document.getElementById('pilot-room').value='piloto-config-smoke'; document.getElementById('pilot-password').value='senha-piloto-smoke-123'; document.getElementById('pilot-form').requestSubmit()`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate(`!document.getElementById('pilot-restart').disabled`)) break;
      await delay(100);
    }
    assert.ok(await evaluate(`!document.getElementById('pilot-restart').disabled`));
    const raw = fs.readFileSync(path.join(process.argv[2], 'pilot-config.json'), 'utf8');
    assert.ok(!raw.includes('senha-piloto-smoke-123'));
  } else {
    assert.equal(await evaluate(`document.getElementById('user-name').value`), 'PC piloto');
    assert.equal((await evaluate('window.selfLive.config()')).requiresName, false);
    assert.equal(await evaluate(`document.getElementById('preset').value`), '6000000');
    assert.equal(await evaluate(`document.getElementById('resolution').value`), '720');
    assert.equal(await evaluate(`document.getElementById('capture-fps').value`), '30');
    assert.equal(await evaluate(`document.getElementById('audio-mode').value`), 'on');
    assert.deepEqual((await evaluate('window.selfLive.sharePreferences()')).applications, ['Discord.exe', 'Call.exe']);
    assert.equal(settings.room, 'piloto-config-smoke');
    assert.equal((await evaluate('window.selfLive.config()')).name, 'PC piloto');
    await evaluate(`document.getElementById('user-name').value='Nome atualizado'; document.getElementById('user-name').dispatchEvent(new Event('input'))`);
    await evaluate(`document.getElementById('create-room').click()`);
    let joined = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      joined = await evaluate(`document.body.dataset.view === 'room'`);
      if (joined) break;
      await delay(100);
    }
    assert.ok(joined, 'Criar sala usa a senha protegida sem digitação');
    assert.equal((await evaluate('window.selfLive.config()')).name, 'Nome atualizado');
    assert.equal((await evaluate('window.selfLive.pilotSettings()')).name, 'Nome atualizado');
    assert.ok(await evaluate(`document.getElementById('peers').textContent.includes('Nome atualizado')`));
    if (process.env.SELF_LIVE_CAPTURE_QA === '1') {
      const results = await evaluate(`(async () => {
        const sources = await selfLive.sources();
        const source = sources.find(item => item.id.startsWith('screen:'));
        if (!source || !source.thumbnail?.startsWith('data:image/png')) throw new Error('Prévia nativa indisponível');
        const {captureSystemMedia} = await import('/webrtc.js');
        const results = [];
        for (const [resolution, fps] of [['144',15],['720',30],['1080',60]]) {
          await selfLive.selectSource(source.id, {mode:'none', applications:[]});
          const captured = await captureSystemMedia({resolution,fps});
          try { const settings = captured.getVideoTracks()[0].getSettings(); results.push({resolution,fps,width:settings.width,height:settings.height,frameRate:settings.frameRate}); }
          finally { captured.stopApplicationAudio?.(); captured.getTracks().forEach(track=>track.stop()); }
        }
        return results;
      })()`);
      for (const result of results) {
        assert.ok(result.width > 0 && result.width <= 1920);
        assert.ok(result.height > 0 && result.height <= Number(result.resolution));
        assert.ok(result.frameRate <= result.fps + 0.1);
      }
      console.log('Captura nativa: ' + JSON.stringify(results));
    }
    const previousClipboard = clipboard.readText();
    try {
      await evaluate(`document.getElementById('share-password').click()`);
      await delay(200);
      assert.ok(clipboard.readText() === 'senha-piloto-smoke-123', 'Copiar senha deve gravar a senha de teste no clipboard.');
      assert.equal(await evaluate(`Boolean(document.querySelector('#share-card details, #share-password-dialog'))`), false);
      assert.equal(await evaluate(`document.getElementById('share-card').textContent.includes('senha-piloto-smoke-123')`), false);
      assert.equal(await evaluate(`document.getElementById('invitation-status').textContent`), 'Senha copiada.');
      await evaluate(`document.getElementById('copy-link').click()`);
      await delay(300);
      assert.ok(clipboard.readText().startsWith('self-live://join?data='));
      assert.equal(clipboard.readText(), await evaluate(`document.getElementById('invitation-link').value`));
      assert.equal(await evaluate(`[...document.querySelectorAll('#share-card button')].filter(button => button.getClientRects().length).length`), 2);
    } finally { clipboard.writeText(previousClipboard); }
  }
  console.log(`Piloto: ${phase} validado, safeStorage real e main de produção.`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

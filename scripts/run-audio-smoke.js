const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const electron = require('electron');
const children = [], aliases = [];
let serial = 0;
async function launch(tone, name) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (tone) env.AUDIO_TONE = String(tone); else delete env.AUDIO_TONE;
  let binary = electron;
  if (name) {
    binary = path.join(path.dirname(electron), name);
    // Independent executable identities, real Windows audio sessions, no fake capture.
    fs.linkSync(electron, binary); aliases.push(binary);
  }
  const child = spawn(binary, [path.join(__dirname, 'audio-smoke-peer.js')], { env,
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child); child.stderr.on('data', bytes => process.stderr.write(bytes));
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout ao iniciar áudio QA')), 20000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Áudio QA encerrou: ' + code)); });
    child.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timer); resolve(message); return; }
      const job = pending.get(message.id); if (!job) return;
      clearTimeout(job.timer); pending.delete(message.id);
      message.ok ? job.resolve(message.result) : job.reject(new Error(message.error));
    });
  });
  const rpc = (type, code) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout na captura de áudio')); }, 20000);
    pending.set(id, { resolve, reject, timer }); child.send({ id, type, code });
  });
  return { ...await ready, name, evaluate: code => rpc('evaluate', code), hide: () => rpc('hide') };
}
(async () => {
  assert.equal(process.platform, 'win32', 'O teste nativo exige Windows');
  const gameName = 'AudioGameQA-' + process.pid + '.exe', musicName = 'AudioMusicQA-' + process.pid + '.exe';
  const lateName = 'AudioManualCallQA-' + process.pid + '.exe';
  const target = await launch(440, gameName), music = await launch(660, musicName);
  const discord = await launch(880, 'DiscordDevelopment.exe');
  const receiver = await launch();
  await receiver.evaluate(String.raw`window.qaStart = async options => {
    const { attachApplicationAudio } = await import('/application-audio.js');
    const stream = document.createElement('canvas').captureStream(1);
    await selfLive.selectSource(window.qaWindow, options);
    await attachApplicationAudio(stream, selfLive);
    if (!stream.getAudioTracks().length) throw new Error(stream.audioNote);
    const sender = new RTCPeerConnection(), viewer = new RTCPeerConnection();
    const qa = window.qa = { stream, sender, viewer, queues: [[],[]] };
    for (const [from,to,queue] of [[sender,viewer,qa.queues[0]], [viewer,sender,qa.queues[1]]]) {
      from.onicecandidate = event => { if (!event.candidate) return;
        if (to.remoteDescription) to.addIceCandidate(event.candidate).catch(() => {});
        else queue.push(event.candidate);
      };
    }
    const track = new Promise(resolve => { viewer.ontrack = event => resolve(event.streams[0]); });
    for (const audio of stream.getAudioTracks()) sender.addTrack(audio, stream);
    await sender.setLocalDescription(await sender.createOffer());
    await viewer.setRemoteDescription(sender.localDescription);
    for (const candidate of qa.queues[0]) await viewer.addIceCandidate(candidate);
    await viewer.setLocalDescription(await viewer.createAnswer());
    await sender.setRemoteDescription(viewer.localDescription);
    for (const candidate of qa.queues[1]) await sender.addIceCandidate(candidate);
    const remote = await track;
    qa.player = document.createElement('audio'); qa.player.autoplay = true;
    qa.player.muted = true; qa.player.srcObject = remote; await qa.player.play();
    qa.context = new AudioContext({sampleRate:48000}); qa.analyser = qa.context.createAnalyser();
    qa.analyser.fftSize = 8192; qa.context.createMediaStreamSource(remote).connect(qa.analyser);
    const silence = qa.context.createGain(); silence.gain.value = 0;
    qa.analyser.connect(silence).connect(qa.context.destination);
    qa.local = qa.context.createAnalyser(); qa.local.fftSize = 8192;
    qa.context.createMediaStreamSource(stream).connect(qa.local);
    await qa.context.resume();
  };
  window.qaMeasure = async () => {
    await new Promise(resolve => setTimeout(resolve, 2200));
    const samples = new Float32Array(8192); qa.analyser.getFloatTimeDomainData(samples);
    const power = frequency => { let re=0,im=0;
      samples.forEach((sample,index) => {const phase=2*Math.PI*frequency*index/48000;
        re+=sample*Math.cos(phase); im+=sample*Math.sin(phase);});
      return Math.hypot(re,im)/samples.length;
    };
    const stats = await qa.viewer.getStats();
    const inbound = [...stats.values()].find(s => s.type==='inbound-rtp' && s.kind==='audio');
    const localSamples = new Float32Array(8192); qa.local.getFloatTimeDomainData(localSamples);
    return {game:power(440),music:power(660),call:power(880),manual:power(1100),
      localPeak:Math.max(...localSamples.map(Math.abs)), received:inbound?.bytesReceived, energy:inbound?.totalAudioEnergy,
      codec:stats.get(inbound?.codecId)?.mimeType};
  };
  window.qaStop = async () => {
    qa.stream.stopApplicationAudio(); qa.stream.getTracks().forEach(track=>track.stop());
    qa.sender.close(); qa.viewer.close(); await qa.context.close();
    qa.player.srcObject = null;
  }; undefined;`);
  await receiver.evaluate('window.qaWindow = ' + JSON.stringify('window:' + target.hwnd + ':0'));
  const check = (result, wantMusic = false) => {
    assert.ok(result.game > 0.001, JSON.stringify(result));
    if (wantMusic) assert.ok(result.music > 0.001, JSON.stringify(result));
    else assert.ok(result.music < result.game / 15, JSON.stringify(result));
    assert.ok(result.call < result.game / 15, JSON.stringify(result));
    assert.equal(result.codec?.toLowerCase(), 'audio/opus');
  };
  await receiver.evaluate('qaStart(' + JSON.stringify({mode:'window',sourceId:'window:' + target.hwnd + ':0'}) + ')');
  check(await receiver.evaluate('qaMeasure()'));
  await receiver.evaluate('qaStop()');
  console.log('PASS: janela envia jogo, exclui outros apps e chega ao viewer em Opus.');
  await receiver.evaluate('qaStart(' + JSON.stringify({mode:'include', applications:[gameName,musicName,'DiscordDevelopment.exe']}) + ')');
  check(await receiver.evaluate('qaMeasure()'), true);
  await receiver.evaluate('qaStop()');
  console.log('PASS: dois aplicativos misturados; aplicativo conhecido de chamada continua excluído.');
  await receiver.evaluate('qaStart(' + JSON.stringify({mode:'window',sourceId:'window:' + discord.hwnd + ':0'}) + ')');
  const explicit = await receiver.evaluate('qaMeasure()');
  assert.ok(explicit.call > 0.001, JSON.stringify(explicit));
  assert.ok(explicit.game < explicit.call / 15 && explicit.music < explicit.call / 15, JSON.stringify(explicit));
  assert.equal(explicit.codec?.toLowerCase(), 'audio/opus');
  await receiver.evaluate('qaStop()');
  console.log('PASS: janela explícita de Discord envia áudio de Discord, sem jogo ou música.');
  await receiver.evaluate('qaStart(' + JSON.stringify({mode:'desktop',applications:[]}) + ')');
  const all = await receiver.evaluate('qaMeasure()');
  assert.ok(all.game > 0.001 && all.music > 0.001 && all.call > 0.001, JSON.stringify(all));
  await receiver.evaluate('qaStop()');
  console.log('PASS: desmarcar exclusão permite som do Discord na tela inteira.');
  await target.hide();
  const sources = await receiver.evaluate('selfLive.applicationAudioSources()');
  assert.ok(sources.applications.some(app => app.name.toLowerCase() === gameName.toLowerCase()), 'Aplicativo sem janela precisa aparecer pelas sessões.');
  await receiver.evaluate('qaStart(' + JSON.stringify({mode:'desktop', applications:['Discord.exe',musicName,lateName]}) + ')');
  check(await receiver.evaluate('qaMeasure()'));
  await launch(1100, lateName);
  const result = await receiver.evaluate('qaMeasure()'); check(result);
  assert.ok(result.manual < result.game / 15, JSON.stringify(result));
  await receiver.evaluate('qaStop()');
  console.log('PASS: exclui chamada conhecida e exclusão manual, incluindo aplicativo aberto depois; captura app sem janela.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of children) if (child.connected) child.disconnect();
  await Promise.all(children.map(child => child.exitCode !== null ? null : new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  for (const alias of aliases) { try { fs.unlinkSync(alias); } catch { /* A failed child might still be exiting. */ } }
});


const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const os = require('node:os');
const { AudioMixer } = require('./audio-mixer');
const run = promisify(execFile);
const blocked = /^(discord(?:canary|ptb|development)?|teams|ms-teams|msteams|zoom|skype|skypeapp|slack|whatsapp|signal|telegram|telegramdesktop|webex|ciscocollabhost|element|chrome|chromium|msedge|firefox|brave|opera|opera_gx|vivaldi|arc|iexplore|self live|self-live)\.exe$/i;
const discord = /^discord(?:canary|ptb|development)?\.exe$/i;
const ownApp = /^(self live|self-live)\.exe$/i;
const validExecutable = value => typeof value === 'string' && value.length <= 256 && /^[^\\/\r\n]+\.exe$/i.test(value);
function audioPolicy({ pid, windows, executable }, selfPid = process.pid) {
  if (!validExecutable(executable)) return 'Áudio bloqueado: aplicativo não identificado.';
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid || blocked.test(executable)) return 'Áudio bloqueado: aplicativo de chamadas, navegador ou Self Live.';
  if (windows !== 1) return 'Áudio bloqueado: o aplicativo possui várias janelas ou a janela não está disponível.';
  return null;
}
function validateSelection(value) {
  if (typeof value === 'string' || value === undefined) return value;
  if (value?.mode === 'window') {
    if (!/^window:\d+(?::\d+)?$/.test(value.sourceId)) throw new Error('Janela de áudio inválida.');
    return { mode: 'window', sourceId: value.sourceId };
  }
  if (!value || !['none', 'include', 'exclude', 'desktop'].includes(value.mode)) throw new Error('Modo de áudio inválido.');
  const names = value.applications;
  if (!Array.isArray(names) || names.length > 16 || names.some(name => !validExecutable(name))) throw new Error('Lista de áudio inválida (máximo 16 aplicativos).');
  return { mode: value.mode, applications: [...new Set(names.map(name => name.toLowerCase()))] };
}
function capturePlan(snapshot, selection, selfPid = process.pid) {
  const processes = new Map(snapshot.processes.map(info => [info.pid, info]));
  const selected = new Set(selection.applications || []), forbidden = new Set();
  const modern = ['desktop', 'window'].includes(selection.mode);
  const excluded = name => selected.has(name.toLowerCase()) || (selected.has('discord.exe') && discord.test(name));
  for (const info of processes.values()) if (info.pid === selfPid || ownApp.test(info.executable) ||
    (!modern && blocked.test(info.executable)) ||
    (['exclude', 'desktop'].includes(selection.mode) && excluded(info.executable))) forbidden.add(info.pid);
  const ancestors = pid => {
    const chain = [], seen = new Set();
    while (processes.has(pid) && !seen.has(pid)) { seen.add(pid); chain.push(pid); pid = processes.get(pid).parent; }
    return chain;
  };
  const candidates = new Set();
  for (const pid of snapshot.sessions) {
    const chain = ancestors(pid);
    if (!chain.length || chain.some(id => forbidden.has(id))) continue;
    let root = pid;
    if (selection.mode === 'window') {
      if (!chain.includes(selection.pid)) continue;
      root = selection.pid;
    }
    if (selection.mode === 'include') {
      root = chain.find(id => selected.has(processes.get(id).executable.toLowerCase()));
      if (!root) continue;
      for (const id of chain.slice(chain.indexOf(root) + 1)) {
        if (processes.get(id).executable.toLowerCase() !== processes.get(root).executable.toLowerCase()) break;
        root = id;
      }
    }
    if ([...forbidden].some(id => ancestors(id).includes(root))) continue;
    candidates.add(root);
  }
  return [...candidates].filter(pid => !ancestors(pid).slice(1).some(id => candidates.has(id))).slice(0, 16);
}
function createApplicationAudio({ app, getWindow }) {
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'audio/app-audio.exe') : path.join(__dirname, '../../native/bin/app-audio.exe');
  let active, generation = 0;
  const supported = () => process.platform === 'win32' && Number(os.release().split('.')[2]) >= 20348;
  const snapshot = async () => JSON.parse((await run(helper, ['sessions'], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 })).stdout);
  function publish(channel, value) { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
  function stop() {
    generation++; const old = active; active = null;
    if (!old) return;
    clearInterval(old.timer); clearInterval(old.monitor);
    for (const child of old.children.values()) child.kill(); old.children.clear();
  }
  function suspend(state, reason) {
    if (active !== state) return;
    stop(); publish('application-audio-ended', { reason });
  }
  function open(state, pid, hwnd = '0') {
    const child = spawn(helper, ['capture', String(pid), hwnd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    state.children.set(pid, child); state.mixer.add(pid);
    let pending = Buffer.alloc(0);
    child.stdout.on('data', bytes => {
      if (active !== state || state.children.get(pid) !== child) return;
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 12) {
        const length = pending.readUInt32LE(0);
        if (length > 262144 || !length || length % 4) { suspend(state, 'Áudio suspenso: pacote nativo inválido.'); return; }
        if (pending.length < length + 12) break;
        state.mixer.push(pid, Number(pending.readBigUInt64LE(4)), Buffer.from(pending.subarray(12, 12 + length)));
        pending = pending.subarray(12 + length);
      }
    });
    return new Promise((resolve, reject) => {
      let settled = false, status = '';
      const timer = setTimeout(() => finish(new Error('Captura de áudio não respondeu.')), 6000);
      function finish(error) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); }
      child.stderr.on('data', bytes => { status = (status + bytes.toString()).slice(-512); if (/\bready\r?\n/.test(status)) finish(); });
      child.on('error', () => { finish(new Error('Captura de áudio indisponível.')); suspend(state, 'Áudio suspenso: falha na captura.'); });
      child.on('close', (code, signal) => {
        finish(new Error('Captura de áudio encerrada.'));
        if (active !== state || state.children.get(pid) !== child) return;
        state.children.delete(pid); state.mixer.remove(pid);
        if (code !== 0 || signal) { suspend(state, 'Áudio suspenso: uma fonte falhou. Pare e reinicie a transmissão.'); return; }
        if (state.legacy) suspend(state, 'Áudio encerrado: a janela foi fechada ou há várias janelas.');
      });
    });
  }
  return {
    stop,
    async sources() {
      if (!supported()) return { available: false, applications: [], reason: 'Áudio isolado exige Windows build 20348 ou posterior.' };
      try {
        const info = await snapshot(), processes = new Map(info.processes.map(p => [p.pid, p]));
        const names = new Set();
        for (const pid of info.sessions) {
          const entry = processes.get(pid); if (entry && validExecutable(entry.executable)) names.add(entry.executable);
        }
        return { available: true, applications: [...names].sort().map(name => ({ name, blocked: blocked.test(name) })) };
      } catch { return { available: false, applications: [], reason: 'Não foi possível consultar os aplicativos de áudio. Transmissão sem áudio.' }; }
    },
    async start(value) {
      value = validateSelection(value); stop(); const current = generation;
      if (!value || value.mode === 'none') return { enabled: false, reason: 'Transmissão sem áudio.' };
      if (!supported()) return { enabled: false, reason: 'Áudio isolado exige Windows build 20348 ou posterior. Transmissão sem áudio.' };
      const state = { children: new Map(), legacy: typeof value === 'string' };
      state.mixer = new AudioMixer(bytes => { if (active === state) publish('application-audio-data', bytes); });
      active = state;
      try {
        if (state.legacy || value.mode === 'window') {
          const match = /^window:(\d+)(?::\d+)?$/.exec(state.legacy ? value : value.sourceId); if (!match) throw new Error('Selecione uma janela para o áudio.');
          const result = await run(helper, ['resolve', match[1]], { windowsHide: true, timeout: 3000, maxBuffer: 4096 });
          const [pid, windows, executable] = result.stdout.trim().split(/\r?\n/);
          const reason = state.legacy ? audioPolicy({ pid: Number(pid), windows: Number(windows), executable }) :
            !validExecutable(executable) || !Number.isInteger(Number(pid)) || Number(pid) <= 0 || Number(pid) === process.pid || ownApp.test(executable) ? 'Não é possível compartilhar o áudio deste aplicativo.' : null;
          if (reason) { if (active === state) stop(); return { enabled: false, reason }; }
          if (generation !== current) return { enabled: false, reason: 'Captura cancelada.' };
          if (state.legacy) await open(state, Number(pid), match[1]);
          else value = { ...value, pid: Number(pid) };
        }
        if (!state.legacy) {
          let updating = false;
          const update = async () => {
            if (active !== state || updating) return; updating = true;
            try {
              const info = await snapshot(); if (active !== state) return;
              const targets = capturePlan(info, value), wanted = new Set(targets);
              for (const [pid, child] of state.children) if (!wanted.has(pid)) { state.children.delete(pid); state.mixer.remove(pid); child.kill(); }
              await Promise.all(targets.filter(pid => !state.children.has(pid)).map(pid => open(state, pid)));
              if (active === state) {
                const processes = new Map(info.processes.map(p => [p.pid, p]));
                publish('application-audio-state', { mode: value.mode, capturing: targets.map(pid => processes.get(pid)?.executable),
                  excluded: [...new Set([...info.processes.filter(p => (['desktop', 'window'].includes(value.mode) ? ownApp : blocked).test(p.executable)).map(p => p.executable), ...(['exclude', 'desktop'].includes(value.mode) ? value.applications : [])])] });
              }
            } catch (error) { suspend(state, 'Áudio suspenso: não foi possível verificar as exclusões.'); throw error; }
            finally { updating = false; }
          };
          await update();
          if (active === state) state.monitor = setInterval(() => update().catch(() => {}), 1000);
        }
        if (active !== state) return { enabled: false, reason: 'Captura cancelada.' };
        state.timer = setInterval(() => state.mixer.tick(), 20);
        return { enabled: true, sampleRate: 48000, channels: 2, reason: state.legacy || value.mode === 'window' ? 'Som do aplicativo desta janela, incluindo suas outras janelas e chamadas.' :
          value.mode === 'desktop' ? 'Som dos aplicativos disponíveis, exceto os que você excluiu. O microfone não é compartilhado.' :
          value.mode === 'include' ? 'Som dos aplicativos escolhidos. Chamadas no mesmo aplicativo não podem ser separadas.' : 'Outros sons, exceto aplicativos bloqueados e exclusões escolhidas. Chamadas não identificadas podem ser compartilhadas.' };
      } catch (error) { if (active === state) stop(); throw new Error('Não foi possível iniciar o áudio isolado. Atualize as fontes e tente novamente.', { cause: error }); }
    }
  };
}
module.exports = { createApplicationAudio, audioPolicy, validateSelection, capturePlan };


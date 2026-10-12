// QA: independent tone producers and a sandboxed receiver using the real preload/worklet.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { startServers } = require('../src/main/server');
const { createApplicationAudio } = require('../src/main/application-audio');
let window, servers, audio;
app.setPath('userData', path.join(app.getPath('temp'), `self-live-audio-qa-${process.pid}`));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
  ipcMain.handle('relay-status', () => ({ status: 'disabled' }));
  ipcMain.handle('connectivity', () => ({ portMapping: { status: 'disabled' } }));
  window = new BrowserWindow({ width: 320, height: 200, show: true,
    webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.minimize();
  if (process.env.AUDIO_TONE) {
    await window.loadURL('data:text/html,<title>Audio QA</title>');
    await window.webContents.executeJavaScript(`(async () => {
      window.context = new AudioContext({sampleRate:48000});
      const tone = context.createOscillator(), gain = context.createGain();
      tone.frequency.value = ${Number(process.env.AUDIO_TONE)}; gain.gain.value = 0.03;
      tone.connect(gain).connect(context.destination); tone.start(); await context.resume();
    })()`, true);
  } else {
    servers = await startServers('audio-qa', 'unused');
    audio = createApplicationAudio({ app, getWindow: () => window });
    let selected;
    const trusted = event => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('IPC não autorizado');
    };
    ipcMain.handle('select-source', (event, id, options) => { trusted(event); selected = options || id; });
    ipcMain.handle('application-audio-sources', event => { trusted(event); return audio.sources(); });
    ipcMain.handle('application-audio-start', event => { trusted(event); return audio.start(selected); });
    ipcMain.handle('application-audio-stop', event => { trusted(event); audio.stop(); });
    // A same-origin blank document without booting the dashboard's room workflow.
    await window.loadURL(servers.url + '/audio-worklet.js');
  }
  const handle = window.getNativeWindowHandle();
  process.send({ type: 'ready', hwnd: handle.readBigUInt64LE().toString() });
}).catch(error => { console.error(error.message); app.exit(1); });
process.on('message', async command => {
  try {
    if (command.type === 'hide') { window.hide(); process.send({ id: command.id, ok: true }); return; }
    const result = await window.webContents.executeJavaScript(command.code, true);
    process.send({ id: command.id, ok: true, result });
  } catch (error) { process.send({ id: command.id, ok: false, error: error.message }); }
});
process.on('disconnect', async () => { audio?.stop(); await servers?.close(); app.exit(); });

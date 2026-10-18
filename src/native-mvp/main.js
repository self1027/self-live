const { app, BrowserWindow, ipcMain, clipboard, shell, Menu, dialog, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { NativeVideo } = require('./controller');
const { createViewerServer } = require('./server');
const { createNativeAudit } = require('./audit');
const { createIceSettings } = require('./ice-config');
const { readRelayConfig } = require('../main/relay-client');
app.setName('Self Live Native MVP');
app.setPath('userData',path.join(app.getPath('appData'),'SelfLive-NativeMVP'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
let window, native, server, closing, phase = 'idle', recording = false;
const viewers = new Set();
const directory = path.join(app.getPath('documents'),'SelfLive-NativeMVP-Logs');
const audit = createNativeAudit(directory);
function publish(value) {
  if (!['sample','receiver-sample','source-resize','viewer-connected','viewer-disconnected','viewer-error','stopped','error','signaling-status','ice-candidates','peer-state'].includes(value.type)) return;
  if (recording) { try { audit.write(value); } catch { recording = false; } }
  if (['error','stopped'].includes(value.type)) { phase = 'idle'; recording = false; audit.stop(); }
  if (window && !window.isDestroyed()) window.webContents.send('native-mvp-event',value);
}
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(path.join(__dirname,'ui/host.html')).href) throw new Error('IPC nao autorizado.');
}
async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    audit.stop(); recording = false;
    for (const viewer of viewers) viewer.destroy();
    await server?.close(); await native?.close();
    app.exit(0);
  })();
  return closing;
}
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const runtime = app.isPackaged ? path.join(process.resourcesPath,'native-mvp/gstreamer') : path.resolve(__dirname,'../../.native-deps/gstreamer');
  const executable = app.isPackaged ? path.join(process.resourcesPath,'native-mvp/native-video.exe') : path.resolve(__dirname,'../../native/bin/native-video.exe');
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(runtime,'bin/gstreamer-1.0-0.dll')))
    throw new Error('Compile o MVP e prepare o SDK: npm run setup:native-mvp e npm run build:native-mvp.');
  const network=createIceSettings({directory:app.getPath('userData'),storage:safeStorage});
  delete process.env.SELF_LIVE_TURN_SECRET;
  native = new NativeVideo({executable,runtime,registry:path.join(app.getPath('userData'),'gstreamer-registry.bin')});
  native.on('event',value=>{if(!['offer','ice','peer-state'].includes(value.type))publish(value);});
  native.on('exit',() => publish({type:'error',message:'O motor C++ encerrou. Reinicie o MVP.'}));
  server = await createViewerServer({native,onEvent:publish,relayConfig:readRelayConfig(process.env,'native-mvp'),iceProvider:()=>network.configuration()});
  ipcMain.handle('native-mvp-network',event=>{trusted(event);return network.snapshot();});
  ipcMain.handle('native-mvp-network-save',(event,value)=>{trusted(event);if(phase!=='idle')throw new Error('Pare a captura para alterar a rede.');return network.save(value);});
  ipcMain.handle('native-mvp-sources',event => { trusted(event); return native.request('list'); });
  ipcMain.handle('native-mvp-start',async (event,value) => {
    trusted(event);
    if (phase !== 'idle') throw new Error('Pare a captura atual antes de iniciar outra.');
    if (!value || !/^\d{1,20}$/.test(value.window) || ![30,60].includes(value.fps) || ![720,1080].includes(value.height) ||
      !Number.isInteger(value.bitrateKbps) || value.bitrateKbps < 1000 || value.bitrateKbps > 20000 ||
      !Number.isInteger(value.adapter) || value.adapter < -1 || value.adapter > 16 || typeof value.gpuPriority !== 'boolean' || typeof value.logging !== 'boolean') throw new Error('Configuracao invalida.');
    phase = 'starting';
    try {
      network.configuration();
      const result = await native.request('start',{window:value.window,fps:value.fps,height:value.height,bitrateKbps:value.bitrateKbps,adapter:value.adapter,gpuPriority:value.gpuPriority});
      recording = value.logging;
      const log = recording ? audit.start({width:result.width,height:result.height,fps:result.fps,bitrateKbps:value.bitrateKbps,gpuPriorityRequested:value.gpuPriority,encoder:result.encoder,adapter:result.adapter,adapterLuid:result.adapterLuid,capture:result.capture,memory:result.memory,
        turnConfigured:network.snapshot().hasCredential,icePolicy:network.snapshot().forceRelay?'relay':'all'}) : null;
      phase = 'streaming'; return {...result,...server.activate(),log};
    } catch (error) { phase = 'idle'; recording = false; await native.request('stop').catch(() => {}); throw error; }
  });
  ipcMain.handle('native-mvp-stop',async event => {
    trusted(event); if (phase === 'starting') throw new Error('Aguarde o inicio da captura.');
    phase = 'stopping'; server.deactivate();
    try { await native.request('stop'); } finally { phase = 'idle'; recording = false; audit.stop(); }
  });
  async function openViewer(url) {
    if (!url) throw new Error('Inicie a captura primeiro.');
    const viewer = new BrowserWindow({width:1100,height:760,title:'Self Live — espectador MVP',backgroundColor:'#10151d',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    viewers.add(viewer); viewer.once('closed',() => {viewers.delete(viewer);server.releaseRemote(url);});
    viewer.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    viewer.webContents.on('will-navigate',(navigation,destination) => { if (destination.split('#')[0] !== url.split('#')[0]) navigation.preventDefault(); });
    await viewer.loadURL(url);
  }
  ipcMain.handle('native-mvp-viewer',event=>{trusted(event);return openViewer(server.info().local);});
  ipcMain.handle('native-mvp-join',(event,invitation)=>{trusted(event);return openViewer(server.remoteViewer(invitation));});
  ipcMain.handle('native-mvp-copy',(event,index) => {
    trusted(event); const info = server.info(); const links = [info.local,...info.lan,...(info.internet?[info.internet]:[])];
    if (!Number.isInteger(index) || !links[index]) throw new Error('Convite indisponivel.');
    clipboard.writeText(links[index]);
  });
  ipcMain.handle('native-mvp-logs',event => { trusted(event); fs.mkdirSync(directory,{recursive:true}); return shell.openPath(directory); });
  window = new BrowserWindow({width:980,height:790,minWidth:760,minHeight:660,title:'Self Live — captura C++',backgroundColor:'#10151d',webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.on('closed',() => { void shutdown(); });
  await window.loadFile(path.join(__dirname,'ui/host.html'));
}).catch(error => { dialog.showErrorBox('Self Live Native MVP',error.message); void shutdown(); });
app.on('before-quit',event => { event.preventDefault(); void shutdown(); });
app.on('window-all-closed',() => { void shutdown(); });

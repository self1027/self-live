const { app, BrowserWindow } = require('electron');
const childProcess = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const profile=process.env.SELF_LIVE_MVP_TEST_PROFILE || path.join(require('node:os').tmpdir(),`self-live-native-profile-${process.pid}`);
fs.mkdirSync(path.join(profile,'SelfLive-NativeMVP'),{recursive:true});
fs.mkdirSync(path.join(profile,'Documents'),{recursive:true});
const originalGetPath=app.getPath.bind(app);
app.getPath=name=>name==='appData'?profile:name==='documents'?path.join(profile,'Documents'):originalGetPath(name);
const helpers = [], spawn = childProcess.spawn;
let viewerServer;
const serverModule=require('../src/native-mvp/server'),originalServer=serverModule.createViewerServer;
serverModule.createViewerServer=async options=>{viewerServer=await originalServer(options);return viewerServer;};
childProcess.spawn = function(file,...args) { const child = spawn(file,...args); if (/native-video\.exe$/i.test(file)) { helpers.push(child.pid); child.stderr.on('data',chunk=>process.stderr.write(chunk)); } return child; };
if (process.env.SELF_LIVE_MVP_TEST_RUNTIME) {
  const controller = require('../src/native-mvp/controller'), Original = controller.NativeVideo;
  controller.NativeVideo = class extends Original { constructor(options) { super({...options,runtime:path.resolve(process.env.SELF_LIVE_MVP_TEST_RUNTIME),
    ...(process.env.SELF_LIVE_MVP_TEST_EXECUTABLE ? {executable:path.resolve(process.env.SELF_LIVE_MVP_TEST_EXECUTABLE)} : {}),
    registry:path.join(require('node:os').tmpdir(),`self-live-mvp-smoke-registry-${process.pid}.bin`)}); } };
}
require('../src/native-mvp/main');
childProcess.spawn = spawn;
app.on('browser-window-created',(_event,window) => {
  window.webContents.on('did-finish-load',() => {
    if (window.webContents.getURL().includes('/host.html')) process.send({type:'ready'});
  });
});
process.on('message',async message => {
  try {
    const window = BrowserWindow.getAllWindows().find(window => message.target === 'viewer' ? window.webContents.getURL().includes('/viewer') : window.webContents.getURL().includes('/host.html'));
    let result;
    if (message.type === 'evaluate') result = await window.webContents.executeJavaScript(message.code,true);
    else if (message.type === 'screenshot') { const image = await window.webContents.capturePage(); fs.writeFileSync(message.code,image.toPNG()); }
    else if (message.type === 'helpers') result = helpers;
    else if (message.type === 'invitation') result=viewerServer.info().internet;
    else if(message.type==='network-summary') {
      const folder=path.join(app.getPath('documents'),'SelfLive-NativeMVP-Logs');
      const rows=fs.existsSync(folder)?fs.readdirSync(folder).filter(file=>file.endsWith('.jsonl')).flatMap(file=>fs.readFileSync(path.join(folder,file),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)):[];
      result={candidates:rows.filter(row=>row.type==='ice-candidates').at(-1)?.counts,mediaPaths:[...new Set(rows.filter(row=>row.type==='receiver-sample').map(row=>row.transport?.mode).filter(Boolean))]};
    }
    else if (message.type === 'close-viewer') window.close();
    else if (message.type === 'quit') { process.send({id:message.id,ok:true}); app.quit(); return; }
    process.send({id:message.id,ok:true,result});
  } catch(error) { process.send({id:message.id,ok:false,error:error.stack}); }
});

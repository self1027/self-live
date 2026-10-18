const { app, BrowserWindow } = require('electron');
const childProcess = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const helpers = [], spawn = childProcess.spawn;
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
    else if (message.type === 'close-viewer') window.close();
    else if (message.type === 'quit') { process.send({id:message.id,ok:true}); app.quit(); return; }
    process.send({id:message.id,ok:true,result});
  } catch(error) { process.send({id:message.id,ok:false,error:error.stack}); }
});

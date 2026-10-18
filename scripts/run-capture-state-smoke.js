if (!process.versions.electron) {
  const {spawnSync}=require('node:child_process');
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'self-live-capture-state-'));
  const env={...process.env,SELF_LIVE_CAPTURE_STATE_SMOKE_PROFILE:root};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit',timeout:15000});
  if(result.error)console.error(result.error.message);
  // A fresh directory created above is the only cleanup target.
  fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  process.exitCode=result.status ?? 1;
} else {
  const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
  const {createCaptureState}=require('../src/main/capture-state');
  app.on('window-all-closed',()=>{});
  app.setPath('userData',process.env.SELF_LIVE_CAPTURE_STATE_SMOKE_PROFILE);
  app.whenReady().then(async()=>{
    const window=new BrowserWindow({show:false});
    const handle=window.getNativeWindowHandle().readBigUInt64LE().toString();
    const source=`window:${handle}:0`,state=createCaptureState({app});
    const hidden=await state.sample(source);assert.equal(hidden.exists,true);assert.equal(hidden.visible,false);
    window.minimize();window.hide();
    const minimized=await state.sample(source);assert.equal(minimized.minimized,true);
    window.destroy();
    const closed=await state.sample(source);assert.equal(closed.exists,false);
    console.log('Native source state:',JSON.stringify({hidden,minimized,closed}));
    app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}

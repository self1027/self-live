// Hidden, isolated Electron instance. Exercises real Windows calls and readback;
// no game, capture, user settings or production logs are touched.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env,windowsHide:true,stdio:'inherit',timeout:25000 });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const assert = require('node:assert/strict');
  const { createGpuPriority } = require('../src/main/gpu-priority');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'self-live-gpu-priority-'));
  app.setPath('userData',root);
  let controller, window;
  app.whenReady().then(async () => {
    window = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
    await window.loadURL('data:text/html,<title>GPU priority smoke</title>');
    await window.webContents.executeJavaScript(`(() => {
      const canvas = document.createElement('canvas'); document.body.append(canvas);
      const gl = canvas.getContext('webgl'); if (gl) { gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
    })()`);
    await app.getGPUInfo('complete');
    controller = createGpuPriority({app});
    let enabled = await controller.setEnabled(true);
    for (let attempt=0; attempt<10 && !enabled.targets.some(target=>target.type === 'GPU'); attempt++) {
      await new Promise(resolve=>setTimeout(resolve,200));
      await controller.refresh(); enabled = controller.snapshot();
    }
    console.log('GPU priority ON:',JSON.stringify(enabled));
    assert.ok(enabled.targets.some(target=>target.type === 'GPU'));
    assert.ok(enabled.targets.every(target=>['applied','already_high','set_failed','open_failed','query_failed'].includes(target.status)));
    for (const target of enabled.targets) if (target.status === 'applied') assert.equal(target.effective,4);
    const disabled = await controller.setEnabled(false);
    console.log('GPU priority OFF:',JSON.stringify(disabled));
    assert.equal(disabled.state,'disabled');
    for (const target of disabled.targets) if (target.status === 'applied') {
      assert.equal(target.restore.status,'restored'); assert.equal(target.restore.effective,target.original);
    }
    console.log('GPU priority native smoke passed (API acceptance is reported above; fluidity requires a loaded-game test).');
  }).then(()=>finish(0),error=>{console.error(error); void finish(1);});
  async function finish(code) {
    await controller?.setEnabled(false);
    window?.destroy();
    // Chromium may still hold profile files until process exit.
    app.once('will-quit',()=>{try { fs.rmSync(root,{recursive:true,force:true}); } catch { /* Temporary profile only. */ }});
    app.exit(code);
  }
}

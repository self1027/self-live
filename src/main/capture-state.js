const { execFile } = require('node:child_process');
const path = require('node:path');

function createCaptureState({ app, run = execFile, platform = process.platform }) {
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'capture-state/capture-state.exe') :
    path.join(__dirname, '../../native/bin/capture-state.exe');
  let source, owner, pending;
  return {
    async sample(id) {
      const kind = id?.startsWith('window:') ? 'window' : id?.startsWith('screen:') ? 'screen' : 'unknown';
      if (kind !== 'window' || platform !== 'win32') return { kind, available:false };
      const match = /^window:(\d+):\d+$/.exec(id);
      if (!match) return { kind, available:false };
      if (source !== id) { source = id; owner = null; pending = null; }
      if (pending) return pending;
      const operation = new Promise(resolve => run(executable, [match[1]], { windowsHide:true,timeout:1500,maxBuffer:2048 }, (error, output) => {
        if (error) { resolve({kind,available:false}); return; }
        try {
          const value = JSON.parse(output);
          if (source !== id || value.available !== true || typeof value.exists !== 'boolean') { resolve({kind,available:false}); return; }
          if (value.exists && (!Number.isInteger(value.owner) || value.owner <= 0)) { resolve({kind,available:false}); return; }
          if (owner && value.exists && owner !== value.owner) { resolve({kind,available:true,exists:false}); return; }
          if (value.exists) owner = value.owner;
          resolve({kind,available:true,exists:value.exists,
            ...(value.exists ? {minimized:value.minimized === true,visible:value.visible === true,focused:value.focused === true} : {})});
        } catch { resolve({kind,available:false}); }
      }));
      pending = operation;
      try { return await operation; } finally { if (pending === operation) pending = null; }
    }
  };
}
module.exports = { createCaptureState };

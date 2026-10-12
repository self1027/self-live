const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'self-live-pilot-electron-'));
async function launch(phase) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('SELF_LIVE_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  env.SELF_LIVE_RELAY_URL = ''; // QA local, sem conexões à VPS.
  if (process.argv.includes('--capture')) env.SELF_LIVE_CAPTURE_QA = '1';
  await new Promise((resolve, reject) => {
    const args = [path.join(__dirname, 'pilot-smoke-peer.js'), profile, phase];
    if (process.argv.includes('--packaged')) args.push(path.resolve(__dirname, '../dist/win-unpacked/resources/app.asar/src/main/main.js'));
    const child = spawn(electron, args, { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout do piloto')); }, 25000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Piloto terminou com ${code}`)); });
  });
}
(async () => { await launch('save'); await launch('restore'); })().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(profile, { recursive: true, force: true }));

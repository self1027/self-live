const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-live-p2p-'));
const ready = path.join(dir, 'ready.json');
const script = path.join(__dirname, 'p2p-smoke.js');
let host, viewer;
function launch(env) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [script], { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  return child;
}
(async () => {
  host = launch({ SELF_LIVE_SMOKE_ROLE: 'host', SELF_LIVE_SMOKE_READY: ready });
  for (let i = 0; !fs.existsSync(ready) && i < 80; i++) {
    if (host.exitCode !== null) throw new Error('Host encerrou antes de ficar pronto.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!fs.existsSync(ready)) throw new Error('Timeout do host');
  const { url, fingerprint } = JSON.parse(fs.readFileSync(ready, 'utf8'));
  viewer = launch({ SELF_LIVE_SMOKE_ROLE: 'viewer', SELF_LIVE_SMOKE_URL: url, SELF_LIVE_SMOKE_FINGERPRINT: fingerprint });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout do viewer')), 30000);
    viewer.once('error', reject);
    viewer.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  if (code !== 0) throw new Error(`Viewer encerrou com ${code}`);
  console.log('P2P real entre dois processos Electron validado.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  host?.kill(); viewer?.kill();
  if (fs.existsSync(ready)) fs.unlinkSync(ready);
  fs.rmdirSync(dir);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createGpuPriority } = require('../src/main/gpu-priority');

function fixture(t, { failedPid, restoreFailure = false, exists = true, platform = 'win32' } = {}) {
  let metrics = [{ pid:100, type:'Browser', creationTime:1700000000000 }, { pid:101, type:'GPU', creationTime:1700000000010 }];
  const calls = [], changes = [];
  const launch = (file, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    const pid = Number(args[0]), fail = pid === failedPid;
    calls.push({ file, args, options, child });
    const send = (phase, status, effective) => child.stdout.write(JSON.stringify({ phase,pid,status,original:2,requested:4,effective,
      ntstatus:fail ? '0xC0000022' : '0x00000000',win32Error:0 }) + '\n');
    const exit = () => { child.exitCode = fail ? 1 : 0; child.stdout.end(); child.emit('close',child.exitCode); };
    queueMicrotask(() => { send('apply',fail ? 'set_failed' : 'applied',fail ? 2 : 4); if (fail) exit(); });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (child.exitCode !== null) return;
      send('restore',restoreFailure ? 'restore_failed' : 'restored',restoreFailure ? 4 : 2); exit();
    }));
    return child;
  };
  const controller = createGpuPriority({ app:{isPackaged:false,getAppMetrics:()=>metrics}, exists:()=>exists,
    platform, launch, intervalMs:60000, timeoutMs:100, onChange:state=>changes.push(state) });
  t.after(()=>controller.setEnabled(false));
  return { controller,calls,changes,setMetrics:value=>{metrics=value;} };
}

test('OFF launches nothing; ON verifies own GPU and browser; OFF restores both priorities', async t => {
  const f = fixture(t);
  await f.controller.refresh(); assert.equal(f.calls.length,0);
  const enabled = await f.controller.setEnabled(true);
  assert.equal(enabled.state,'applied'); assert.equal(f.calls.length,2);
  assert.ok(f.calls.every(call=>call.options.windowsHide && call.args.length === 2));
  await f.controller.refresh(); assert.equal(f.calls.length,2);
  const disabled = await f.controller.setEnabled(false);
  assert.equal(disabled.state,'disabled');
  assert.ok(disabled.targets.every(target=>target.restore.status === 'restored' && target.restore.effective === 2));
});

test('GPU refusal is partial, retains NTSTATUS, and is never reported as full success', async t => {
  const f = fixture(t,{failedPid:101});
  const state = await f.controller.setEnabled(true);
  assert.equal(state.state,'partial');
  assert.equal(state.targets.find(target=>target.type === 'GPU').ntstatus,'0xC0000022');
  await f.controller.refresh(); assert.equal(f.calls.length,2); // No retry/spawn loop for refusal.
});

test('new GPU process gets priority; removed process is restored; unrelated metric types excluded', async t => {
  const f = fixture(t); await f.controller.setEnabled(true);
  f.setMetrics([{pid:102,type:'GPU',creationTime:1700000000020},{pid:999,type:'Unknown',creationTime:1}]);
  await f.controller.refresh();
  const state = f.controller.snapshot();
  assert.equal(state.state,'applied'); assert.deepEqual(state.targets.map(target=>target.pid),[102]);
  assert.equal(f.calls.length,3); assert.ok(f.calls.slice(0,2).every(call=>call.child.exitCode === 0));
});

test('missing helper and unsupported platform never launch native commands', async t => {
  for (const options of [{exists:false},{platform:'linux'}]) {
    const f = fixture(t,options), state = await f.controller.setEnabled(true);
    assert.equal(state.state,options.exists === false ? 'helper_missing' : 'unsupported');
    assert.equal(f.calls.length,0);
  }
});

test('restoration failure is visible and blocks another experiment in the same session', async t => {
  const f = fixture(t,{restoreFailure:true}); await f.controller.setEnabled(true);
  assert.equal((await f.controller.setEnabled(false)).state,'restore_failed');
  assert.equal((await f.controller.setEnabled(true)).state,'restore_failed');
  assert.equal(f.calls.length,2);
});

test('waiting for GPU is explicit and invalid toggles are rejected', async t => {
  const f = fixture(t); f.setMetrics([]);
  assert.equal((await f.controller.setEnabled(true)).state,'waiting_gpu');
  await assert.rejects(f.controller.setEnabled('true'));
});

const { spawn } = require('node:child_process');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { createInterface } = require('node:readline');

// Only processes enumerated by Electron are eligible. The renderer cannot send
// a PID, executable path, priority class or native command.
function createGpuPriority({ app, onChange = () => {}, platform = process.platform,
  launch = spawn, exists = existsSync, intervalMs = 2000, timeoutMs = 3000 }) {
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'gpu-priority', 'gpu-priority.exe') :
    path.join(__dirname, '../../native/bin/gpu-priority.exe');
  let enabled = false, timer, queue = Promise.resolve(), availability = 'ready', lastEmission;
  const targets = new Map();
  const snapshot = () => {
    const rows = [...targets.values()].map(target => ({ ...target.record }));
    const gpu = rows.filter(row => row.type === 'GPU');
    const success = row => ['applied','already_high'].includes(row.status) && !row.restore && !row.restoreFailed;
    const state = !enabled ? rows.some(row => row.restoreFailed) ? 'restore_failed' : 'disabled' :
      availability !== 'ready' ? availability : rows.some(row => row.status === 'pending') ? 'applying' :
      !gpu.length ? 'waiting_gpu' : rows.every(success) ? 'applied' : rows.some(success) ? 'partial' : 'failed';
    return { enabled, state, gpuProcessConfirmed: enabled && gpu.length > 0 && gpu.every(success),
      requestedClass: 'HIGH', scope: 'self_live_processes', targets: rows };
  };
  const emit = () => {
    const state = snapshot(), serialized = JSON.stringify(state);
    if (serialized !== lastEmission) { lastEmission = serialized; onChange(state); }
  };
  const serialize = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
  function startTarget(metric) {
    const target = { key: `${metric.pid}:${metric.creationTime}`, record: { pid: metric.pid, type: metric.type,
      creationTime: metric.creationTime, status: 'pending' }, child: null };
    targets.set(target.key, target);
    target.ready = new Promise(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); resolve(); };
      const deadline = setTimeout(() => {
        target.record.status = 'helper_timeout'; target.child?.stdin.end(); emit(); finish();
      }, timeoutMs);
      try {
        const child = target.child = launch(executable, [String(metric.pid), String(Math.floor(metric.creationTime))],
          { windowsHide: true, stdio: ['pipe','pipe','ignore'] });
        child.stdin.on('error', () => {});
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
          try {
            const data = JSON.parse(line);
            if (data.pid !== metric.pid || !['apply','restore'].includes(data.phase)) return;
            const fields = { status:String(data.status).slice(0,40), original:data.original, requested:data.requested,
              effective:data.effective, ntstatus:data.ntstatus, win32Error:data.win32Error };
            if (data.phase === 'apply') { Object.assign(target.record, fields); finish(); }
            else { target.record.restore = fields; target.record.restoreFailed = !['restored','process_exited','externally_changed'].includes(data.status); }
            emit();
          } catch { /* Invalid helper output cannot mark the experiment successful. */ }
        });
        target.closed = new Promise(done => child.once('close', () => {
          lines.close();
          if (target.record.status === 'pending') target.record.status = 'helper_exited';
          if (target.record.status === 'applied' && !target.record.restore) {
            target.record.restoreFailed = true;
            target.record.restore = { status:'helper_exited_without_restore' };
          }
          emit(); finish(); done();
        }));
        child.once('error', error => {
          target.record.status = error.code === 'ENOENT' ? 'helper_missing' : 'helper_error'; emit(); finish();
        });
      } catch { target.record.status = 'helper_error'; emit(); finish(); }
    });
    return target.ready;
  }
  async function restore(target) {
    if (!target.child || target.child.exitCode !== null || target.child.signalCode) return;
    target.child.stdin.end();
    let deadline;
    await Promise.race([target.closed, new Promise(resolve => { deadline = setTimeout(() => {
      target.record.restoreFailed = true; target.record.restore = { status:'restore_timeout' }; emit(); resolve();
    }, timeoutMs); })]);
    clearTimeout(deadline);
  }
  async function refresh() {
    if (!enabled || availability !== 'ready') return;
    let metrics;
    try { metrics = app.getAppMetrics(); } catch { availability = 'metrics_unavailable'; emit(); return; }
    const eligible = metrics.filter(metric => ['Browser','GPU','Tab','Utility'].includes(metric.type) &&
      Number.isInteger(metric.pid) && metric.pid > 0 && Number.isFinite(metric.creationTime) && metric.creationTime > 0);
    const current = new Set(eligible.map(metric => `${metric.pid}:${metric.creationTime}`));
    for (const [key, target] of targets) if (!current.has(key)) { await restore(target); targets.delete(key); }
    await Promise.all(eligible.filter(metric => !targets.has(`${metric.pid}:${metric.creationTime}`)).map(startTarget));
    emit();
  }
  return {
    snapshot,
    refresh: () => serialize(refresh),
    setEnabled: value => serialize(async () => {
      if (typeof value !== 'boolean') throw new Error('Prioridade de GPU: valor inválido.');
      if (enabled === value && (value || !targets.size)) return snapshot();
      clearInterval(timer); timer = null;
      enabled = false;
      await Promise.all([...targets.values()].map(restore));
      if (value) {
        if ([...targets.values()].some(target => target.record.restoreFailed)) { emit(); return snapshot(); }
        targets.clear(); enabled = true;
        availability = platform !== 'win32' ? 'unsupported' : !exists(executable) ? 'helper_missing' : 'ready';
        await refresh();
        if (availability === 'ready') { timer = setInterval(() => { void serialize(refresh).catch(() => {}); }, intervalMs); timer.unref?.(); }
      }
      emit(); return snapshot();
    })
  };
}
module.exports = { createGpuPriority };

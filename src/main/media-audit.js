const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sampleGPU } = require('./gpu-audit');
const numeric = new Set(['framesPerSecond','width','height','frameWidth','frameHeight','framesEncoded','framesSent','framesDecoded','framesDropped','freezeCount','totalFreezesDuration','packetsLost','fractionLost','jitter','roundTripTime','totalEncodeTime','totalDecodeTime','qpSum','sendKbps','receiveKbps','encodedFps','sentFps','decodedFps','encodeMs','decodeMs','sendDelayMs']);
const enums = { type: ['outbound-rtp','inbound-rtp','media-source','remote-inbound-rtp'], limitation: ['none','cpu','bandwidth','other'], encoder: ['software','hardware-or-external','unknown'] };
numeric.add('limitationCpuSeconds'); numeric.add('limitationBandwidthSeconds');
function cleanSample(value) {
  const result = { capture: {} , connections: [] };
  for (const key of ['width','height','frameRate','bitrate','viewers']) if (Number.isFinite(value?.capture?.[key]) && value.capture[key] >= 0) result.capture[key] = value.capture[key];
  result.capture.previewVisible = value?.capture?.previewVisible === true;
  result.capture.loopbackActive = value?.capture?.loopbackActive === true;
  for (const connection of (Array.isArray(value?.connections) ? value.connections : []).slice(0,30)) {
    const safe = { viewer: Number.isInteger(connection?.viewer) && connection.viewer > 0 ? connection.viewer : 0, rows: [] };
    if (['direct','relay','unknown'].includes(connection?.transport?.mode)) safe.transport = {
      mode:connection.transport.mode, family:['IPv4','IPv6'].includes(connection.transport.family) ? connection.transport.family : null,
      rttMs:Number.isFinite(connection.transport.rttMs) && connection.transport.rttMs >= 0 ? connection.transport.rttMs : null };
    for (const row of (Array.isArray(connection?.rows) ? connection.rows : []).slice(0,8)) {
      if (!enums.type.includes(row?.type)) continue;
      const fields = { type: row.type };
      for (const key of numeric) if (Number.isFinite(row[key]) && row[key] >= 0) fields[key] = Math.round(row[key] * 1000) / 1000;
      for (const [key, allowed] of Object.entries(enums)) if (allowed.includes(row[key])) fields[key] = row[key];
      if (typeof row.hardwareEfficient === 'boolean') fields.hardwareEfficient = row.hardwareEfficient;
      safe.rows.push(fields);
    }
    result.connections.push(safe);
  }
  return result;
}
function createMediaAudit({ app, env = process.env, directory, maxBytes = 5 * 1024 * 1024, keep = 10 }) {
  const preferred = directory || (app.isPackaged ? env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')) : app.getAppPath());
  let file, size = 0, last = 0, truncated = false, gpuQuery, gpuDisabled = false, lastGPU = 0;
  function write(type, data = {}) {
    if (!file) return;
    const line = JSON.stringify({ time: new Date().toISOString(), type, ...data }) + '\n';
    try { fs.appendFileSync(file, line); size += Buffer.byteLength(line); }
    catch { file = null; }
  }
  function stop(reason = 'stopped') { write('end', { reason: ['stopped','shutdown','restarted'].includes(reason) ? reason : 'stopped' }); file = null; gpuQuery?.kill(); gpuQuery = null; }
  return {
    start(value) {
      stop('restarted'); size = 0; last = 0; truncated = false; lastGPU = 0; gpuDisabled = false;
      const name = `self-live-audit-${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}.jsonl`;
      let fallback = false;
      try { fs.mkdirSync(preferred,{recursive:true}); file = path.join(preferred,name); fs.writeFileSync(file,'',{mode:0o600}); }
      catch {
        try { const alternate = path.join(app.getPath('userData'),'audit'); fs.mkdirSync(alternate,{recursive:true}); file = path.join(alternate,name); fs.writeFileSync(file,'',{mode:0o600}); fallback = true; }
        catch { file = null; return { enabled:false }; }
      }
      // Delete only our generated audit files, never arbitrary logs or user files.
      try { const folder = path.dirname(file); const files = fs.readdirSync(folder).filter(name => /^self-live-audit-\d{4}-\d{2}-\d{2}T[\dTZ-]+-\d+\.jsonl$/.test(name)).sort().reverse();
        for (const old of files.slice(keep)) if (path.join(folder,old) !== file) fs.unlinkSync(path.join(folder,old)); } catch { /* Logging remains available. */ }
      write('start', { schema:1, version:app.getVersion(), electron:process.versions.electron, chromium:process.versions.chrome,
        windows:os.release(), arch:process.arch, cpuThreads:os.cpus().length, ramGiB:Math.round(os.totalmem()/1073741824),
        capture:cleanSample({capture:value}).capture, sampleIntervalMs:2000, gpuIntervalMs:10000, maxBytes,
        policy:{contentHint:'motion',degradationPreference:'maintain-resolution',senderMaxFramerate:60,captureCpuLimit:100} });
      const current = file;
      Promise.resolve(app.getGPUInfo?.('basic')).then(info => {
        if (!file || file !== current) return;
        const adapters = (info?.gpuDevice || []).map(device => ({ vendorId:device.vendorId, deviceId:device.deviceId, active:device.active === true })).slice(0,4);
        const driver = info?.auxAttributes?.driverVersion;
        write('gpu', { adapters, driverVersion:typeof driver === 'string' && /^[\d. -]{1,64}$/.test(driver) ? driver : null,
          features:Object.fromEntries(Object.entries(app.getGPUFeatureStatus?.() || {}).filter(([key, status]) => ['video_encode','video_decode','gpu_compositing'].includes(key) && ['enabled','disabled_software','unavailable_software','disabled_off','unavailable_off'].includes(status))) });
      }).catch(()=>{});
      return { enabled:true, name, fallback };
    },
    sample(value) {
      if (!file || truncated || Date.now()-last < 1500) return;
      last = Date.now();
      if (size > maxBytes - 65536) { write('limit', { reason:'size_limit' }); truncated = true; return; }
      const data = cleanSample(value);
      try { data.processes = app.getAppMetrics().map(metric => ({ type:['Browser','GPU','Tab','Utility'].includes(metric.type) ? metric.type : 'Other',
        cpuPercent:Number.isFinite(metric.cpu?.percentCPUUsage) ? metric.cpu.percentCPUUsage : null,
        memoryMiB:Number.isFinite(metric.memory?.workingSetSize) ? Math.round(metric.memory.workingSetSize/1024) : null })).slice(0,40); } catch { /* Optional platform metrics. */ }
      write('sample', data);
      if (process.platform === 'win32' && !gpuDisabled && !gpuQuery && Date.now()-lastGPU >= 10000) {
        lastGPU = Date.now(); const current = file, queryStart = lastGPU;
        gpuQuery = sampleGPU(engines => {
          if (file !== current) return;
          gpuQuery = null; gpuDisabled = !engines;
          if (file && !truncated) write('gpu-load', { available:Boolean(engines), queryMs:Date.now()-queryStart, busiestEnginePercent:engines });
        });
      }
    }, stop
  };
}
module.exports = { createMediaAudit, cleanSample };

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sampleGPU } = require('./gpu-audit');
const numeric = new Set(['framesPerSecond','width','height','frameWidth','frameHeight','framesEncoded','framesSent','framesDecoded','framesDropped','freezeCount','totalFreezesDuration','packetsLost','fractionLost','jitter','roundTripTime','totalEncodeTime','totalDecodeTime','qpSum','sendKbps','receiveKbps','encodedFps','sentFps','decodedFps','encodeMs','decodeMs','sendDelayMs']);
const enums = { type: ['outbound-rtp','inbound-rtp','media-source','remote-inbound-rtp'], limitation: ['none','cpu','bandwidth','other'], encoder: ['software','hardware-or-external','unknown'] };
numeric.add('limitationCpuSeconds'); numeric.add('limitationBandwidthSeconds');
numeric.add('frames');
function cleanLifecycle(value) {
  if (!value) return undefined;
  const state = value.source || {};
  return {status:['live','background','waiting','recovering'].includes(value.status) ? value.status : 'waiting',
    reason:['minimized','hidden','unfocused','source_missing','track_ended','track_muted','no_frames','awaiting_frames','retry_failed'].includes(value.reason) ? value.reason : null,
    trackMuted:value.trackMuted === true,trackState:['live','ended'].includes(value.trackState) ? value.trackState : 'unknown',
    suppressAdaptive:value.suppressAdaptive === true,source:{kind:['screen','window'].includes(state.kind) ? state.kind : 'unknown',
      available:state.available === true,...Object.fromEntries(['exists','minimized','visible','focused'].map(key=>[key,typeof state[key] === 'boolean' ? state[key] : null]))}};
}
function cleanSample(value) {
  const result = { capture: {} , connections: [] };
  for (const key of ['width','height','frameRate','bitrate','viewers']) if (Number.isFinite(value?.capture?.[key]) && value.capture[key] >= 0) result.capture[key] = value.capture[key];
  result.capture.previewVisible = value?.capture?.previewVisible === true;
  result.capture.loopbackActive = value?.capture?.loopbackActive === true;
  for (const key of ['captureGap','framesCaptured','framesDropped','framesStalled','observedFps']) result[key] = Number.isFinite(value?.[key]) && value[key] >= 0 ? value[key] : null;
  result.captureStall = typeof value?.captureStall === 'boolean' ? value.captureStall : null;
  result.captureLifecycle = cleanLifecycle(value?.captureLifecycle);
  const mode = value?.captureMode || {};
  result.captureMode = {};
  for (const key of ['originalResolution','effectiveResolution']) result.captureMode[key] = /^\d{1,5}x\d{1,5}$/.test(mode[key] || '') ? mode[key] : null;
  result.captureMode.downscaled = mode.downscaled === true;
  result.captureMode.reason = mode.reason === 'fhd_cap' ? 'fhd_cap' : mode.reason === 'quality' ? 'quality' : null;
  result.captureMode.frameRate = [15,20,30,45,60].includes(mode.frameRate) ? mode.frameRate : null;
  result.captureMode.source = ['screen','window'].includes(mode.source) ? mode.source : null;
  result.captureMode.mode = 'gpu'; // No supported hot CPU-capture switch exists in this pipeline.
  result.captureMode.previewHidden = mode.previewHidden === true;
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
function saturation(engines) {
  return Object.fromEntries(['3D','Copy','VideoEncode','VideoDecode'].map(key => [key,
    !Number.isFinite(engines?.[key]) ? 'unknown' : engines[key] > 90 ? 'saturated' : engines[key] > 70 ? 'high' : engines[key] > 40 ? 'medium' : 'low']));
}
function createMediaAudit({ app, directory, enabled = false, maxBytes = 10 * 1024 * 1024, keep = 5, clock = Date.now, gpuSampler = sampleGPU, platform = process.platform,
  gpuPriorityProvider = () => ({ enabled:false, state:'disabled', targets:[] }) }) {
  const folder = directory || path.join(app.getPath('documents'), 'SelfLive-Logs');
  let file, size = 0, sequence = 0, active = false, last = -Infinity, lastGPU = -Infinity, gpuQuery, generation = 0;
  let gpu = null, gpuTime = null, samples = [], totalSamples = 0, configuration = {}, degradeEvents = 0, recoverEvents = 0, stallEvents = 0, previousStall = false;
  let sums = {}, maxGpu = null;
  let recordedDuringSession = false, capturedAdaptive = null;
  let initialGpuPriority = null, gpuPriorityEvents = [], captureStateEvents = [];
  const stamp = () => new Date(clock()).toISOString().replace(/[:.]/g, '-');
  function open() {
    fs.mkdirSync(folder, { recursive: true });
    file = path.join(folder, `diagnostic-${stamp()}-${process.pid}-${String(++sequence).padStart(6,'0')}.jsonl`);
    fs.writeFileSync(file, '', { mode: 0o600 }); size = 0;
    const files = fs.readdirSync(folder).filter(name => /^diagnostic-\d{4}-\d{2}-\d{2}T[\dTZ-]+-\d+-\d+\.jsonl$/.test(name)).sort().reverse();
    for (const old of files.slice(keep)) if (path.join(folder,old) !== file) fs.unlinkSync(path.join(folder, old));
  }
  function write(type, data = {}) {
    if (!enabled || !active) return;
    const line = JSON.stringify({ time: new Date(clock()).toISOString(), type, ...data }) + '\n';
    try {
      if (!file || size + Buffer.byteLength(line) > maxBytes) open();
      if (Buffer.byteLength(line) > maxBytes) return;
      fs.appendFileSync(file, line); size += Buffer.byteLength(line);
    } catch { file = null; }
  }
  function stop(reason = 'stopped') {
    write('end', { reason: ['stopped','shutdown','restarted'].includes(reason) ? reason : 'stopped' });
    active = false; file = null; generation++; gpuQuery?.kill(); gpuQuery = null;
  }
  const add = (key, value) => { if (Number.isFinite(value)) { sums[key] ||= { sum: 0, count: 0 }; sums[key].sum += value; sums[key].count++; } };
  const average = key => sums[key]?.count ? sums[key].sum / sums[key].count : null;
  const service = {
    start(value) {
      stop('restarted'); active = true; samples = []; totalSamples = 0; sums = {}; gpu = null; gpuTime = null; maxGpu = null;
      degradeEvents = recoverEvents = stallEvents = 0; previousStall = false; last = lastGPU = -Infinity;
      recordedDuringSession = enabled; capturedAdaptive = null;
      initialGpuPriority = gpuPriorityProvider(); gpuPriorityEvents = [];
      captureStateEvents = [];
      configuration = cleanSample(value).captureMode;
      write('start', { schema:3, version:app.getVersion(), windows:os.release(), gpuPriority:initialGpuPriority, capture:cleanSample({capture:value}).capture,
        captureMode:configuration, sampleIntervalMs:2000, gpuIntervalMs:10000, maxBytes });
      if (enabled) {
        const token = generation;
        Promise.resolve(app.getGPUInfo?.('basic')).then(info => {
          if (!enabled || !active || generation !== token) return;
          const driver = info?.auxAttributes?.driverVersion;
          write('hardware', { electron:process.versions.electron, chromium:process.versions.chrome,
            cpuThreads:os.cpus().length, ramGiB:Math.round(os.totalmem()/1073741824),
            adapters:(info?.gpuDevice || []).slice(0,4).map(device=>({vendorId:device.vendorId,deviceId:device.deviceId,active:device.active === true})),
            driverVersion:typeof driver === 'string' && /^[\d. -]{1,64}$/.test(driver) ? driver : null });
        }).catch(()=>{});
      }
      return { enabled: Boolean(enabled && file), name:file ? path.basename(file) : null };
    },
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new Error('Logs: valor inválido.');
      if (!value) { write('end', { reason:'logging_disabled' }); enabled = false; file = null; }
      else { enabled = true; if (active) recordedDuringSession = true; if (active && !file) write('start', { schema:3, gpuPriority:gpuPriorityProvider(), captureMode:configuration, sampleIntervalMs:2000, gpuIntervalMs:10000 }); }
      return { enabled, recording: Boolean(file) };
    },
    pauseSampling() { generation++; gpuQuery?.kill(); gpuQuery = null; gpu = null; gpuTime = null; lastGPU = -Infinity; },
    sample(value, { adaptive = false } = {}) {
      if (!active || (!enabled && !adaptive)) {
        gpuQuery?.kill(); gpuQuery = null; gpu = null; gpuTime = null;
        return { available:false, busiestEnginePercent:null, engineSaturation:saturation(null) };
      }
      const now = clock();
      if (now - last < 1500) return { available:Boolean(gpu), busiestEnginePercent:gpu, gpuTime, engineSaturation:saturation(gpu) };
      last = now;
      const currentGeneration = generation;
      if (platform === 'win32' && !gpuQuery && now - lastGPU >= 10000) {
        lastGPU = now;
        gpuQuery = gpuSampler(engines => {
          if (!active || generation !== currentGeneration) return;
          gpuQuery = null; gpu = engines; gpuTime = clock();
          write('gpu-load', { available:Boolean(engines), queryMs:clock()-now, busiestEnginePercent:engines, engineSaturation:saturation(engines) });
        });
      }
      const fresh = gpuTime !== null && now - gpuTime <= 15000 ? gpu : null;
      const data = { ...cleanSample(value), busiestEnginePercent:fresh, gpuTime, gpuAgeMs:gpuTime === null ? null : now-gpuTime,
        gpuScope:'system_busiest_engine', engineSaturation:saturation(fresh) };
      if (enabled) {
        data.gpuPriority = gpuPriorityProvider();
        try { data.processes = app.getAppMetrics().map(metric => ({ type:['Browser','GPU','Tab','Utility'].includes(metric.type) ? metric.type : 'Other',
          cpuPercent:Number.isFinite(metric.cpu?.percentCPUUsage) ? metric.cpu.percentCPUUsage : null,
          memoryMiB:Number.isFinite(metric.memory?.workingSetSize) ? Math.round(metric.memory.workingSetSize/1024) : null })).slice(0,40); } catch { /* Optional platform metrics. */ }
        const record = { time:new Date(now).toISOString(), ...data }; samples.push(record); if (samples.length > 1000) samples.shift(); totalSamples++;
        configuration = data.captureMode;
        capturedAdaptive = adaptive;
        add('source', data.observedFps);
        const rows = data.connections.flatMap(connection => connection.rows);
        const outbound = rows.filter(row => row.type === 'outbound-rtp');
        // Average connections within a sample before averaging samples.
        for (const [key, field] of [['outbound','sentFps'],['encode','encodeMs']]) {
          const values = outbound.map(row => row[field]).filter(Number.isFinite); if (values.length) add(key, values.reduce((a,b)=>a+b,0)/values.length);
        }
        if (Number.isFinite(fresh?.['3D'])) { add('gpu',fresh['3D']); maxGpu = Math.max(maxGpu ?? 0, fresh['3D']); }
        if (data.captureStall && !previousStall) stallEvents++; previousStall = data.captureStall === true;
      }
      write('sample', data);
      return { available:Boolean(fresh), busiestEnginePercent:fresh, gpuTime, gpuAgeMs:data.gpuAgeMs, engineSaturation:data.engineSaturation };
    },
    event(value) {
      if (value?.action === 'capture_state') {
        const captureLifecycle = cleanLifecycle(value.captureLifecycle);
        if (!captureLifecycle || !active || !enabled) return;
        captureStateEvents.push({time:new Date(clock()).toISOString(),captureLifecycle});
        if (captureStateEvents.length > 100) captureStateEvents.shift();
        write('capture-state',{captureLifecycle}); return;
      }
      if (!['degrade','recover','manual','capture_error','cpu_unsupported'].includes(value?.action)) return;
      const data = { action:value.action, ...cleanSample({ captureMode:value.captureMode }).captureMode };
      if (value.captureMode) configuration = cleanSample({captureMode:value.captureMode}).captureMode;
      if (enabled) { if (value.action === 'degrade') degradeEvents++; if (value.action === 'recover') recoverEvents++; }
      write('adjustment', data);
    },
    gpuPriorityChanged(state) {
      if (!active || !enabled) return;
      const record = { time:new Date(clock()).toISOString(), gpuPriority:state };
      gpuPriorityEvents.push(record); if (gpuPriorityEvents.length > 100) gpuPriorityEvents.shift();
      write('gpu-priority', { gpuPriority:state });
    },
    exportReport(options = {}) {
      fs.mkdirSync(folder, { recursive:true });
      const report = { experimentName:'gpu-contention-test', configuration:{ resolution:configuration.effectiveResolution,
        originalResolution:configuration.originalResolution, frameRate:configuration.frameRate, previewHidden:configuration.previewHidden,
        captureMode:'gpu', gpuPriorityEnabled:initialGpuPriority?.enabled === true, gpuPriority:initialGpuPriority,
        adaptiveQuality:(capturedAdaptive ?? options.adaptiveQuality) === true ? 'on' : 'off', loggingEnabled:recordedDuringSession, fhdCapApplied:configuration.reason === 'fhd_cap' },
        gpuPriorityEvents,
        captureStateEvents,
        samples, samplesTruncated:totalSamples > samples.length, totalSamples,
        summary:{ avgMediaSourceFps:average('source'), avgOutboundFps:average('outbound'), avgEncodeMs:average('encode'),
          maxGpu3DPercent:maxGpu, avgGpu3dPercent:average('gpu'), stallEvents, degradeEvents, recoverEvents } };
      const destination = path.join(folder, `experiment-${stamp()}-${process.pid}-${++sequence}.json`);
      fs.writeFileSync(destination, JSON.stringify(report,null,2), { mode:0o600 });
      return { name:path.basename(destination), samples:samples.length };
    },
    directory:folder, stop
  };
  return service;
}
module.exports = { createMediaAudit, cleanSample, saturation };

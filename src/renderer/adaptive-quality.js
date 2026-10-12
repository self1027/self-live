import { captureSize } from './capture-quality.js';
// Pure policy. A change is committed only after capture constraints succeed.
export function createAdaptiveQuality(base, original = { width:1920, height:1080 }) {
  const baseline = { resolution:base.resolution || 'auto', frameRate:Number(base.frameRate) || 60, previewHidden:base.previewHidden === true };
  const ladder = [baseline];
  const initial = captureSize(original.width, original.height, baseline.resolution);
  const eligible = baseline.frameRate >= 20 && initial.height >= Math.min(540, original.height);
  if (eligible) {
    const push = state => ladder.push({ ...ladder.at(-1), ...state });
    if (!baseline.previewHidden) push({ previewHidden:true });
    for (const fps of [45,30,20]) if (fps < baseline.frameRate) push({ frameRate:fps });
    for (const resolution of ['1920x1080','1280x720','960x540']) {
      const current = captureSize(original.width, original.height, ladder.at(-1).resolution);
      const next = captureSize(original.width, original.height, resolution);
      if (next.width <= current.width && next.height <= current.height && (next.width < current.width || next.height < current.height)) push({ resolution });
    }
  }
  let index = 0, count = 0, saturated = 0, stalled = 0, recovery = 0, lastChange = -Infinity;
  return {
    eligible,
    current: () => ({ ...ladder[index] }),
    observe(sample, now = Date.now()) {
      const gpu = sample?.busiestEnginePercent?.['3D'];
      const fresh = Number.isFinite(gpu) && (sample.gpuAgeMs == null || sample.gpuAgeMs <= 15000);
      saturated = fresh && gpu >= 90 ? saturated + 1 : 0;
      stalled = sample.captureStall === true ? stalled + 1 : 0;
      recovery = fresh && gpu <= 60 && sample.captureStall === false ? recovery + 1 : 0;
      count++;
      if (!eligible || count % 4 || now - lastChange < 10000) return null;
      if (saturated >= 3 && stalled >= 2 && index < ladder.length - 1) return { action:'degrade', index:index+1, settings:{...ladder[index+1]} };
      if (recovery >= 6 && index > 0) return { action:'recover', index:index-1, settings:{...ladder[index-1]} };
      return null;
    },
    commit(change, now = Date.now()) { index = change.index; lastChange = now; saturated = stalled = recovery = 0; }
  };
}
export function createCaptureMetrics() {
  let previousFrames = null, framesCaptured = 0;
  return {
    sample(connections, targetFps) {
      const source = connections.flatMap(connection => connection.rows || []).find(row => row.type === 'media-source');
      const fps = Number.isFinite(source?.framesPerSecond) ? source.framesPerSecond : null;
      const measured = Number.isFinite(source?.frames) ? source.frames : null;
      if (measured !== null) { framesCaptured += previousFrames === null || measured < previousFrames ? measured : measured - previousFrames; previousFrames = measured; }
      return { observedFps:fps, captureGap:fps > 0 ? targetFps / fps : null, captureStall:fps === null ? null : fps < targetFps * .75,
        framesCaptured:measured === null ? null : framesCaptured, framesDropped:null, framesStalled:null };
    }
  };
}

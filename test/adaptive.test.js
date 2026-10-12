const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('../scripts/load-renderer-module');
test('adaptive degrades only with GPU saturation AND capture stalls, commits after success and obeys cooldown', async () => {
  const {createAdaptiveQuality} = await load('adaptive-quality.js');
  const policy = createAdaptiveQuality({resolution:'auto',frameRate:60,previewHidden:false},{width:3840,height:2160});
  const bad = {busiestEnginePercent:{'3D':99},captureStall:true,gpuAgeMs:0};
  for(let n=1;n<=3;n++) assert.equal(policy.observe(bad,n*2000),null);
  const change=policy.observe(bad,8000); assert.equal(change.action,'degrade'); assert.equal(change.settings.previewHidden,true);
  assert.equal(policy.current().previewHidden,false); policy.commit(change,8000);
  for(let n=5;n<=8;n++) assert.equal(policy.observe(bad,n*2000),null);
  let next; for(let n=9;n<=12;n++) next=policy.observe(bad,n*2000);
  assert.equal(next.settings.frameRate,45);
});
test('adaptive floors at 960x540 @20 and restores one step under sustained recovery', async () => {
  const {createAdaptiveQuality} = await load('adaptive-quality.js');
  const policy=createAdaptiveQuality({resolution:'auto',frameRate:60,previewHidden:false},{width:3840,height:2160});
  let now=0;
  for(let i=0;i<160;i++) { now+=2000; const change=policy.observe({busiestEnginePercent:{'3D':99},captureStall:true},now); if(change) policy.commit(change,now); }
  assert.deepEqual(policy.current(),{resolution:'960x540',frameRate:20,previewHidden:true});
  let count=0; for(let i=0;i<8;i++) { now+=2000; const change=policy.observe({busiestEnginePercent:{'3D':60},captureStall:false},now); if(change) { count++; policy.commit(change,now); } }
  assert.equal(count,1); assert.equal(policy.current().resolution,'1280x720');
});
test('adaptive never guesses GPU, reacts to neither stale measurements nor network-only degradation', async () => {
  const {createAdaptiveQuality,createCaptureMetrics}=await load('adaptive-quality.js');
  for(const sample of [{captureStall:true},{busiestEnginePercent:{'3D':99},captureStall:false},{busiestEnginePercent:{'3D':99},captureStall:true,gpuAgeMs:16000}]) {
    const policy=createAdaptiveQuality({frameRate:60}); for(let i=1;i<=16;i++) assert.equal(policy.observe(sample,i*2000),null);
  }
  const sampler=createCaptureMetrics(); assert.equal(sampler.sample([],60).captureStall,null);
  const measured=sampler.sample([{rows:[{type:'media-source',framesPerSecond:12,frames:100}]}],60);
  assert.equal(measured.captureGap,5); assert.equal(measured.captureStall,true); assert.equal(measured.framesCaptured,100); assert.equal(measured.framesDropped,null);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {createDiagnosticSettings}=require('../src/main/diagnostic-settings');
const {createMediaAudit,saturation}=require('../src/main/media-audit');
function fixture(t,options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'self-live-diagnostics-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let processes=0, gpuQueries=0, now=1700000000000;
  const app={getPath:()=>root,getVersion:()=> 'test',getAppMetrics:()=>{processes++;return[];}};
  const audit=createMediaAudit({app,directory:path.join(root,'logs'),platform:'win32',clock:()=>now,
    gpuSampler:callback=>{gpuQueries++; queueMicrotask(()=>callback({'3D':99,VideoEncode:5})); return{kill(){}};},...options});
  t.after(()=>audit.stop());
  return {root,audit,tick:()=>{now+=2000;},counts:()=>({processes,gpuQueries})};
}
test('logging defaults OFF, persists in config/local.json and validates values',t=>{
  const f=fixture(t), settings=createDiagnosticSettings(f.root);
  assert.equal(settings.load().loggingEnabled,false); settings.save({loggingEnabled:true});
  assert.equal(settings.load().gpuPriorityEnabled,false);
  settings.save({gpuPriorityEnabled:true});
  assert.equal(createDiagnosticSettings(f.root).load().gpuPriorityEnabled,true);
  assert.throws(()=>settings.save({gpuPriorityEnabled:'true'}));
  assert.equal(createDiagnosticSettings(f.root).load().loggingEnabled,true);
  assert.ok(fs.existsSync(path.join(f.root,'config','local.json')));
  settings.save({resolution:'720',previewHidden:true});
  assert.equal(createDiagnosticSettings(f.root).load().resolution,'720');
  assert.throws(()=>settings.save({loggingEnabled:'true'}));
});
test('priority experiment logs confirmed process results and export retains session state after toggle changes',async t=>{
  let priority={enabled:true,state:'partial',targets:[{pid:42,type:'GPU',status:'set_failed',ntstatus:'0xC0000022'}]};
  const f=fixture(t,{enabled:true,gpuPriorityProvider:()=>priority});
  f.audit.start({}); f.audit.sample({observedFps:30});
  f.audit.gpuPriorityChanged(priority);
  f.audit.stop();
  priority={enabled:false,state:'disabled',targets:[]};
  const exported=f.audit.exportReport();
  const report=JSON.parse(fs.readFileSync(path.join(f.root,'logs',exported.name)));
  assert.equal(report.configuration.gpuPriorityEnabled,true);
  assert.equal(report.configuration.gpuPriority.state,'partial');
  assert.equal(report.samples[0].gpuPriority.targets[0].ntstatus,'0xC0000022');
  assert.equal(report.gpuPriorityEvents.length,1);
  const records=fs.readdirSync(path.join(f.root,'logs')).filter(name=>name.endsWith('.jsonl'))
    .flatMap(name=>fs.readFileSync(path.join(f.root,'logs',name),'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(records.find(row=>row.type==='start').gpuPriority.enabled,true);
  assert.equal(records.find(row=>row.type==='gpu-priority').gpuPriority.state,'partial');
});
test('OFF has no files or diagnostic process metrics; adaptive uses only minimal GPU metrics',async t=>{
  const f=fixture(t); f.audit.start({}); f.audit.sample({});
  assert.deepEqual(f.counts(),{processes:0,gpuQueries:0}); assert.equal(fs.existsSync(path.join(f.root,'logs')),false);
  f.tick(); f.audit.sample({}, {adaptive:true}); await Promise.resolve();
  assert.deepEqual(f.counts(),{processes:0,gpuQueries:1}); assert.equal(fs.existsSync(path.join(f.root,'logs')),false);
});
test('source background state is sanitized in samples, events and exports',t=>{
  const f=fixture(t,{enabled:true});f.audit.start({});
  const captureLifecycle={status:'background',reason:'minimized',suppressAdaptive:true,trackState:'live',trackMuted:true,
    source:{kind:'window',available:true,exists:true,minimized:true,focused:false,windowTitle:'secret',pid:123}};
  f.audit.sample({captureLifecycle});f.audit.event({action:'capture_state',captureLifecycle});f.audit.stop();
  const result=f.audit.exportReport();const report=JSON.parse(fs.readFileSync(path.join(f.root,'logs',result.name)));
  assert.equal(report.samples[0].captureLifecycle.reason,'minimized');
  assert.equal(report.captureStateEvents[0].captureLifecycle.source.focused,false);
  assert.ok(!JSON.stringify(report).includes('secret'));assert.equal(report.captureStateEvents[0].captureLifecycle.source.pid,undefined);
});
test('hot logging ON writes JSONL, OFF stops writes; rotation caps files and export contains safe measurements',async t=>{
  const f=fixture(t,{maxBytes:2000,keep:5}); f.audit.start({}); f.audit.setEnabled(true);
  for(let i=0;i<25;i++) { f.tick(); f.audit.sample({observedFps:12,captureStall:true,captureGap:5,password:'secret',
    captureMode:{originalResolution:'3840x2160',effectiveResolution:'1920x1080',frameRate:60,reason:'fhd_cap'},
    connections:[{viewer:1,rows:[{type:'outbound-rtp',sentFps:12,encodeMs:4}]}]}); await Promise.resolve(); }
  f.audit.event({action:'degrade'});
  const folder=path.join(f.root,'logs'), files=fs.readdirSync(folder);
  assert.equal(files.length,5); for(const file of files) assert.ok(fs.statSync(path.join(folder,file)).size<=2000);
  f.audit.setEnabled(false); const before=fs.readdirSync(folder).map(name=>[name,fs.statSync(path.join(folder,name)).size]);
  f.tick(); f.audit.sample({}, {adaptive:true}); f.audit.stop();
  assert.deepEqual(fs.readdirSync(folder).map(name=>[name,fs.statSync(path.join(folder,name)).size]),before);
  const exported=f.audit.exportReport({adaptiveQuality:true}); const report=JSON.parse(fs.readFileSync(path.join(folder,exported.name)));
  assert.equal(report.summary.avgMediaSourceFps,12); assert.equal(report.summary.avgEncodeMs,4); assert.equal(report.summary.degradeEvents,1);
  assert.equal(report.samples[0].captureGap,5); assert.equal(report.configuration.fhdCapApplied,true);
  assert.ok(!JSON.stringify(report).includes('secret'));
  assert.deepEqual(saturation({'3D':91,Copy:71,VideoEncode:41,VideoDecode:40}),{'3D':'saturated',Copy:'high',VideoEncode:'medium',VideoDecode:'low'});
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createMediaAudit,cleanSample} = require('../src/main/media-audit');
const loadRenderer = require('../scripts/load-renderer-module');
test('audit sampler computes interval rates and never exports raw stats or peer identities', async () => {
  const {createMediaAuditSampler} = await loadRenderer('media-audit.js');
  const sampler = createMediaAuditSampler(), pc = {};
  const report = (timestamp,frames,bytes,encode) => new Map([['video',{id:'video-secret',type:'outbound-rtp',kind:'video',timestamp,framesEncoded:frames,framesSent:frames,bytesSent:bytes,totalEncodeTime:encode,qualityLimitationReason:'cpu',encoderImplementation:'secret unknown implementation',address:'72.61.63.75'}],['candidate',{type:'candidate-pair',address:'72.61.63.75'}]]);
  const first = sampler.sample(pc,report(1000,10,1000,.1));
  assert.equal(first.rows[0].encodeMs,undefined);
  const next = sampler.sample(pc,report(3000,70,501000,1.3));
  assert.equal(next.viewer,1); assert.equal(next.rows[0].encodedFps,30);
  assert.equal(next.rows[0].sendKbps,2000); assert.equal(next.rows[0].encodeMs,20);
  assert.equal(next.rows[0].encoder,'unknown');
  assert.ok(!JSON.stringify(next).includes('secret') && !JSON.stringify(next).includes('72.61'));
  assert.equal(sampler.sample({},report(4000,1,1,.1)).viewer,2);
  sampler.reset(); assert.equal(sampler.sample(pc,report(4000,1,1,.1)).viewer,1);
});
test('main audit allowlist rejects payloads, arbitrary strings and identifiers', () => {
  const safe = cleanSample({password:'secret',capture:{width:1920,deviceId:'secret'},connections:[{viewer:1,node_id:'secret',rows:[{type:'outbound-rtp',framesEncoded:60,sdp:'secret',encoder:'secret',limitation:'cpu',qpSum:-1}]}]});
  assert.equal(safe.connections[0].rows[0].limitation,'cpu');
  assert.ok(!JSON.stringify(safe).includes('secret')); assert.equal(safe.connections[0].rows[0].qpSum,undefined);
});
test('audit writes per-session bounded JSONL, ends cleanly and preserves other files', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'self-live-audit-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const app={isPackaged:true,getVersion:()=> '0.1.0',getGPUInfo:()=>Promise.resolve({gpuDevice:[]}),getGPUFeatureStatus:()=>({}),getAppMetrics:()=>[],getPath:()=>directory};
  fs.writeFileSync(path.join(directory,'personal.log'),'keep');
  const audit=createMediaAudit({app,directory,enabled:true,maxBytes:66000});
  t.after(()=>audit.stop());
  const result=audit.start({width:1280,height:720,password:'secret'});
  assert.ok(result.enabled);
  audit.sample({capture:{width:1280},connections:[]}); audit.stop();
  const rows=fs.readFileSync(path.join(directory,result.name),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].type,'start'); assert.equal(rows.at(-1).type,'end');
  assert.ok(rows.some(row=>['sample','limit'].includes(row.type)));
  assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.equal(fs.readFileSync(path.join(directory,'personal.log'),'utf8'),'keep');
});

test('audit retains only generated files and reports unavailable when target directory is not writable', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'self-live-audit-retention-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const app={isPackaged:true,getVersion:()=> '0.1.0',getGPUInfo:()=>Promise.resolve({}),getAppMetrics:()=>[],getPath:()=>directory};
  for(let i=1;i<=4;i++) fs.writeFileSync(path.join(directory,`diagnostic-2000-01-01T00-00-00-000Z-${i}-000001.jsonl`),'old');
  fs.writeFileSync(path.join(directory,'self-live-audit-personal.jsonl'),'keep');
  const audit=createMediaAudit({app,directory,enabled:true,keep:2}); audit.start({}); audit.stop();
  assert.equal(fs.readdirSync(directory).filter(file=>file.endsWith('.jsonl')).length,3);
  assert.equal(fs.readFileSync(path.join(directory,'self-live-audit-personal.jsonl'),'utf8'),'keep');
  const blocked=path.join(directory,'not-a-directory'); fs.writeFileSync(blocked,'keep');
  const unavailable=createMediaAudit({app,directory:blocked,enabled:true}); const result=unavailable.start({}); unavailable.stop();
  assert.equal(result.enabled,false);
});

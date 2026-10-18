const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeVideo } = require('../src/native-mvp/controller');
const { createViewerServer, cleanViewerSample } = require('../src/native-mvp/server');
const { createNativeAudit } = require('../src/native-mvp/audit');

test('native RPC waits for readiness, correlates replies and closes on EOF',async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'native-mvp-rpc-'));
  const child=new EventEmitter(); child.stdin=new PassThrough(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.kill=()=>child.emit('close',1);
  let environment;
  const native=new NativeVideo({executable:'native.exe',runtime:folder,registry:path.join(folder,'registry.bin'),timeoutMs:1000,launch:(_file,_args,options)=>{environment=options.env;return child;}});
  t.after(()=>native.close());
  child.stdin.once('finish',()=>child.emit('close',0));
  const pending=native.request('list');
  assert.equal(child.stdin.readableLength,0);
  child.stdout.write('{"type":"ready"}\n');
  await new Promise(resolve=>setImmediate(resolve));
  const command=JSON.parse(child.stdin.read().toString()); assert.equal(command.op,'list');
  child.stdout.write(JSON.stringify({type:'response',id:command.id,ok:true,windows:[]})+'\n');
  assert.deepEqual((await pending).windows,[]);
  assert.equal(environment.GST_PLUGIN_SYSTEM_PATH_1_0,'');
  const failed=native.request('start'); await new Promise(resolve=>setImmediate(resolve));
  const start=JSON.parse(child.stdin.read().toString()); child.stdout.write(JSON.stringify({type:'response',id:start.id,ok:false,message:'hardware unavailable'})+'\n');
  await assert.rejects(failed,/hardware unavailable/);
  await native.close(); assert.equal(native.closed,true);
  await assert.rejects(native.request('list'),/encerrado/);
});

test('viewer server authenticates invitation, permits one viewer and excludes stale native sessions',async t => {
  const native=new EventEmitter(), requests=[];
  native.request=async(op,fields)=>{requests.push({op,fields});native.emit('request',op);return {};};
  const events=[];
  const server=await createViewerServer({native,onEvent:event=>events.push(event),addresses:[],bind:'127.0.0.1'});
  const clients=[]; t.after(async()=>{for(const client of clients)client.terminate();await server.close();});
  const info=server.activate(), origin=`http://127.0.0.1:${info.port}`;
  async function connect(token){const client=new WebSocket(`ws://127.0.0.1:${info.port}/signal`,{origin}); clients.push(client);await once(client,'open');const message=once(client,'message');client.send(JSON.stringify({type:'join',token}));return {client,value:JSON.parse((await message)[0])};}
  const bad=await connect('wrong');assert.equal(bad.value.type,'error');await once(bad.client,'close');assert.equal(requests.length,0);
  const token=info.local.split('#')[1], joined=await connect(token);assert.equal(joined.value.type,'connecting');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests[0].op,'connect');const generation=requests[0].fields.generation;
  const duplicate=await connect(token);assert.match(duplicate.value.message,/um espectador/);
  const offer=once(joined.client,'message');native.emit('event',{type:'offer',generation,sdp:'valid-offer'});
  assert.equal(JSON.parse((await offer)[0]).sdp,'valid-offer');
  joined.client.send(JSON.stringify({type:'sample',decodedFps:59,framesDecoded:123,visible:true,sdp:'secret',candidate:'address'}));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(events.find(value=>value.type==='receiver-sample'),{type:'receiver-sample',visible:true,decodedFps:59,framesDecoded:123});
  const disconnected=once(native,'request');
  const left=once(joined.client,'close');joined.client.close();await left;await disconnected;
  assert.ok(requests.some(value=>value.op==='disconnect'));
  const renewed=server.activate();assert.notEqual(renewed.local,info.local);
  const old=await connect(token);assert.equal(old.value.type,'error');
  const current=await connect(renewed.local.split('#')[1]);const nextGeneration=requests.filter(value=>value.op==='connect').at(-1).fields.generation;
  let received=0;current.client.on('message',()=>received++);native.emit('event',{type:'ice',generation,candidate:'stale'});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(received,0);assert.notEqual(nextGeneration,generation);
  server.deactivate();assert.equal(server.info().local,null);
});

test('viewer server refuses cross-origin WebSocket upgrades',async t => {
  const native=new EventEmitter();native.request=async()=>({});
  const server=await createViewerServer({native,addresses:[],bind:'127.0.0.1'});t.after(()=>server.close());
  const client=new WebSocket(`ws://127.0.0.1:${server.info().port}/signal`,{origin:'https://untrusted.example'});
  client.on('error',()=>{});await new Promise(resolve=>client.once('close',resolve));assert.equal(client.readyState,WebSocket.CLOSED);
});

test('native diagnostics omit negotiation and reject invalid receiver measurements',()=>{
  assert.deepEqual(cleanViewerSample({decodedFps:NaN,framesDropped:-1,jitterMs:Infinity,token:'private',visible:true}),{type:'receiver-sample',visible:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-mvp-audit-'));
  const audit=createNativeAudit(directory,200);audit.start({capture:'WGC-C++'});
  audit.write({type:'offer',sdp:'private-sdp'});audit.write({type:'ice',candidate:'private-ip'});audit.write({type:'sample',captureFps:60});audit.stop();
  const records=fs.readdirSync(directory).flatMap(file=>fs.readFileSync(path.join(directory,file),'utf8').trim().split('\n').map(JSON.parse));
  assert.deepEqual(records.map(value=>value.type),['start','sample','end']);assert.ok(!JSON.stringify(records).includes('private'));
});

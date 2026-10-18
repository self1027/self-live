const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {WebSocket}=require('ws');
const {createDirectServer,connectDirect}=require('../src/native-mvp/direct');
const {attachAutomaticViewer}=require('../src/native-mvp/automatic');
const {createViewerServer}=require('../src/native-mvp/server');
const {decodeInvitation,createInvitation,attachInternetViewer}=require('../src/native-mvp/internet');

function browser(){const client=new EventEmitter();client.readyState=1;client.received=[];client.send=raw=>{const value=JSON.parse(raw);client.received.push(value);client.emit('received',value);};client.close=()=>{if(client.readyState===3)return;client.readyState=3;client.emit('close');};return client;}
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Signaling did not reach expected stage');}

test('direct WSS validates the pin before sending any invitation token',async t=>{
  let messages=0;
  const server=await createDirectServer({bind:'127.0.0.1',accept:socket=>socket.on('message',()=>messages++)});
  t.after(()=>server.close());
  const client=browser(),events=[];
  const session=connectDirect({client,endpoint:{url:`wss://127.0.0.1:${server.wsPort}`},fingerprint:'00'.repeat(32),token:'private-token',onError:code=>events.push(code)});
  t.after(()=>session.close());
  await until(()=>events.includes('tls_pin_mismatch'));
  assert.equal(messages,0);assert.ok(!JSON.stringify(events).includes('private-token'));
});

test('native invitation supports pinned direct WSS without requiring a relay or TURN',async t=>{
  const native=new EventEmitter();const operations=[];
  native.request=async(op,fields)=>{operations.push({op,fields});if(op==='connect')setImmediate(()=>native.emit('event',{type:'offer',generation:fields.generation,sdp:'direct-offer'}));return {};};
  const host=await createViewerServer({native,addresses:[],bind:'127.0.0.1',directEnabled:true});
  const receiver=await createViewerServer({native,addresses:[],bind:'127.0.0.1'});
  t.after(async()=>{await receiver.close();await host.close();});
  const invitation=host.activate().internet;
  const decoded=decodeInvitation(invitation);assert.ok(decoded.direct.endpoints.length);assert.equal(decoded.url,undefined);
  const url=new URL(receiver.remoteViewer(invitation)),messages=[];
  const client=new WebSocket(`ws://${url.host}/remote-signal`,{origin:url.origin});t.after(()=>client.terminate());
  await once(client,'open');client.on('message',raw=>messages.push(JSON.parse(raw.toString())));
  client.send(JSON.stringify({type:'join',token:url.hash.slice(1)}));
  await until(()=>messages.some(value=>value.type==='offer'));
  assert.equal(messages.find(value=>value.type==='offer').sdp,'direct-offer');
  assert.ok(messages.some(value=>value.type==='connection-stage'&&value.stage==='connected'&&value.method==='ipv4-local'));
  assert.equal(operations.filter(value=>value.op==='connect').length,1);
});

test('automatic receiver attempts direct before relay and cancels the losing transport',async()=>{
  const client=browser(),attempts=[],closed=[];
  const session=attachAutomaticViewer({client,invite:{token:'private',url:'wss://relay.example',direct:{fingerprint:'11'.repeat(32),endpoints:[{type:'ipv4-direct',url:'wss://8.8.8.8:3000',priority:2}]}},
    DirectViewer:({onError})=>{attempts.push('direct');queueMicrotask(()=>onError('unavailable'));return {close:async()=>closed.push('direct')};},
    InternetViewer:({client:proxy})=>{attempts.push('relay');queueMicrotask(()=>proxy.send(JSON.stringify({type:'connecting',iceServers:[]})));return {close:async()=>closed.push('relay')};}});
  await until(()=>client.received.some(value=>value.type==='connecting'));
  assert.deepEqual(attempts,['direct','relay']);assert.deepEqual(closed,['direct']);
  assert.ok(client.received.some(value=>value.type==='connection-stage'&&value.method==='relay'&&value.stage==='connected'));
  await session.close();assert.deepEqual(closed,['direct','relay']);
});

test('automatic receiver times out a handshake and closing prevents further attempts',async()=>{
  const client=browser(),attempts=[],closed=[];
  const session=attachAutomaticViewer({client,timeoutMs:20,invite:{token:'private',url:'wss://relay.example',direct:{fingerprint:'11'.repeat(32),endpoints:[{type:'ipv4-direct',url:'wss://8.8.8.8:3000',priority:2}]}},
    DirectViewer:()=>{attempts.push('direct');return {close:async()=>closed.push('direct')};},
    InternetViewer:()=>{attempts.push('relay');client.close();return {close:async()=>closed.push('relay')};}});
  await until(()=>attempts.length===2);await session.close();
  assert.deepEqual(closed,['direct','relay']);assert.equal(client.listenerCount('message'),0);
});

test('invitation errors identify the main protocol and expired invites without repeating private input',()=>{
  assert.throws(()=>decodeInvitation('self-live://join?data=private'),error=>error.code==='incompatible_invitation'&&!error.message.includes('private'));
  const invitation=createInvitation({token:'a'.repeat(48),config:null,direct:()=>({fingerprint:'11'.repeat(32),endpoints:[{type:'ipv4-local',url:'wss://127.0.0.1:4321',priority:4}]})});
  assert.throws(()=>decodeInvitation(invitation(),Date.now()+26*3600000),error=>error.code==='expired_invitation');
});

for(const [scenario,expected] of [['offline','relay_unavailable'],['registered','host_unavailable'],['host','handshake_timeout'],['dns','dns_failed']]){
  test(`receiver diagnostics distinguish ${scenario} before video negotiation`,async()=>{
    const client=browser(),events=[];
    const invite={token:'private-token',url:'wss://relay.example',room:'r',secret:'private-secret',host:'host-id'};
    class Relay extends EventEmitter {
      start(){queueMicrotask(()=>{
        if(scenario==='dns')this.emit('failure','dns_failed');
        if(scenario==='registered'||scenario==='host')this.emit('registered',scenario==='host'?[{node_id:invite.host,role:'host'}]:[]);
      });}
      send(){return true;}
      close(){return Promise.resolve();}
    }
    const session=attachAutomaticViewer({client,invite,timeoutMs:35,onEvent:value=>events.push(value),InternetViewer:options=>attachInternetViewer({...options,Client:Relay})});
    await until(()=>client.received.some(value=>value.type==='error'));
    assert.equal(client.received.find(value=>value.type==='error').code,expected);
    assert.ok(!JSON.stringify(events).includes('private-'));assert.ok(!JSON.stringify(events).includes('relay.example'));
    await session.close();assert.equal(client.listenerCount('message'),0);
  });
}

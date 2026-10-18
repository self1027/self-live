const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {once}=require('node:events');
const {X509Certificate}=require('node:crypto');
const path=require('node:path');
const assert=require('node:assert/strict');
const selfsigned=require('selfsigned');
const {startRelay}=require('../relay/server');
const {launch,waitFor,click,children,cleanup}=require('./run-native-mvp-smoke');
let relay;
(async()=>{
  let overrides={};
  if(!process.argv.includes('--public')){
    const cert=await selfsigned.generate([{name:'commonName',value:'localhost'}],{keySize:2048,days:1});
    relay=await startRelay({key:cert.private,cert:cert.cert,host:'127.0.0.1',port:0,log(){}});
    overrides={SELF_LIVE_RELAY_URL:`wss://127.0.0.1:${relay.port}`,SELF_LIVE_RELAY_FINGERPRINT:new X509Certificate(cert.cert).fingerprint256.replace(/:/g,'')};
  }
  const fixture=spawn(path.resolve(__dirname,'../native/bin/native-mvp-test-window.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(fixture);
  const info=JSON.parse((await once(createInterface({input:fixture.stdout}),'line'))[0]);
  const host=await launch(overrides),receiver=await launch(overrides);
  await waitFor(host,`[...document.getElementById('source').options].some(item=>item.value===${JSON.stringify(info.window)})`);
  await host.rpc('evaluate',`document.getElementById('source').value=${JSON.stringify(info.window)}`);
  await click(host,'start');await waitFor(host,`!document.getElementById('viewer').disabled`);
  await waitFor(host,`document.getElementById('network-state').textContent.includes('conectada')`);
  const invitation=await host.rpc('invitation');assert.ok(invitation?.startsWith('selflive-native://join/'));
  async function join(){
    await receiver.rpc('evaluate',`document.getElementById('invitation').value=${JSON.stringify(invitation)}`);
    await click(receiver,'join');
    await waitFor(receiver,`document.getElementById('video')?.getVideoPlaybackQuality().totalVideoFrames>30`,'viewer',35000);
  }
  await join();await waitFor(host,`document.getElementById('network-path').textContent.includes('P2P direta')`);
  const video=await receiver.rpc('evaluate',`({width:document.getElementById('video').videoWidth,height:document.getElementById('video').videoHeight,frames:document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames})`,'viewer');
  assert.equal(video.width,info.clientWidth&~1);assert.ok(video.frames>30);
  console.log('ICE and media:',await host.rpc('network-summary'));
  await receiver.rpc('evaluate',`document.getElementById('reconnect').click()`,'viewer');
  await waitFor(receiver,`document.getElementById('video')?.getVideoPlaybackQuality().totalVideoFrames>30`,'viewer',35000);
  await receiver.rpc('close-viewer',null,'viewer');await waitFor(host,`document.getElementById('status').textContent.includes('aguardando espectador')`);
  await join();await click(host,'stop');await waitFor(receiver,`document.getElementById('status').textContent.includes('encerrada')||document.getElementById('status').textContent.includes('desconectada')`,'viewer');
  const hostExit=once(host.child,'exit');await host.rpc('quit');await hostExit;
  const receiverExit=once(receiver.child,'exit');await receiver.rpc('quit');await receiverExit;
  const fixtureExit=once(fixture,'exit');fixture.stdin.end();await fixtureExit;
  console.log(`Native capture -> encrypted ${relay?'local TLS relay':'public WSS relay'} signaling -> second MVP -> decoded P2P video: OK`);
  console.log('Client crop, remote invitation, player reconnect, new viewer, stop and shutdown: OK');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await cleanup();await relay?.close();});

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const electron = require('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const children=[];let sequence=0;
async function launch() {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(__dirname,'native-mvp-smoke-peer.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(child);
  const pending=new Map();let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const deadline=setTimeout(()=>readyReject(new Error('MVP nao iniciou')),30000);
  child.stderr.on('data',chunk=>process.stderr.write(chunk));child.stdout.on('data',chunk=>process.stdout.write(chunk));
  child.on('message',message=>{
    if(message.type==='ready'){clearTimeout(deadline);readyResolve();return;}
    const operation=pending.get(message.id);if(!operation)return;clearTimeout(operation.timer);pending.delete(message.id);
    if(message.ok)operation.resolve(message.result);else operation.reject(new Error(message.error));
  });
  child.once('exit',code=>{clearTimeout(deadline);readyReject(new Error(`Electron encerrou (${code})`));for(const operation of pending.values()){clearTimeout(operation.timer);operation.reject(new Error('Electron encerrou'));}});
  await ready;
  return {child,rpc(type,code,target='host'){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout ${type}`));},40000);pending.set(id,{resolve,reject,timer});child.send({id,type,code,target});});}};
}
async function waitFor(peer,expression,target='host',timeout=25000){
  const until=Date.now()+timeout;
  while(Date.now()<until){try{if(await peer.rpc('evaluate',expression,target))return;}catch{/* Viewer may not be created yet. */}await delay(150);}
  const state=await peer.rpc('evaluate',`['status','details','source-state'].map(id=>document.getElementById(id).textContent).join(' | ')`,'host');throw new Error(`Estado nao alcancado: ${expression}\n${state}`);
}
const click=(peer,id)=>peer.rpc('evaluate',`document.getElementById(${JSON.stringify(id)}).click()`);
(async()=>{
  const fixture=spawn(path.resolve(__dirname,'../native/bin/native-mvp-test-window.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(fixture);
  const lines=createInterface({input:fixture.stdout});
  const info=JSON.parse((await once(lines,'line'))[0]);
  const peer=await launch();
  await waitFor(peer,`[...document.getElementById('source').options].some(row=>row.value===${JSON.stringify(info.window)})`);
  await peer.rpc('evaluate',`document.getElementById('source').value=${JSON.stringify(info.window)};document.getElementById('logging').checked=true`);
  await click(peer,'start');await waitFor(peer,`!document.getElementById('viewer').disabled`);
  const details=await peer.rpc('evaluate',`document.getElementById('details').textContent`);console.log('Native capture started:',details);
  await click(peer,'viewer');
  await waitFor(peer,`document.getElementById('video')?.getVideoPlaybackQuality().totalVideoFrames>30`,'viewer');
  const dimensions=await peer.rpc('evaluate',`({width:document.getElementById('video').videoWidth,height:document.getElementById('video').videoHeight})`,'viewer');
  assert.deepEqual(dimensions,{width:info.clientWidth & ~1,height:info.clientHeight & ~1},'Capture must exclude the non-client caption and borders');
  const corner=await peer.rpc('evaluate',`(()=>{const video=document.getElementById('video'),canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const context=canvas.getContext('2d');context.drawImage(video,0,0);return [...context.getImageData(5,5,1,1).data];})()`,'viewer');
  assert.ok(corner[0]<80 && corner[1]<100 && corner[2]<120,'Client corner should contain the dark test scene, not the light title bar');
  const first=await peer.rpc('evaluate',`document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames`,'viewer');
  await delay(1200);
  const second=await peer.rpc('evaluate',`document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames`,'viewer');assert.ok(second>first+5);
  const output=path.join(os.tmpdir(),'self-live-native-mvp-smoke');fs.mkdirSync(output,{recursive:true});
  await peer.rpc('screenshot',path.join(output,'host.png'));await peer.rpc('screenshot',path.join(output,'viewer.png'),'viewer');
  fixture.stdin.write('minimize\n');await waitFor(peer,`document.getElementById('source-state').textContent.includes('minimizada')`);
  await delay(1400);assert.equal(await peer.rpc('evaluate',`document.getElementById('stop').disabled`),false);
  fixture.stdin.write('restore\n');
  const paused=await peer.rpc('evaluate',`document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames`,'viewer');
  await waitFor(peer,`document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames>${paused+20}`,'viewer');
  fixture.stdin.write('resize\n');await delay(2000);
  const resized=await peer.rpc('evaluate',`document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames`,'viewer');
  await waitFor(peer,`document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames>${resized+20}`,'viewer');
  await peer.rpc('close-viewer',null,'viewer');await delay(500);await click(peer,'viewer');
  await waitFor(peer,`document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames>20`,'viewer');
  await click(peer,'stop');await waitFor(peer,`!document.getElementById('start').disabled`);
  await peer.rpc('close-viewer',null,'viewer');
  await peer.rpc('evaluate',`document.getElementById('priority').checked=true`);
  await click(peer,'start');await waitFor(peer,`!document.getElementById('viewer').disabled`);
  await waitFor(peer,`document.getElementById('source-state').textContent.includes('HIGH confirmada')`);
  fixture.stdin.write('close\n');await once(fixture,'exit');
  await waitFor(peer,`document.getElementById('status').textContent.includes('janela foi fechada')`);
  const helpers=await peer.rpc('helpers');assert.ok(helpers.length);
  const exited=once(peer.child,'exit');await peer.rpc('quit');await exited;
  for(const pid of helpers){let alive=true;try{process.kill(pid,0);}catch{alive=false;}assert.equal(alive,false,`Helper ${pid} permaneceu ativo`);}
  console.log('WGC real -> D3D11 -> hardware H264 -> WebRTC -> decoded video: OK');
  console.log('Client crop, minimize/restore, resize, reconnect, native GPU priority, source close and helper shutdown: OK');
  console.log('Screenshots:',output);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{for(const child of children){if(child.exitCode===null)child.kill();}});

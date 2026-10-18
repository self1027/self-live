const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('../scripts/load-renderer-module');
class Track extends EventTarget {
  constructor() { super(); this.kind = 'video'; this.readyState = 'live'; this.muted = false; }
  stop() { this.readyState = 'ended'; }
}
async function fixture(t, override = {}) {
  const {createCaptureLifecycle} = await load('capture-lifecycle.js');
  let now = 10000, source = {kind:'window',available:true,exists:true,minimized:false,visible:true,focused:true};
  let recoveries = 0, closed = 0;
  const states = [], track = new Track();
  const lifecycle = createCaptureLifecycle({getSourceState:async()=>source,recover:async()=>{recoveries++;return new Track();},
    onClosed:()=>closed++,onState:value=>states.push(value),clock:()=>now,setTimer:()=>null,clearTimer:()=>{},...override});
  lifecycle.start(track); await lifecycle.tick(); await new Promise(resolve=>setImmediate(resolve));
  t.after(()=>lifecycle.stop());
  return {track,lifecycle,states,source:value=>{source={...source,...value};},counts:()=>({recoveries,closed}),
    tick:async(ms=1000)=>{now+=ms;await lifecycle.tick();}};
}
test('Alt+Tab and minimization preserve the session, suppress adaptation, and do not recapture while minimized', async t=>{
  const f=await fixture(t); f.lifecycle.observe({framesCaptured:1,observedFps:60});
  f.source({focused:false,minimized:true}); await f.tick();
  f.track.readyState='ended';
  for(let n=0;n<15;n++){f.lifecycle.observe({framesCaptured:1,observedFps:0});await f.tick();}
  assert.equal(f.lifecycle.snapshot().status,'background'); assert.equal(f.lifecycle.snapshot().suppressAdaptive,true);
  assert.deepEqual(f.counts(),{recoveries:0,closed:0});
  f.source({focused:true,minimized:false}); await f.tick();
  assert.equal(f.counts().recoveries,1); assert.equal(f.counts().closed,0);
  f.lifecycle.observe({framesCaptured:2,observedFps:60}); await f.tick(7000);
  assert.equal(f.lifecycle.snapshot().status,'live'); assert.equal(f.lifecycle.snapshot().suppressAdaptive,false);
});
test('natural frame recovery after Alt+Tab does not restart capture',async t=>{
  const f=await fixture(t);f.source({focused:false});await f.tick();f.source({focused:true});await f.tick();
  f.lifecycle.observe({framesCaptured:20,observedFps:60});await f.tick(7000);
  assert.equal(f.lifecycle.snapshot().status,'live');assert.equal(f.counts().recoveries,0);
});
test('a visible background window can recover video without stealing focus',async t=>{
  const f=await fixture(t);f.source({focused:false,minimized:false,visible:true});await f.tick();
  f.track.readyState='ended';await f.tick();
  assert.equal(f.counts().recoveries,1);assert.equal(f.counts().closed,0);
  f.lifecycle.observe({framesCaptured:10,observedFps:60});await f.tick();
  assert.equal(f.lifecycle.snapshot().status,'background');assert.equal(f.lifecycle.snapshot().suppressAdaptive,true);
});
test('mute and missing frames can recover without a track-ended event',async t=>{
  const f=await fixture(t);f.track.muted=true;await f.tick();assert.equal(f.lifecycle.snapshot().suppressAdaptive,true);
  await f.tick(3000);assert.equal(f.counts().recoveries,1);assert.equal(f.counts().closed,0);
});
test('actual source closure has a grace period; temporary disappearance does not stop',async t=>{
  const f=await fixture(t);f.source({exists:false});await f.tick();await f.tick(11000);assert.equal(f.counts().closed,0);
  f.source({exists:true});await f.tick();assert.equal(f.counts().closed,0);
  f.source({exists:false});await f.tick();await f.tick(12000);assert.equal(f.counts().closed,1);
});
test('stop during recovery cancels adoption and detaches track events',async t=>{
  let release;const recovery=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{recover:()=>recovery});f.track.readyState='ended';const operation=f.tick();
  await new Promise(resolve=>setImmediate(resolve));f.lifecycle.stop();release(new Track());await operation;
  const length=f.states.length;f.track.dispatchEvent(new Event('ended'));await f.tick();assert.equal(f.states.length,length);
});
test('persistent failure backs off without closing peers, and monitoring works with no stats yet',async t=>{
  let tries=0;const f=await fixture(t,{recover:async()=>{tries++;throw new Error('temporarily unavailable');}});
  await f.tick(60000);assert.equal(tries,0);
  f.track.readyState='ended';for(let n=0;n<60;n++)await f.tick();
  assert.equal(tries,3);assert.equal(f.counts().closed,0);
});
test('video replacement preserves original audio and stream and rolls back failed multi-viewer swaps',async()=>{
  const {replaceCaptureVideo}=await load('replace-capture-video.js');
  const old=new Track(),next=new Track(),audio={kind:'audio',readyState:'live'};
  let video=old;const stream={getVideoTracks:()=>[video],getAudioTracks:()=>[audio],removeTrack:()=>{video=null;},addTrack:value=>{video=value;}};
  const replacement={getVideoTracks:()=>[next],getAudioTracks:()=>[]};
  const first={track:old,async replaceTrack(value){this.track=value;}},bad={track:old,async replaceTrack(){throw new Error('failed');}};
  await assert.rejects(replaceCaptureVideo({stream,replacement,getSenders:()=>[first,bad]}));
  assert.equal(video,old);assert.equal(first.track,old);assert.equal(next.readyState,'ended');assert.equal(audio.readyState,'live');
  const fresh=new Track();await replaceCaptureVideo({stream,replacement:{getVideoTracks:()=>[fresh],getAudioTracks:()=>[]},getSenders:()=>[first]});
  assert.equal(video,fresh);assert.equal(first.track,fresh);assert.equal(stream.getAudioTracks()[0],audio);assert.equal(audio.readyState,'live');
});

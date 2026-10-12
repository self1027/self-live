const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=require('../scripts/load-renderer-module');
test('4K and ultrawide simulations enforce FHD before capture and preserve aspect on applyConstraints',async t=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  t.after(()=>descriptor?Object.defineProperty(globalThis,'navigator',descriptor):delete globalThis.navigator);
  const {captureSystemMedia}=await load('webrtc.js');
  for(const source of [{width:3840,height:2160},{width:3440,height:1440},{width:1080,height:2560}]) {
    let actual=source, options;
    const track={getSettings:()=>actual,stop(){},applyConstraints:async c=>{actual={width:c.width.max,height:c.height.max,frameRate:c.frameRate.max};}};
    const stream={getVideoTracks:()=>[track],getAudioTracks:()=>[{stop(){}}],getTracks:()=>[track]};
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getDisplayMedia:async c=>{options=c; return stream;}}}});
    await captureSystemMedia({original:source});
    assert.equal(options.video.width.max,1920); assert.equal(options.video.height.max,1080);
    assert.ok(actual.width<=1920&&actual.height<=1080); assert.ok(Math.abs(actual.width/actual.height-source.width/source.height)<.01);
    assert.deepEqual(stream.captureOriginal,source);
  }
});
test('driver ignoring FHD constraints fails closed and stops every track',async t=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  t.after(()=>descriptor?Object.defineProperty(globalThis,'navigator',descriptor):delete globalThis.navigator);
  let stopped=0;
  const track={getSettings:()=>({width:2560,height:1440}),stop:()=>stopped++,applyConstraints:async()=>{}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getDisplayMedia:async()=>({getVideoTracks:()=>[track],getAudioTracks:()=>[],getTracks:()=>[track]})}}});
  const {captureSystemMedia}=await load('webrtc.js');
  await assert.rejects(captureSystemMedia(),/1920x1080/); assert.equal(stopped,1);
});
test('invalid quality and environment width/height overrides cannot raise the cap',async()=>{
  const {captureSize}=await load('capture-quality.js');
  const oldWidth=process.env.SELF_LIVE_MEDIA_WIDTH, oldHeight=process.env.SELF_LIVE_MEDIA_HEIGHT;
  try { process.env.SELF_LIVE_MEDIA_WIDTH='2560'; process.env.SELF_LIVE_MEDIA_HEIGHT='1440';
    assert.deepEqual(captureSize(3840,2160,'2560x1440'),{width:1920,height:1080});
    const {captureSystemMedia}=await load('webrtc.js'); await assert.rejects(captureSystemMedia({resolution:'2560x1440'}),/inválida/);
  } finally { if(oldWidth===undefined) delete process.env.SELF_LIVE_MEDIA_WIDTH; else process.env.SELF_LIVE_MEDIA_WIDTH=oldWidth;
    if(oldHeight===undefined) delete process.env.SELF_LIVE_MEDIA_HEIGHT; else process.env.SELF_LIVE_MEDIA_HEIGHT=oldHeight; }
});

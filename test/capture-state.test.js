const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCaptureState}=require('../src/main/capture-state');
test('window state samples only a selected numeric HWND and exposes no process identifiers',async()=>{
  const calls=[];let owner=42;
  const state=createCaptureState({app:{isPackaged:false},platform:'win32',run:(file,args,options,callback)=>{
    calls.push({file,args,options});callback(null,JSON.stringify({available:true,exists:true,owner,minimized:true,visible:true,focused:false,title:'secret'}));
  }});
  assert.equal((await state.sample('screen:1')).available,false);assert.equal((await state.sample('window:1;cmd:0')).available,false);
  const result=await state.sample('window:123:0');assert.equal(result.minimized,true);assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.owner,undefined);assert.deepEqual(calls[0].args,['123']);assert.equal(calls[0].options.windowsHide,true);
  owner=99;assert.equal((await state.sample('window:123:0')).exists,false);
});
test('native state failure is unknown, never a source closure',async()=>{
  const state=createCaptureState({app:{},platform:'win32',run:(_file,_args,_options,callback)=>callback(new Error('missing helper'))});
  assert.deepEqual(await state.sample('window:123:0'),{kind:'window',available:false});
});

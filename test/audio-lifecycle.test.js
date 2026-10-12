const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(readSnapshot) {
  const events = [], children = [], timers = new Map();
  function execFile() { throw new Error('Only promisified calls are expected'); }
  execFile[promisify.custom] = async () => ({ stdout: JSON.stringify(await readSnapshot()) });
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); };
    children.push(child); setImmediate(() => child.stderr.write('ready\r\n')); return child;
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main/application-audio.js'),'utf8'), {
    module, __dirname:path.join(__dirname,'../src/main'), Buffer, Uint8Array,
    process:{platform:'win32',pid:99}, setTimeout,clearTimeout,
    setInterval:(callback,ms) => {timers.set(ms,callback);return ms;}, clearInterval:id=>timers.delete(id),
    require:name => name==='node:child_process' ? {spawn,execFile} : name==='node:os' ? {release:()=> '10.0.26200'} :
      name==='./audio-mixer' ? require('../src/main/audio-mixer') : require(name)
  });
  return { events,children,timers, audio:module.exports.createApplicationAudio({app:{isPackaged:false},getWindow:()=>({
    isDestroyed:()=>false,webContents:{send:(channel,value)=>events.push({channel,value})}
  })}) };
}
const snapshot={processes:[{pid:1,parent:0,executable:'game.exe'}],sessions:[1]};
test('perda da descoberta suspende captura, encerra helpers e comunica ausência de áudio', async () => {
  let scans=0;const f=fixture(async()=>{if(++scans===1)return snapshot;throw new Error('Device lost');});
  assert.equal((await f.audio.start({mode:'exclude',applications:[]})).enabled,true);
  await f.timers.get(1000)();
  assert.equal(f.children[0].killed,true);
  assert.equal(f.timers.size,0);
  assert.ok(f.events.some(e=>e.channel==='application-audio-ended'&&e.value.reason.includes('verificar as exclusões')));
});
test('shutdown durante descoberta não inicia helpers atrasados nem restaura áudio', async () => {
  let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;}));
  const starting=f.audio.start({mode:'include',applications:['game.exe']});
  f.audio.stop();resolve(snapshot);
  assert.equal((await starting).enabled,false);
  assert.equal(f.children.length,0);assert.equal(f.timers.size,0);
});

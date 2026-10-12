const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capturePlan, validateSelection } = require('../src/main/application-audio');
const { AudioMixer } = require('../src/main/audio-mixer');
const info = { processes: [
  { pid: 1, parent: 0, executable: 'game.exe' },
  { pid: 2, parent: 1, executable: 'game.exe' },
  { pid: 3, parent: 0, executable: 'music.exe' },
  { pid: 4, parent: 0, executable: 'Discord.exe' },
  { pid: 5, parent: 4, executable: 'audio-helper.exe' },
  { pid: 6, parent: 0, executable: 'unknown-call.exe' },
  { pid: 7, parent: 0, executable: 'Self Live.exe' },
  { pid: 8, parent: 7, executable: 'utility.exe' }
], sessions: [1, 2, 3, 5, 6, 8] };
test('inclusão deduplica árvore de processos e não permite chamadas, filhos nem reprodução própria', () => {
  assert.deepEqual(capturePlan(info, { mode: 'include', applications: ['game.exe', 'music.exe', 'discord.exe', 'utility.exe'] }, 7), [1, 3]);
});
test('exclusão reconhece chamadas, exclusão manual e novos PIDs com o mesmo executável', () => {
  const choice = { mode: 'exclude', applications: ['unknown-call.exe'] };
  assert.deepEqual(capturePlan(info, choice, 7), [1, 3]);
  const restarted = { processes: info.processes.filter(p => p.pid !== 6).concat({pid: 9, parent: 0, executable:'unknown-call.exe'}), sessions: [1,3,5,9,8] };
  assert.deepEqual(capturePlan(restarted, choice, 7), [1, 3]);
});
test('árvore permitida contendo filho excluído é recusada por inteiro', () => {
  const mixed = { processes: info.processes.concat({pid: 10,parent:1,executable:'Zoom.exe'}), sessions:[1,2,3,10] };
  assert.deepEqual(capturePlan(mixed,{mode:'include',applications:['game.exe','music.exe']},7),[3]);
});
test('seleção valida modo, nomes e limite; nomes são normalizados sem comandos ou caminhos', () => {
  assert.deepEqual(validateSelection({mode:'exclude',applications:['Call.exe','CALL.exe']}),{mode:'exclude',applications:['call.exe']});
  for (const value of [{mode:'all',applications:[]},{mode:'exclude',applications:['C:\\call.exe']},
    {mode:'include',applications:Array(17).fill('game.exe')}, {mode:'exclude',applications:null}]) assert.throws(()=>validateSelection(value));
});

test('tela inteira exclui Discord e filhos; outros apps de chamadas são uma escolha do usuário', () => {
  assert.deepEqual(capturePlan(info, {mode:'desktop',applications:['discord.exe']},7), [1,3,6]);
  assert.deepEqual(capturePlan(info, {mode:'desktop',applications:[]},7), [1,3,5,6]);
  assert.deepEqual(capturePlan(info, {mode:'desktop',applications:['discord.exe','unknown-call.exe']},7), [1,3]);
  const variants = {processes:info.processes.map(p=>p.pid===4?{...p,executable:'DiscordCanary.exe'}:p),sessions:info.sessions};
  assert.deepEqual(capturePlan(variants,{mode:'desktop',applications:['discord.exe']},7), [1,3,6]);
});

test('janela explícita de Discord inclui somente seu aplicativo e ignora exclusões de tela inteira', () => {
  assert.deepEqual(validateSelection({mode:'window',sourceId:'window:123:0'}),{mode:'window',sourceId:'window:123:0'});
  assert.throws(()=>validateSelection({mode:'window',sourceId:'screen:123'}));
  assert.deepEqual(capturePlan(info,{mode:'window',pid:4,applications:['discord.exe']},7), [4]);
  assert.deepEqual(capturePlan(info,{mode:'window',pid:7},7), []);
});
function pcm(value, frames = 960) {
  const result = Buffer.alloc(frames*4); for(let i=0;i<frames*2;i++) result.writeInt16LE(value,i*2); return result;
}
test('mixer alinha fontes por timestamp, limita saturação e remove imediatamente fontes excluídas', () => {
  let output; const mixer = new AudioMixer(bytes => {output=Buffer.from(bytes);});
  mixer.add(1);mixer.add(2);mixer.push(1,10000000,pcm(20000));mixer.push(2,10100000,pcm(20000));
  mixer.tick();
  assert.equal(output.readInt16LE(0),20000);
  assert.equal(output.readInt16LE(480*4),32767);
  mixer.remove(2);mixer.push(1,10200000,pcm(-20000));mixer.tick();
  assert.equal(output.readInt16LE(0),-20000);
});

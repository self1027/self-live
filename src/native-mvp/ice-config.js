const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseTurnUrl, readTurnConfig, generateTurnCredentials } = require('../main/turn');
const STUN = 'stun:stun.l.google.com:19302';
function validateTurn(value) {
  if (!value || !parseTurnUrl(value.urls) || typeof value.username !== 'string' || !value.username || value.username.length > 512 ||
      typeof value.credential !== 'string' || !value.credential || value.credential.length > 2048 || /[\r\n\0]/.test(value.username + value.credential)) throw new Error('Informe URL TURN, usuario e credencial validos.');
  return {urls:value.urls,username:value.username,credential:value.credential};
}
function nativeIceConfiguration(configuration) {
  const turnServers=[];
  for(const server of configuration.iceServers || []) for(const url of [].concat(server.urls || [])) {
    if(!/^turns?:/.test(url))continue;
    const parsed=parseTurnUrl(url);validateTurn({...server,urls:url});
    const scheme=url.startsWith('turns:')?'turns':'turn';
    const host=parsed.host.includes(':')?`[${parsed.host}]`:parsed.host;
    const transport=/\?transport=(udp|tcp)$/.exec(url)?.[0] || '';
    turnServers.push(`${scheme}://${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@${host}:${parsed.port}${transport}`);
  }
  const relayOnly=configuration.iceTransportPolicy==='relay';
  if(relayOnly&&!turnServers.length)throw new Error('TURN nao configurado.');
  return {stunServer:'stun://stun.l.google.com:19302',turnServers,relayOnly};
}
function createIceSettings({ directory, storage, env = process.env }) {
  const file = path.join(directory,'native-network.json');
  let turn = null, rest = null, forceRelay = env.SELF_LIVE_FORCE_RELAY === '1';
  if (env.SELF_LIVE_TURN_USERNAME && env.SELF_LIVE_TURN_CREDENTIAL) turn = validateTurn({urls:env.SELF_LIVE_TURN_URL,username:env.SELF_LIVE_TURN_USERNAME,credential:env.SELF_LIVE_TURN_CREDENTIAL});
  else if (env.SELF_LIVE_TURN_SECRET) rest = readTurnConfig(env,{info(){},warn(){}});
  if (fs.existsSync(file)) {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    forceRelay=saved.forceRelay === true;
    if (saved.environment !== true) {
      rest=null;turn=saved.encrypted ? validateTurn(JSON.parse(storage.decryptString(Buffer.from(saved.encrypted,'base64')))) : null;
    }
  }
  return {
    snapshot: () => ({turnUrl:turn?.urls || rest?.urls || '',turnUsername:turn?.username || '',hasCredential:Boolean(turn || rest),forceRelay,environmentCredentials:Boolean(rest)}),
    configuration() {
      const credential=turn || (rest ? generateTurnCredentials(rest,randomUUID()) : null);
      if (forceRelay && !credential) throw new Error('Configure TURN antes de forcar o relay de midia.');
      return {iceServers:[{urls:STUN},...(credential ? [credential] : [])],iceTransportPolicy:forceRelay ? 'relay' : 'all'};
    },
    save(value) {
      if (!value || typeof value.forceRelay !== 'boolean') throw new Error('Configuracao de rede invalida.');
      let next=turn, nextRest=rest;
      if (value.clear === true) { next=null;nextRest=null; }
      else {
        const urls=typeof value.turnUrl === 'string' ? value.turnUrl.trim() : '';
        const username=typeof value.turnUsername === 'string' ? value.turnUsername.trim() : '';
        const credential=typeof value.turnCredential === 'string' ? value.turnCredential : '';
        if (credential) { next=validateTurn({urls,username,credential});nextRest=null; }
        else if (urls !== (turn?.urls || rest?.urls || '') || username !== (turn?.username || '')) throw new Error('Informe a credencial ao alterar o servidor ou usuario TURN.');
      }
      if (value.forceRelay && !next && !nextRest) throw new Error('Configure TURN antes de forcar o relay de midia.');
      if (next && !storage.isEncryptionAvailable()) throw new Error('Protecao local de credenciais indisponivel.');
      const saved={forceRelay:value.forceRelay,environment:Boolean(nextRest),encrypted:next ? storage.encryptString(JSON.stringify(next)).toString('base64') : null};
      fs.mkdirSync(directory,{recursive:true});
      const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(saved),{mode:0o600});fs.renameSync(temporary,file);
      turn=next;rest=nextRest;forceRelay=value.forceRelay;return this.snapshot();
    }
  };
}
module.exports={STUN,createIceSettings,validateTurn,nativeIceConfiguration};

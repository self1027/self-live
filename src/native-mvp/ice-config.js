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
function validateSecret(value) {
  const configuration = readTurnConfig({
    SELF_LIVE_TURN_URL:value?.urls,
    SELF_LIVE_TURN_SECRET:value?.secret,
    SELF_LIVE_TURN_TTL:String(value?.ttl ?? 3600)
  }, {info(){},warn(){}});
  if (!configuration) throw new Error('Informe o servidor TURN e o segredo do Coturn validos.');
  return configuration;
}
function createIceSettings({ directory, storage, env = process.env }) {
  const file = path.join(directory,'native-network.json');
  let turn = null, rest = null, forceRelay = env.SELF_LIVE_FORCE_RELAY === '1';
  if (env.SELF_LIVE_TURN_USERNAME && env.SELF_LIVE_TURN_CREDENTIAL) turn = validateTurn({urls:env.SELF_LIVE_TURN_URL,username:env.SELF_LIVE_TURN_USERNAME,credential:env.SELF_LIVE_TURN_CREDENTIAL});
  else if (env.SELF_LIVE_TURN_SECRET) rest = readTurnConfig(env,{info(){},warn(){}});
  let environmentCredentials = Boolean(rest);
  if (fs.existsSync(file)) {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    forceRelay=saved.forceRelay === true;
    if (saved.environment !== true) {
      environmentCredentials=false;
      rest=saved.encryptedSecret ? validateSecret(JSON.parse(storage.decryptString(Buffer.from(saved.encryptedSecret,'base64')))) : null;
      turn=!rest && saved.encrypted ? validateTurn(JSON.parse(storage.decryptString(Buffer.from(saved.encrypted,'base64')))) : null;
    }
  }
  return {
    snapshot: () => ({turnUrl:turn?.urls || rest?.urls || '',turnUsername:turn?.username || '',turnAuth:rest || !turn ? 'secret' : 'credentials',hasCredential:Boolean(turn || rest),forceRelay,environmentCredentials}),
    configuration() {
      const credential=turn || (rest ? generateTurnCredentials(rest,randomUUID()) : null);
      if (forceRelay && !credential) throw new Error('Configure TURN antes de forcar o relay de midia.');
      return {iceServers:[{urls:STUN},...(credential ? [credential] : [])],iceTransportPolicy:forceRelay ? 'relay' : 'all'};
    },
    save(value) {
      if (!value || typeof value.forceRelay !== 'boolean') throw new Error('Configuracao de rede invalida.');
      let next=turn, nextRest=rest, nextEnvironment=environmentCredentials;
      if (value.clear === true) { next=null;nextRest=null;nextEnvironment=false; }
      else {
        const mode=value.turnAuth ?? (rest ? 'secret' : 'credentials');
        if (!['secret','credentials'].includes(mode)) throw new Error('Modo de autenticacao TURN invalido.');
        const urls=typeof value.turnUrl === 'string' ? value.turnUrl.trim() : '';
        const username=typeof value.turnUsername === 'string' ? value.turnUsername.trim() : '';
        const credential=typeof value.turnCredential === 'string' ? value.turnCredential : '';
        if (mode === 'secret') {
          const secret=typeof value.turnSecret === 'string' ? value.turnSecret : '';
          if (secret) { nextRest=validateSecret({urls,secret});next=null;nextEnvironment=false; }
          else if (urls !== (rest?.urls || '') || turn) throw new Error('Informe o segredo do Coturn para configurar este servidor.');
        } else if (credential) { next=validateTurn({urls,username,credential});nextRest=null;nextEnvironment=false; }
        else if (urls !== (turn?.urls || '') || username !== (turn?.username || '') || rest) throw new Error('Informe a credencial ao alterar o servidor ou usuario TURN.');
      }
      if (value.forceRelay && !next && !nextRest) throw new Error('Configure TURN antes de forcar o relay de midia.');
      if ((next || (nextRest && !nextEnvironment)) && !storage.isEncryptionAvailable()) throw new Error('Protecao local de credenciais indisponivel.');
      const saved={forceRelay:value.forceRelay,environment:nextEnvironment,
        encrypted:next ? storage.encryptString(JSON.stringify(next)).toString('base64') : null,
        encryptedSecret:nextRest && !nextEnvironment ? storage.encryptString(JSON.stringify(nextRest)).toString('base64') : null};
      fs.mkdirSync(directory,{recursive:true});
      const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(saved),{mode:0o600});fs.renameSync(temporary,file);
      turn=next;rest=nextRest;environmentCredentials=nextEnvironment;forceRelay=value.forceRelay;return this.snapshot();
    }
  };
}
module.exports={STUN,createIceSettings,validateTurn,nativeIceConfiguration};

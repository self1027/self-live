const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { RelayClient, relayKey, readRelayConfig } = require('../main/relay-client');
const { passwordHash } = require('../shared/crypto');
const { validateEndpoint } = require('../main/access-link');
const PREFIX='selflive-native://join/';
function invitationError(message,code='invalid_invitation'){return Object.assign(new Error(message),{code});}
function directSettings(value) {
  if(value===undefined)return undefined;
  if(!value||typeof value.fingerprint!=='string'||!Array.isArray(value.endpoints)||!value.endpoints.length||value.endpoints.length>16)throw invitationError('Rotas diretas do convite invalidas.');
  const fingerprint=value.fingerprint.replace(/:/g,'').toUpperCase();
  if(!/^[A-F0-9]{64}$/.test(fingerprint))throw invitationError('Certificado do convite invalido.');
  let endpoints;
  try {endpoints=value.endpoints.map(endpoint=>{if(endpoint?.type==='relay')throw new Error();return validateEndpoint(endpoint);});}
  catch {throw invitationError('Rotas diretas do convite invalidas.');}
  if(new Set(endpoints.map(endpoint=>endpoint.url)).size!==endpoints.length)throw invitationError('Rotas repetidas no convite.');
  return {fingerprint,endpoints};
}
function createInvitation({config,token,direct}) {
  const invite={v:1,...(config?{url:config.url,...(config.fingerprint?{fingerprint:config.fingerprint}:{})}:{}),room:randomBytes(32).toString('hex'),secret:randomBytes(32).toString('hex'),token,host:randomUUID(),expires:Date.now()+24*3600000};
  return ()=>{const routes=direct?.();return PREFIX+Buffer.from(JSON.stringify({...invite,...(routes?.endpoints.length?{direct:directSettings(routes)}:{})})).toString('base64url');};
}
function decodeInvitation(value, now=Date.now()) {
  if(typeof value==='string'&&value.trim().startsWith('self-live://'))throw invitationError('Este convite e do prototipo da main. Use o convite automatico do MVP nos dois PCs.','incompatible_invitation');
  if (typeof value !== 'string' || value.length > 16384 || !value.trim().startsWith(PREFIX)) throw invitationError('Cole o convite automatico recebido do MVP.');
  let parsed;
  try {const data=value.trim().slice(PREFIX.length).replace(/\s/g,'');if(!/^[a-z0-9_-]+$/i.test(data))throw new Error();parsed=JSON.parse(Buffer.from(data,'base64url').toString('utf8'));} catch {throw invitationError('Convite de internet invalido.');}
  if (parsed?.v !== 1 || (parsed.fingerprint!==undefined&&typeof parsed.fingerprint!=='string') || !/^[a-f0-9]{64}$/.test(parsed.room || '') || !/^[a-f0-9]{64}$/.test(parsed.secret || '') ||
      !/^[a-f0-9]{48}$/.test(parsed.token || '') || !/^[a-f0-9-]{36}$/.test(parsed.host || '') || !Number.isSafeInteger(parsed.expires))throw invitationError('Convite invalido.');
  if(parsed.expires<now)throw invitationError('Convite expirado. Peca um convite da captura atual.','expired_invitation');
  if(parsed.expires>now+25*3600000)throw invitationError('Confira a data e a hora dos dois PCs antes de usar o convite.','clock_skew');
  const direct=directSettings(parsed.direct);
  let config;
  if(parsed.url!==undefined){
    try {if(typeof parsed.url!=='string')throw new Error();config=readRelayConfig({SELF_LIVE_RELAY_URL:parsed.url,SELF_LIVE_RELAY_FINGERPRINT:parsed.fingerprint},'native');if(!config)throw new Error();}
    catch {throw invitationError('Relay do convite invalido.');}
  }
  if(!config&&!direct)throw invitationError('O convite nao possui uma rota de conexao.');
  return {v:1,...(config?{url:config.url,...(config.fingerprint?{fingerprint:config.fingerprint}:{})}:{}),...(direct?{direct}:{}),room:parsed.room,secret:parsed.secret,token:parsed.token,host:parsed.host,expires:parsed.expires};
}
function options(invite,role) {
  return {url:invite.url,fingerprint:invite.fingerprint,room:invite.room,hash:passwordHash(invite.secret,invite.room),key:relayKey(invite.secret,invite.room),role,...(role==='host'?{nodeId:invite.host}:{})};
}
function createInternetHost({config,token,accept,onStatus=()=>{},direct,Client=RelayClient,graceMs=90000}) {
  const invitation=createInvitation({config,token,direct}),invite=decodeInvitation(invitation());
  const relay=new Client(options(invite,'host')), sockets=new Map(), expiry=new Map();
  let closed=false;
  function clear(id) { clearTimeout(expiry.get(id));expiry.delete(id); }
  function expire(id) { if(sockets.has(id)&&!expiry.has(id))expiry.set(id,setTimeout(()=>{expiry.delete(id);sockets.get(id)?.close(1001,'Sinalizacao interrompida');},graceMs)); }
  relay.on('status',value=>{
    onStatus(value.state);
    if(value.state!=='online')for(const id of sockets.keys())expire(id);
  });
  relay.on('registered',peers=>{
    for(const id of sockets.keys())if(peers.some(peer=>peer.node_id===id))clear(id);else expire(id);
  });
  relay.on('presence',value=>{if(value.type==='user_left')expire(value.node_id);});
  relay.on('data',(body,from)=>{
    if(closed || !body || typeof body.sessionId!=='string' || !/^[a-f0-9-]{36}$/.test(body.sessionId))return;
    let socket=sockets.get(from);
    if(body.type==='join') {
      if(body.token!==token)return;
      clear(from);
      if(socket?.sessionId===body.sessionId){socket.replay();return;}
      socket?.close(1000,'Sessao substituida');
      socket=new EventEmitter();socket.readyState=1;socket.sessionId=body.sessionId;socket.cache=[];
      socket.send=raw=>{
        const value=JSON.parse(raw);
        if(['connecting','offer','ice'].includes(value.type)) {socket.cache.push(value);if(socket.cache.length>70)socket.cache.splice(1,1);}
        return relay.send(from,{...value,sessionId:socket.sessionId});
      };
      socket.replay=()=>{for(const value of socket.cache)relay.send(from,{...value,sessionId:socket.sessionId});};
      socket.close=(code=1000,reason='')=>{
        if(socket.readyState===3)return;socket.readyState=3;clear(from);
        if(sockets.get(from)===socket)sockets.delete(from);
        relay.send(from,{type:'transport-closed',sessionId:socket.sessionId,message:reason});socket.emit('close',code);
      };
      sockets.set(from,socket);accept(socket);socket.emit('message',Buffer.from(JSON.stringify(body)));return;
    }
    if(!socket || body.sessionId!==socket.sessionId)return;
    clear(from);
    if(body.type==='leave'){socket.close();return;}
    socket.emit('message',Buffer.from(JSON.stringify(body)));
  });
  relay.start();
  return {get invitation(){return invitation();},status:()=>relay.status.state,async close(){closed=true;for(const timer of expiry.values())clearTimeout(timer);expiry.clear();for(const socket of [...sockets.values()])socket.close();await relay.close();}};
}
function attachInternetViewer({client,invite,onStatus=()=>{},onProgress=()=>{},Client=RelayClient,timeoutMs=20000}) {
  const relay=new Client(options(invite,'viewer')),sessionId=randomUUID();
  let closed=false,connected=false,registered=false,hostSeen=false,closing,failureCode;
  const cache=[];
  const send=value=>{if(client.readyState===1)client.send(JSON.stringify(value));};
  function join() {hostSeen=true;onProgress('host_found');relay.send(invite.host,{type:'join',token:invite.token,sessionId});for(const value of cache)relay.send(invite.host,{...value,sessionId});}
  const deadline=setTimeout(()=>{if(!connected){const code=!registered?(failureCode||'relay_unavailable'):hostSeen?'handshake_timeout':'host_unavailable';send({type:'error',code,message:!registered?'Nao foi possivel acessar o relay de sinalizacao nesta rede.':'O transmissor nao confirmou este convite. Confira se a captura atual continua ativa.'});void close();}},timeoutMs);
  function close() {
    if(closing)return closing;closed=true;clearTimeout(deadline);client.off('message',message);
    closing=(async()=>{relay.send(invite.host,{type:'leave',sessionId});await relay.close();if(client.readyState===1)client.close(1000);})();return closing;
  }
  relay.on('registered',peers=>{registered=true;onProgress('relay_registered');if(peers.some(peer=>peer.node_id===invite.host&&peer.role==='host'))join();});
  relay.on('presence',value=>{if(value.node_id===invite.host&&value.type==='user_joined')join();});
  relay.on('status',value=>{onStatus(value.state);send({type:'signaling-status',state:value.state});});
  relay.on('failure',code=>{failureCode=code;onProgress(code);});
  relay.on('rejected',reason=>{send({type:'error',code:reason==='invalid_password'?'authentication':'relay_rejected',message:'O relay recusou este convite. Copie o convite da captura atual.'});void close();});
  relay.on('data',(body,from)=>{
    if(closed||from!==invite.host||body?.sessionId!==sessionId)return;
    if(body.type==='connecting'){connected=true;clearTimeout(deadline);}
    if(body.type==='transport-closed'){send({type:'error',message:body.message||'Transmissao encerrada.'});void close();return;}
    if(['connecting','offer','ice','error','stopped','peer-state'].includes(body.type))send(body);
  });
  function message(raw){
    try {
      const value=JSON.parse(raw.toString());
      if(!['answer','ice','sample'].includes(value.type))throw new Error();
      if(value.type==='answer'){cache.splice(0,cache.length,...cache.filter(item=>item.type!=='answer'));cache.unshift(value);}
      if(value.type==='ice'){if(cache.length>65)throw new Error();cache.push(value);}
      relay.send(invite.host,{...value,sessionId});
    } catch {send({type:'error',message:'Mensagem de sinalizacao invalida.'});void close();}
  }
  client.on('message',message);
  client.on('close',()=>void close());relay.start();
  return {close};
}
module.exports={decodeInvitation,createInvitation,createInternetHost,attachInternetViewer};

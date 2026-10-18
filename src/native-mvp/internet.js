const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { RelayClient, relayKey, readRelayConfig } = require('../main/relay-client');
const { passwordHash } = require('../shared/crypto');
const PREFIX='selflive-native://join/';
function decodeInvitation(value, now=Date.now()) {
  if (typeof value !== 'string' || value.length > 8192 || !value.trim().startsWith(PREFIX)) throw new Error('Cole um convite de internet do MVP C++.');
  let parsed;
  try { parsed=JSON.parse(Buffer.from(value.trim().slice(PREFIX.length),'base64url').toString('utf8')); } catch { throw new Error('Convite de internet invalido.'); }
  if (parsed?.v !== 1 || (parsed.fingerprint!==undefined&&typeof parsed.fingerprint!=='string') || !/^[a-f0-9]{64}$/.test(parsed.room || '') || !/^[a-f0-9]{64}$/.test(parsed.secret || '') ||
      !/^[a-f0-9]{48}$/.test(parsed.token || '') || !/^[a-f0-9-]{36}$/.test(parsed.host || '') || !Number.isSafeInteger(parsed.expires) || parsed.expires < now || parsed.expires > now+25*3600000) throw new Error('Convite invalido ou expirado.');
  const config=readRelayConfig({SELF_LIVE_RELAY_URL:parsed.url,SELF_LIVE_RELAY_FINGERPRINT:parsed.fingerprint},'native');
  if (!config || typeof parsed.url !== 'string') throw new Error('Relay do convite invalido.');
  return {v:1,url:config.url,...(config.fingerprint ? {fingerprint:config.fingerprint} : {}),room:parsed.room,secret:parsed.secret,token:parsed.token,host:parsed.host,expires:parsed.expires};
}
function options(invite,role) {
  return {url:invite.url,fingerprint:invite.fingerprint,room:invite.room,hash:passwordHash(invite.secret,invite.room),key:relayKey(invite.secret,invite.room),role,...(role==='host'?{nodeId:invite.host}:{})};
}
function createInternetHost({config,token,accept,onStatus=()=>{},Client=RelayClient,graceMs=90000}) {
  const invite={v:1,url:config.url,...(config.fingerprint?{fingerprint:config.fingerprint}:{}),room:randomBytes(32).toString('hex'),secret:randomBytes(32).toString('hex'),token,host:randomUUID(),expires:Date.now()+24*3600000};
  const invitation=PREFIX+Buffer.from(JSON.stringify(invite)).toString('base64url');
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
  return {invitation,status:()=>relay.status.state,async close(){closed=true;for(const timer of expiry.values())clearTimeout(timer);expiry.clear();for(const socket of [...sockets.values()])socket.close();await relay.close();}};
}
function attachInternetViewer({client,invite,onStatus=()=>{},Client=RelayClient,timeoutMs=20000}) {
  const relay=new Client(options(invite,'viewer')),sessionId=randomUUID();
  let closed=false,connected=false;
  const cache=[];
  const send=value=>{if(client.readyState===1)client.send(JSON.stringify(value));};
  function join() { relay.send(invite.host,{type:'join',token:invite.token,sessionId});for(const value of cache)relay.send(invite.host,{...value,sessionId}); }
  const deadline=setTimeout(()=>{if(!connected){send({type:'error',message:'Transmissor indisponivel. Confira se a captura e o convite continuam ativos.'});close();}},timeoutMs);
  async function close() {
    if(closed)return;closed=true;clearTimeout(deadline);
    relay.send(invite.host,{type:'leave',sessionId});await relay.close();if(client.readyState===1)client.close(1000);
  }
  relay.on('registered',peers=>{if(peers.some(peer=>peer.node_id===invite.host&&peer.role==='host'))join();});
  relay.on('presence',value=>{if(value.node_id===invite.host&&value.type==='user_joined')join();});
  relay.on('status',value=>{onStatus(value.state);send({type:'signaling-status',state:value.state});});
  relay.on('rejected',()=>{send({type:'error',message:'O relay recusou este convite.'});void close();});
  relay.on('data',(body,from)=>{
    if(closed||from!==invite.host||body?.sessionId!==sessionId)return;
    if(body.type==='connecting'){connected=true;clearTimeout(deadline);}
    if(body.type==='transport-closed'){send({type:'error',message:body.message||'Transmissao encerrada.'});void close();return;}
    if(['connecting','offer','ice','error','stopped'].includes(body.type))send(body);
  });
  client.on('message',raw=>{
    try {
      const value=JSON.parse(raw.toString());
      if(!['answer','ice','sample'].includes(value.type))throw new Error();
      if(value.type==='answer'){cache.splice(0,cache.length,...cache.filter(item=>item.type!=='answer'));cache.unshift(value);}
      if(value.type==='ice'){if(cache.length>65)throw new Error();cache.push(value);}
      relay.send(invite.host,{...value,sessionId});
    } catch {send({type:'error',message:'Mensagem de sinalizacao invalida.'});void close();}
  });
  client.on('close',()=>void close());relay.start();
  return {close};
}
module.exports={decodeInvitation,createInternetHost,attachInternetViewer};

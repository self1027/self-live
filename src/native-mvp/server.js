const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');
const { nativeIceConfiguration, STUN } = require('./ice-config');
const { createInternetHost, createInvitation, decodeInvitation } = require('./internet');
const { createDirectServer } = require('./direct');
const { attachAutomaticViewer } = require('./automatic');
const { buildAccessEndpoints } = require('../main/access-link');
const { getPreferredEndpoints } = require('../main/network');
const { createNativeNetwork } = require('./network');

const viewerFields = ['decodedFps','renderedFps','framesDecoded','framesDropped','freezeCount','totalFreezesDuration','receiveKbps','jitterMs','decodeMs','frameWidth','frameHeight','renderGapP95Ms','renderGapMaxMs'];
function cleanViewerSample(value) {
  const safe = { type:'receiver-sample', visible:value?.visible === true };
  for (const name of viewerFields) if (Number.isFinite(value?.[name]) && value[name] >= 0 && value[name] <= 1e12) safe[name] = value[name];
  if(['direct','relay','unknown'].includes(value?.transport?.mode))safe.transport={mode:value.transport.mode,
    localType:['host','srflx','prflx','relay'].includes(value.transport.localType)?value.transport.localType:null,
    remoteType:['host','srflx','prflx','relay'].includes(value.transport.remoteType)?value.transport.remoteType:null,
    protocol:['udp','tcp'].includes(value.transport.protocol)?value.transport.protocol:null,
    rttMs:Number.isFinite(value.transport.rttMs)&&value.transport.rttMs>=0?value.transport.rttMs:null};
  return safe;
}
async function createViewerServer({ native, onEvent = () => {}, addresses, bind = '0.0.0.0', relayConfig = null,
  iceProvider = () => ({iceServers:[{urls:STUN}],iceTransportPolicy:'all'}), InternetHost = createInternetHost, InternetViewer = attachAutomaticViewer,
  directEnabled = false, mediaRange, env = process.env }) {
  const ips = addresses || [...new Set(Object.values(networkInterfaces()).flat().filter(row => row?.family === 'IPv4' && !row.internal).map(row => row.address))];
  const hosts = new Set(['127.0.0.1', 'localhost', ...ips]);
  let token = null, viewer = null, generation = 0, active = false, internet = null, candidateCounts = {};
  let direct, network, invitation;
  const localIce=new Map(),mappedIce=new Set();
  const remote = new Map(), closingRelays=new Set();
  const retire=operation=>{const promise=Promise.resolve(operation).catch(()=>{});closingRelays.add(promise);promise.finally(()=>closingRelays.delete(promise));};
  const root = path.join(__dirname, 'ui');
  const assets = { '/viewer':['viewer.html','text/html; charset=utf-8'], '/viewer.js':['viewer.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'] };
  const server = http.createServer((request, response) => {
    const port = server.address()?.port;
    if (!hosts.has(request.headers.host?.replace(/:\d+$/, '')) || request.headers.host?.split(':')[1] !== String(port)) { response.writeHead(403).end(); return; }
    const asset = assets[request.url?.split('?')[0]];
    if (request.method !== 'GET' || !asset) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type':asset[1], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'" });
    fs.createReadStream(path.join(root, asset[0])).pipe(response);
  });
  const wss = new WebSocketServer({ noServer:true, maxPayload:128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const host = request.headers.host;
    const isRemote=request.url==='/remote-signal';
    if ((!isRemote && request.url !== '/signal') || !hosts.has(host?.replace(/:\d+$/, '')) || host?.split(':')[1] !== String(server.address()?.port) || request.headers.origin !== `http://${host}` ||
      (isRemote && !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress))) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client,isRemote));
  });
  const send = (client, value) => { if (client?.readyState === 1) client.send(JSON.stringify(value)); };
  const receiverEvent=(entry,event)=>{if(!entry.finished){onEvent(event);entry.onEvent?.(event);}};
  function advertiseMapped(value){
    if(!viewer||value.generation!==generation)return;
    const mapped=network?.mappedIce(value);if(!mapped||mappedIce.has(mapped.candidate))return;
    mappedIce.add(mapped.candidate);send(viewer,{type:'ice',...mapped});
    candidateCounts.srflx=(candidateCounts.srflx||0)+1;onEvent({type:'ice-candidates',counts:{...candidateCounts}});
  }
  function detach(client) {
    if (viewer !== client) return;
    viewer = null; generation++;
    void native.request('disconnect').catch(() => {});
    onEvent({type:'viewer-disconnected'});
  }
  function accept(client,isRemote=false) {
    if(isRemote) {
      const timer=setTimeout(()=>client.close(1008),5000);client.on('error',()=>{});
      client.alive=true;client.on('pong',()=>{client.alive=true;});
      client.once('close',()=>clearTimeout(timer));
      client.once('message',async raw=>{
        clearTimeout(timer);
        try {
          const value=JSON.parse(raw.toString()),entry=remote.get(value.token);
          if(value.type!=='join'||!entry||entry.client)throw new Error();
          clearTimeout(entry.expiry);entry.client=client;
          client.once('close',()=>{
            if(entry.client!==client)return;
            receiverEvent(entry,{type:'connection-stage',role:'receiver',stage:'closed'});
            entry.client=null;entry.closing=Promise.resolve(entry.session?.close()).catch(()=>{});retire(entry.closing);entry.session=null;
            if(remote.get(value.token)===entry)entry.expiry=setTimeout(()=>{remote.delete(value.token);entry.finished=true;entry.onClose?.();},90000);
          });
          await entry.closing;
          if(remote.get(value.token)!==entry||entry.client!==client||client.readyState!==1)return;
          entry.session=InternetViewer({client,invite:entry.invite,onEvent:event=>receiverEvent(entry,event),onSample:value=>receiverEvent(entry,cleanViewerSample(value))});
        } catch {send(client,{type:'error',code:'invalid_invitation',message:'O convite local do espectador nao esta mais ativo. Abra o convite novamente no MVP.'});client.close(1008,'Convite invalido.');}
      });return;
    }
    let authenticated = false, count = 0, rateSince = Date.now(), lastSample = 0, joinedGeneration, answer;
    const seenIce=new Set();
    client.alive = true; client.on('pong', () => { client.alive = true; });
    const deadline = setTimeout(() => client.close(1008, 'Convite ausente'), 5000);
    client.on('error', () => {});
    client.on('close', () => { clearTimeout(deadline); detach(client); });
    client.on('message', async raw => {
      try {
        if (Date.now() - rateSince > 1000) { rateSince = Date.now(); count = 0; }
        if (++count > 100) throw new Error('Limite de mensagens.');
        const value = JSON.parse(raw.toString());
        if (!authenticated) {
          const supplied = typeof value.token === 'string' ? Buffer.from(value.token) : Buffer.alloc(0);
          const expected = Buffer.from(token || '');
          if (value.type !== 'join' || !active || !token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Convite invalido ou captura parada.');
          if (viewer) { send(client,{type:'error',code:'viewer_busy',message:'O MVP aceita um espectador por vez.'}); client.close(1008); return; }
          authenticated = true; clearTimeout(deadline); viewer = client; joinedGeneration = ++generation;
          const [senderIce,receiverIce]=await Promise.all([iceProvider(),iceProvider()]);
          if(viewer!==client||joinedGeneration!==generation||!active)return;
          candidateCounts={host:0,srflx:0,prflx:0,relay:0};
          localIce.clear();mappedIce.clear();
          send(client,{type:'connecting',...receiverIce}); onEvent({type:'viewer-connected'});
          await native.request('connect',{generation:joinedGeneration,...nativeIceConfiguration(senderIce),...(mediaRange?{udpMin:mediaRange.min,udpMax:mediaRange.max}:{})});
          return;
        }
        if (viewer !== client || joinedGeneration !== generation) return;
        if (value.type === 'answer' && typeof value.sdp === 'string' && value.sdp.length <= 120000) {
          if(answer===value.sdp)return;
          if(answer)throw new Error('Resposta de outra negociacao.');
          answer=value.sdp;
          await native.request('answer',{generation:joinedGeneration,sdp:value.sdp});
        } else if (value.type === 'ice' && typeof value.candidate === 'string' && value.candidate.length <= 4096 && Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0 && value.sdpMLineIndex <= 8) {
          const key=value.sdpMLineIndex+':'+value.candidate;if(seenIce.has(key))return;
          if(seenIce.size>=64)throw new Error('Limite ICE.');seenIce.add(key);
          await native.request('ice',{generation:joinedGeneration,candidate:value.candidate,sdpMLineIndex:value.sdpMLineIndex});
        } else if (value.type === 'receiver-state' && ['new','connecting','connected','disconnected','failed','closed'].includes(value.state)) {
          // Local/LAN players report their media state on the same authenticated socket.
          return;
        } else if (value.type === 'sample' && Date.now() - lastSample >= 500) {
          lastSample = Date.now(); onEvent(cleanViewerSample(value));
        } else throw new Error('Mensagem invalida.');
      } catch (error) {
        send(client,{type:'error',code:authenticated?'negotiation_failed':'authentication',message:authenticated ? 'Falha na negociacao do espectador.' : 'Convite invalido ou captura parada.'});
        client.close(1008); detach(client);
        if (authenticated) onEvent({type:'viewer-error',message:'Falha na negociacao WebRTC.'});
      }
    });
  }
  wss.on('connection',accept);
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) { if (!client.alive) { client.terminate(); continue; } client.alive = false; client.ping(); }
  }, 10000); heartbeat.unref();
  const nativeEvent = value => {
    if (['offer','ice'].includes(value.type) && value.generation === generation) send(viewer,value);
    if(value.type==='ice'&&value.generation===generation) {
      const type=/\btyp (host|srflx|prflx|relay)\b/.exec(value.candidate||'')?.[1];
      if(type){candidateCounts[type]++;onEvent({type:'ice-candidates',counts:{...candidateCounts}});}
      if(localIce.size<64)localIce.set(value.candidate,value);advertiseMapped(value);
    }
    if(value.type==='peer-state'&&value.generation===generation) {
      send(viewer,value);onEvent(value);
    }
    if (['error','stopped'].includes(value.type)) {
      send(viewer,value); deactivate();
    }
  };
  native.on('event',nativeEvent);
  const helperExit = () => nativeEvent({type:'error',message:'O motor C++ encerrou.'});
  native.on('exit',helperExit);
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,bind,resolve); });
  try {
    if(directEnabled)direct=await createDirectServer({accept,bind:bind==='127.0.0.1'?bind:undefined});
    if(direct&&mediaRange){
      network=createNativeNetwork({servers:direct,udpPorts:mediaRange.ports,env:{...env,SELF_LIVE_UPNP:env.SELF_LIVE_UPNP||'auto'},onUpdate:event=>{
        onEvent(event);for(const value of localIce.values())advertiseMapped(value);
      }});
      void network.start().catch(()=>{});
    }
  } catch(error){clearInterval(heartbeat);native.off('event',nativeEvent);native.off('exit',helperExit);wss.close();server.close();await direct?.close();throw error;}
  const directRoutes=()=>direct?{fingerprint:direct.fingerprint,endpoints:network?network.endpoints():buildAccessEndpoints({endpoints:addresses?ips.map(ip=>({ip,family:'IPv4'})):getPreferredEndpoints(),wsPort:direct.wsPort,bindings:direct.bindings})}:undefined;
  function info() {
    const port = server.address()?.port;
    return { local:token ? `http://127.0.0.1:${port}/viewer#${token}` : null,
      lan:token ? ips.map(ip => `http://${ip}:${port}/viewer#${token}`) : [], internet:internet?.invitation || invitation?.() || null, signaling:internet?.status() || 'disabled',port,active,
      network:network?.snapshot() || null };
  }
  function deactivate() {
    active=false;token=null;invitation=null;localIce.clear();mappedIce.clear();if(internet){retire(internet.close());internet=null;}
    if(viewer){send(viewer,{type:'stopped'});viewer.close(1000);detach(viewer);}
  }
  return {
    info,
    activate() {
      deactivate();active=true;token=randomBytes(24).toString('hex');
      if(relayConfig)internet=InternetHost({config:relayConfig,token,accept,direct:directRoutes,onStatus:state=>onEvent({type:'signaling-status',state})});
      else if(direct)invitation=createInvitation({config:null,token,direct:directRoutes});
      return info();
    },
    deactivate,
    remoteViewer(invitation,callbacks={}) {
      if(remote.size>=4)throw new Error('Feche um espectador antes de abrir outro.');
      const invite=decodeInvitation(invitation),id=randomUUID();remote.set(id,{invite,onEvent:callbacks.onEvent,onClose:callbacks.onClose});
      return `http://127.0.0.1:${server.address().port}/viewer?remote=1#${id}`;
    },
    releaseRemote(url) {
      const id=new URL(url).hash.slice(1),entry=remote.get(id);if(!entry)return;
      remote.delete(id);clearTimeout(entry.expiry);entry.finished=true;if(entry.session)retire(entry.session.close());entry.client?.close(1000);entry.onClose?.();
    },
    async close() {
      clearInterval(heartbeat); native.off('event',nativeEvent); native.off('exit',helperExit);
      deactivate();
      for(const entry of remote.values()){clearTimeout(entry.expiry);entry.finished=true;if(entry.session)retire(entry.session.close());entry.onClose?.();}remote.clear();
      for (const client of wss.clients) client.terminate();
      await Promise.all([new Promise(resolve => wss.close(resolve)),new Promise(resolve => {server.close(resolve);server.closeAllConnections();}),network?.closePorts(),direct?.close(),...closingRelays]);
    }
  };
}
module.exports = { createViewerServer, cleanViewerSample };

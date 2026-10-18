const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const { WebSocketServer } = require('ws');

const viewerFields = ['decodedFps','renderedFps','framesDecoded','framesDropped','freezeCount','totalFreezesDuration','receiveKbps','jitterMs','decodeMs','frameWidth','frameHeight','renderGapP95Ms','renderGapMaxMs'];
function cleanViewerSample(value) {
  const safe = { type:'receiver-sample', visible:value?.visible === true };
  for (const name of viewerFields) if (Number.isFinite(value?.[name]) && value[name] >= 0 && value[name] <= 1e12) safe[name] = value[name];
  return safe;
}
async function createViewerServer({ native, onEvent = () => {}, addresses, bind = '0.0.0.0' }) {
  const ips = addresses || [...new Set(Object.values(networkInterfaces()).flat().filter(row => row?.family === 'IPv4' && !row.internal).map(row => row.address))];
  const hosts = new Set(['127.0.0.1', 'localhost', ...ips]);
  let token = null, viewer = null, generation = 0, active = false;
  const root = path.join(__dirname, 'ui');
  const assets = { '/viewer':['viewer.html','text/html; charset=utf-8'], '/viewer.js':['viewer.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'] };
  const server = http.createServer((request, response) => {
    const port = server.address()?.port;
    if (!hosts.has(request.headers.host?.replace(/:\d+$/, '')) || request.headers.host?.split(':')[1] !== String(port)) { response.writeHead(403).end(); return; }
    const asset = assets[request.url];
    if (request.method !== 'GET' || !asset) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type':asset[1], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'" });
    fs.createReadStream(path.join(root, asset[0])).pipe(response);
  });
  const wss = new WebSocketServer({ noServer:true, maxPayload:128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const host = request.headers.host;
    if (request.url !== '/signal' || !hosts.has(host?.replace(/:\d+$/, '')) || host?.split(':')[1] !== String(server.address()?.port) || request.headers.origin !== `http://${host}`) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
  });
  const send = (client, value) => { if (client?.readyState === 1) client.send(JSON.stringify(value)); };
  function detach(client) {
    if (viewer !== client) return;
    viewer = null; generation++;
    void native.request('disconnect').catch(() => {});
    onEvent({type:'viewer-disconnected'});
  }
  wss.on('connection', client => {
    let authenticated = false, count = 0, rateSince = Date.now(), iceCount = 0, lastSample = 0, joinedGeneration;
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
          if (viewer) { send(client,{type:'error',message:'O MVP aceita um espectador por vez.'}); client.close(1008); return; }
          authenticated = true; clearTimeout(deadline); viewer = client; joinedGeneration = ++generation;
          send(client,{type:'connecting'}); onEvent({type:'viewer-connected'});
          await native.request('connect',{generation:joinedGeneration});
          return;
        }
        if (viewer !== client || joinedGeneration !== generation) return;
        if (value.type === 'answer' && typeof value.sdp === 'string' && value.sdp.length <= 120000) {
          await native.request('answer',{generation:joinedGeneration,sdp:value.sdp});
        } else if (value.type === 'ice' && typeof value.candidate === 'string' && value.candidate.length <= 4096 && Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0 && value.sdpMLineIndex <= 8 && ++iceCount <= 64) {
          await native.request('ice',{generation:joinedGeneration,candidate:value.candidate,sdpMLineIndex:value.sdpMLineIndex});
        } else if (value.type === 'sample' && Date.now() - lastSample >= 500) {
          lastSample = Date.now(); onEvent(cleanViewerSample(value));
        } else throw new Error('Mensagem invalida.');
      } catch (error) {
        send(client,{type:'error',message:authenticated ? 'Falha na negociacao do espectador.' : 'Convite invalido ou captura parada.'});
        client.close(1008); detach(client);
        if (authenticated) onEvent({type:'viewer-error',message:'Falha na negociacao WebRTC.'});
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) { if (!client.alive) { client.terminate(); continue; } client.alive = false; client.ping(); }
  }, 10000); heartbeat.unref();
  const nativeEvent = value => {
    if (['offer','ice'].includes(value.type) && value.generation === generation) send(viewer,value);
    if (['error','stopped'].includes(value.type)) {
      send(viewer,value); active = false; token = null; viewer?.close(1000); if (viewer) detach(viewer);
    }
  };
  native.on('event',nativeEvent);
  const helperExit = () => nativeEvent({type:'error',message:'O motor C++ encerrou.'});
  native.on('exit',helperExit);
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,bind,resolve); });
  function info() {
    const port = server.address()?.port;
    return { local:token ? `http://127.0.0.1:${port}/viewer#${token}` : null,
      lan:token ? ips.map(ip => `http://${ip}:${port}/viewer#${token}`) : [], port, active };
  }
  return {
    info,
    activate() { if (viewer) { viewer.close(1000); detach(viewer); } active = true; token = randomBytes(24).toString('hex'); return info(); },
    deactivate() { active = false; token = null; if (viewer) { send(viewer,{type:'stopped'}); viewer.close(1000); detach(viewer); } },
    async close() {
      clearInterval(heartbeat); native.off('event',nativeEvent); native.off('exit',helperExit);
      active = false; token = null;
      for (const client of wss.clients) client.terminate();
      await Promise.all([new Promise(resolve => wss.close(resolve)),new Promise(resolve => server.close(resolve))]);
    }
  };
}
module.exports = { createViewerServer, cleanViewerSample };

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const selfsigned = require('selfsigned');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');
const { parseHello } = require('../shared/protocol');

const listen = (server, port = 0, host = '127.0.0.1', ipv6Only = false) => new Promise((resolve, reject) => {
  const failed = error => { server.off('listening', ready); reject(error); };
  const ready = () => { server.off('error', failed); resolve(server.address().port); };
  server.once('error', failed);
  server.once('listening', ready);
  server.listen({ port, host, ipv6Only });
});

async function startServers(roomName, hash, options = {}) {
  const room = new Room(roomName, hash);
  // Certificado efêmero: aceito somente pela sessão Electron desta instância.
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048, days: 1, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]
  });
  const tls = { key: cert.private, cert: cert.cert };
  const signaling = https.createServer(tls);
  const ipv4 = https.createServer(tls);
  const signalingServers = [signaling, ipv4];
  const wss = new WebSocketServer({ noServer: true, maxPayload: 262144 });
  let closing = false, closePromise;
  for (const server of signalingServers) {
    server.on('upgrade', (request, socket, head) => {
      if (closing) { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request));
    });
    // Requisições HTTPS comuns não são um endpoint do produto.
    server.on('request', (_req, res) => res.writeHead(404).end());
  }
  const relayTypes = new Set(['offer', 'answer', 'ice', 'watch_request', 'stop_watching', 'watch_stop', 'watch_rejected']);
  wss.on('connection', (socket, request) => {
    if (request.headers.origin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(request.headers.origin)) {
      socket.close(1008, 'Origem inválida'); return;
    }
    let id;
    let departed = false;
    const timeout = setTimeout(() => socket.close(1008, 'Handshake ausente'), 5000);
    socket.on('error', () => console.warn('[WSS] Falha no socket.'));
    socket.on('message', raw => {
      if (closing || departed) return;
      try {
        if (id) {
          const message = JSON.parse(raw.toString());
          if (message.type === 'goodbye') {
            if (message.node_id !== id) throw new Error('goodbye pertence a outro peer');
            departed = true;
            room.removePeer(id);
            socket.close(1000, 'goodbye');
            return;
          }
          if (['stream_started', 'stream_stopped'].includes(message.type)) {
            if (message.node_id !== id) throw new Error('Stream pertence a outro peer');
            if (message.type === 'stream_started') room.startStream(id, message);
            else room.stopStream(id, message.stream_id, message.reason);
            return;
          }
          // Autentica o remetente pelo socket. SDP/ICE permanecem opacos ao relay.
          if (!relayTypes.has(message.type) || message.from !== id || typeof message.to !== 'string' || message.to === id) {
            throw new Error('Envelope de sinalização inválido');
          }
          const destination = room.peers.get(message.to)?.socket;
          if (!destination || destination.readyState !== 1) {
            socket.send(JSON.stringify({ type: 'error', code: 'peer_not_found', to: message.to, session_id: message.session_id }));
            return;
          }
          destination.send(raw.toString());
          return;
        }
        const hello = parseHello(raw);
        if (!room.accepts(hello) || room.peers.has(hello.node_id)) {
          socket.close(1008, 'Credenciais ou identidade inválidas'); return;
        }
        clearTimeout(timeout);
        id = hello.node_id;
        const info = { node_id: id, name: typeof hello.name === 'string' ? hello.name.slice(0, 64) : id, endpoints: hello.endpoints };
        room.addPeer(id, socket, info);
        socket.send(JSON.stringify({ type: 'welcome', ...room.snapshot() }));
        room.announcePeer(id);
      } catch (error) {
        // JSON.parse e erros nativos podem incluir trechos da mensagem privada.
        console.warn('[WSS] Mensagem rejeitada; envelope ou autenticação inválidos.');
        socket.close(1008, 'Mensagem inválida');
      }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (id && room.peers.get(id)?.socket === socket) room.removePeer(id);
    });
  });
  const root = path.join(__dirname, '../renderer');
  const allowed = new Map([
    ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
    ['/webrtc.js', ['webrtc.js', 'text/javascript']], ['/shutdown.js', ['shutdown.js', 'text/javascript']],
    ['/ice.js', ['ice.js', 'text/javascript']], ['/connection-stats.js', ['connection-stats.js', 'text/javascript']],
    ['/application-audio.js', ['application-audio.js', 'text/javascript']], ['/audio-worklet.js', ['audio-worklet.js', 'text/javascript']],
    ['/share-wizard.js', ['share-wizard.js', 'text/javascript']],
    ['/capture-quality.js', ['capture-quality.js', 'text/javascript']],
    ['/ui-icons.js', ['ui-icons.js', 'text/javascript']],
    ['/media-audit.js', ['media-audit.js', 'text/javascript']],
    ['/signaling.js', ['signaling.js', 'text/javascript']],
    ['/styles.css', ['styles.css', 'text/css']]
  ]);
  const dashboard = http.createServer((req, res) => {
    const entry = allowed.get(req.url);
    if (!entry || req.method !== 'GET') { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', entry[1] + '; charset=utf-8');
    // Links podem incluir endpoints escolhidos após carregar o dashboard. O main
    // restringe WSS a essas URLs por webRequest e certificados por fingerprint.
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'`);
    fs.createReadStream(path.join(root, entry[0])).pipe(res);
  });
  try {
    let wsPort;
    const bindings = [];
    if (options.wsHost) {
      wsPort = await listen(signaling, options.wsPort, options.wsHost);
      bindings.push(options.wsHost);
    } else {
      // Dois sockets explícitos na mesma porta, sem depender do dual-stack do SO.
      try {
        wsPort = await listen(signaling, options.wsPort, '::', true);
        bindings.push('::');
      } catch (error) {
        if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error;
        console.warn('[Rede] IPv6 indisponível para listen; usando IPv4.');
      }
      wsPort = await listen(ipv4, wsPort ?? options.wsPort, '0.0.0.0');
      bindings.push('0.0.0.0');
    }
    const httpPort = await listen(dashboard, options.httpPort);
    return {
      url: `http://127.0.0.1:${httpPort}`, wsUrl: `wss://127.0.0.1:${wsPort}`,
      fingerprint: new X509Certificate(cert.cert).fingerprint256, room, wsPort, bindings,
      acceptRelaySocket(socket) { wss.emit('connection', socket, { headers: {} }); },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          // Anuncia saídas antes de fechar o relay. Peers lentos não seguram o app.
          for (const nodeId of [...room.peers.keys()]) room.removePeer(nodeId);
          const clientsClosed = new Promise(resolve => wss.close(resolve));
          for (const client of wss.clients) client.close(1000, 'Servidor encerrando');
          const deadline = setTimeout(() => {
            for (const client of wss.clients) client.terminate();
          }, 600);
          try {
            const closeHttp = server => new Promise(resolve => {
              server.close(resolve);
              server.closeAllConnections();
            });
            await Promise.all([clientsClosed, ...signalingServers.map(closeHttp), closeHttp(dashboard)]);
          } finally { clearTimeout(deadline); }
        })();
        return closePromise;
      }
    };
  } catch (error) {
    for (const client of wss.clients) client.terminate();
    wss.close(); signaling.close(); ipv4.close(); dashboard.close(); throw error;
  }
}
module.exports = { startServers };

const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const TYPES = new Set(['offer', 'answer', 'ice', 'watch_request', 'stop_watching',
  'watch_rejected', 'stream_started', 'stream_stopped', 'user_joined', 'user_left', 'goodbye']);
const text = (s, max = 128) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
const short = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
const sameHash = (a, b) => /^[a-f0-9]{64}$/.test(a || '') &&
  crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

async function startRelay({ key, cert, port = 8443, host = '0.0.0.0', maxRooms = 1000,
  maxPeersPerRoom = 30, maxRoomsPerIp = 10, idleMs = 60000, pongMs = 5000,
  log = console.info } = {}) {
  if (!key || !cert) throw new Error('TLS obrigatório para o relay.');
  const rooms = new Map(), ipRooms = new Map();
  const started = Date.now();
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size,
      peers: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0), uptime: Math.floor((Date.now() - started) / 1000) }));
  });
  const wss = new WebSocketServer({ server, path: '/', maxPayload: 256 * 1024, perMessageDeflate: false });
  const send = (ws, message) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.close(1008, 'slow_peer'); return; }
    ws.send(JSON.stringify(message));
  };
  const broadcast = (room, message, except) => {
    for (const [id, peer] of room.peers) if (id !== except) send(peer.ws, message);
  };
  let closing = false;
  wss.on('connection', (ws, req) => {
    if (closing) { ws.close(1001); return; }
    const ip = req.socket.remoteAddress; // Nunca confiar em X-Forwarded-For.
    let name, id, departed = false, last = Date.now(), pingAt = 0;
    let windowAt = Date.now(), count = 0;
    const handshake = setTimeout(() => ws.close(1008, 'register_timeout'), 5000);
    const leave = () => {
      if (departed) return;
      departed = true; clearTimeout(handshake);
      const room = rooms.get(name);
      if (!room || room.peers.get(id)?.ws !== ws) return;
      room.peers.delete(id);
      const counts = ipRooms.get(ip);
      if (counts) {
        const remaining = (counts.get(name) || 1) - 1;
        if (remaining) counts.set(name, remaining); else counts.delete(name);
        if (!counts.size) ipRooms.delete(ip);
      }
      log(`[relay] Peer ${short(id)} saiu da sala "${short(name)}"`);
      broadcast(room, { type: 'user_left', node_id: id }, id);
      if (!room.peers.size) { rooms.delete(name); log(`[relay] Sala "${short(name)}" encerrada`); }
    };
    ws.on('pong', () => { pingAt = 0; last = Date.now(); });
    const heartbeat = setInterval(() => {
      if (pingAt && Date.now() - pingAt >= pongMs) { leave(); ws.terminate(); }
      else if (!pingAt && Date.now() - last >= idleMs) { pingAt = Date.now(); ws.ping(); }
    }, Math.min(1000, pongMs));
    ws.on('message', (raw, binary) => {
      if (departed || closing) return;
      const now = Date.now(); last = now;
      if (now - windowAt >= 1000) { windowAt = now; count = 0; }
      if (++count > 100) { leave(); ws.close(4029, 'rate_limit'); return; }
      let m;
      try { if (binary) throw new Error(); m = JSON.parse(raw.toString()); }
      catch { ws.close(1008, 'invalid_envelope'); return; }
      if (!m || typeof m !== 'object') { ws.close(1008); return; }
      if (!id) {
        if (m.type !== 'register' || !text(m.room) || !text(m.node_id) ||
            !/^[a-f0-9]{64}$/.test(m.password_hash || '') || !['host', 'viewer'].includes(m.role)) {
          ws.close(1008, 'invalid_register'); return;
        }
        let room = rooms.get(m.room);
        if (room && !sameHash(m.password_hash, room.hash)) {
          send(ws, { type: 'register_rejected', reason: 'invalid_password' }); ws.close(4001, 'invalid_password'); return;
        }
        const counts = ipRooms.get(ip) || new Map();
        if ((!room && rooms.size >= maxRooms) || (!counts.has(m.room) && counts.size >= maxRoomsPerIp) ||
            (room && (room.peers.size >= maxPeersPerRoom || room.peers.has(m.node_id)))) {
          send(ws, { type: 'register_rejected', reason: 'capacity_or_identity' }); ws.close(4003); return;
        }
        name = m.room; id = m.node_id;
        if (!room) {
          room = { hash: m.password_hash, peers: new Map(), createdAt: now };
          rooms.set(name, room); log(`[relay] Sala "${short(name)}" criada (peer ${short(id)})`);
        }
        room.peers.set(id, { ws, role: m.role, joinedAt: now });
        counts.set(name, (counts.get(name) || 0) + 1); ipRooms.set(ip, counts);
        clearTimeout(handshake);
        send(ws, { type: 'registered', peers: [...room.peers].map(([node_id, p]) => ({ node_id, role: p.role })) });
        broadcast(room, { type: 'user_joined', node_id: id, role: m.role }, id);
        log(`[relay] Peer ${short(id)} entrou na sala "${short(name)}" (role: ${m.role})`);
        return;
      }
      if (!TYPES.has(m.type) || m.from !== id) return;
      if (m.type === 'goodbye') { leave(); ws.close(1000, 'goodbye'); return; }
      // O corpo cifrado é opaco. Não acessamos sdp, candidate ou payload.
      const destination = rooms.get(name)?.peers.get(m.to);
      if (destination) send(destination.ws, m);
    });
    ws.on('close', () => { clearInterval(heartbeat); leave(); });
    ws.on('error', () => { leave(); if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'socket_error'); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  let closePromise;
  return { server, rooms, port: server.address().port, close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = new Promise(resolve => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => { server.close(resolve); server.closeAllConnections(); });
    });
    return closePromise;
  } };
}
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.env.SELF_LIVE_RELAY_CONFIG || '/etc/self-live-relay/config.json'));
  startRelay({ ...config, key: fs.readFileSync(config.key || '/etc/self-live-relay/tls/key.pem'),
    cert: fs.readFileSync(config.cert || '/etc/self-live-relay/tls/cert.pem') }).then(relay => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => relay.close());
  }).catch(() => { console.error('[relay] Falha ao iniciar; verifique configuração e TLS.'); process.exitCode = 1; });
}
module.exports = { startRelay };

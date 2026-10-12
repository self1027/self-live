const { EventEmitter } = require('node:events');
const { createHash, scryptSync, randomBytes, randomUUID, createCipheriv, createDecipheriv, X509Certificate } = require('node:crypto');
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://relay.murilod.dev:8443';
const roomToken = room => createHash('sha256').update('self-live-relay-room\0' + room).digest('hex');
// Não usar password_hash como chave: o relay conhece esse autenticador.
const relayKey = (password, room) => scryptSync(password, 'self-live-relay-e2e\0' + room, 32);
function readRelayConfig(env = process.env, room) {
  const url = env.SELF_LIVE_RELAY_URL === undefined ? DEFAULT_URL : env.SELF_LIVE_RELAY_URL;
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('SELF_LIVE_RELAY_URL deve ser um endpoint wss://.');
  }
  const fingerprint = env.SELF_LIVE_RELAY_FINGERPRINT?.replace(/:/g, '').toUpperCase();
  if (fingerprint && !/^[A-F0-9]{64}$/.test(fingerprint)) throw new Error('Pin SHA-256 do relay inválido.');
  return { url: parsed.origin, fingerprint, room: roomToken(env.SELF_LIVE_RELAY_ROOM || room) };
}
function seal(key, envelope, body) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([envelope.type, envelope.from, envelope.to])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body)), cipher.final()]);
  return { ...envelope, payload: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64') };
}
function open(key, envelope) {
  if (typeof envelope.payload !== 'string') throw new Error('Corpo cifrado ausente');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.length < 29) throw new Error('Corpo cifrado inválido');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  cipher.setAAD(Buffer.from(JSON.stringify([envelope.type, envelope.from, envelope.to])));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}

class RelayClient extends EventEmitter {
  constructor({ url, fingerprint, room, hash, nodeId = randomUUID(), role, key, log = () => {} }) {
    super(); Object.assign(this, { url, fingerprint, room, hash, nodeId, role, key });
    this.log = log; this.reconnects = 0;
    this.attempt = 0; this.stopped = false; this.seen = new Set();
    this.status = this.snapshot('offline');
  }
  snapshot(state = this.status?.state || 'offline', backoff = this.status?.backoff || 0) {
    return { state, status: state, url: this.url, reconnects: this.reconnects, backoff };
  }
  update(state, backoff = 0) { this.status = this.snapshot(state, backoff); this.emit('status', this.status); }
  start() {
    if (this.stopped) return;
    clearInterval(this.countdown);
    this.update('connecting');
    // Com pin explícito, validar o certificado antes de enviar qualquer byte de registro.
    // Sem pin, exigir a cadeia de confiança normal (certificado público).
    const ws = this.ws = new WebSocket(this.url, { rejectUnauthorized: !this.fingerprint,
      handshakeTimeout: 5000, maxPayload: 262144, perMessageDeflate: false });
    let registered = false;
    const timer = setTimeout(() => ws.terminate(), 5000);
    ws.on('open', () => {
      if (this.fingerprint) {
        let actual;
        try { actual = new X509Certificate(ws._socket.getPeerCertificate().raw).fingerprint256.replace(/:/g, ''); } catch {}
        if (actual !== this.fingerprint) { this.emit('warning', 'TLS pin inválido'); ws.close(4002, 'invalid_pin'); return; }
      }
      this.log('[relay] Conectado');
      ws.send(JSON.stringify({ type: 'register', room: this.room, password_hash: this.hash, node_id: this.nodeId, role: this.role }));
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'register_rejected') {
        this.stopped = true; this.emit('rejected', m.reason); ws.close(m.reason === 'invalid_password' ? 4001 : 4003); return;
      }
      if (m.type === 'registered') {
        registered = true; this.everRegistered = true; clearTimeout(timer); this.attempt = 0; this.update('online');
        this.log('[relay] Sala registrada'); this.emit('registered', m.peers); return;
      }
      if (!registered) return;
      if (m.payload !== undefined) {
        if (m.to !== this.nodeId || this.seen.has(m.payload)) return;
        try {
          const body = open(this.key, m);
          this.seen.add(m.payload); if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value);
          this.emit('data', body, m.from);
        } catch { this.emit('warning', 'Mensagem cifrada rejeitada'); }
      } else if (['user_joined', 'user_left'].includes(m.type)) this.emit('presence', m);
    });
    ws.on('error', () => this.emit('warning', 'Relay indisponível; WSS local continua ativo'));
    ws.on('close', code => {
      clearTimeout(timer);
      if (this.stopped) { this.update('offline'); this.emit('closed', code); return; }
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
      this.reconnects++;
      this.log(`[relay] Reconectando (tentativa ${this.reconnects})`);
      const state = this.everRegistered ? 'reconnecting' : 'offline';
      this.update(state, delay / 1000);
      this.countdown = setInterval(() => {
        this.update(state, Math.max(0, this.status.backoff - 1));
      }, 1000);
      this.retry = setTimeout(() => this.start(), delay);
    });
  }
  send(to, body) {
    if (this.status.state !== 'online' || this.ws?.readyState !== WebSocket.OPEN) return false;
    // Todos os tipos internos, inclusive welcome/hello, ficam cifrados.
    const raw = JSON.stringify(seal(this.key, { type: 'offer', from: this.nodeId, to }, body));
    if (Buffer.byteLength(raw) > 262144 || this.ws.bufferedAmount > 1048576) {
      this.emit('warning', 'Mensagem relay excede limite'); return false;
    }
    this.ws.send(raw);
    return true;
  }
  close() {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.countdown);
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.ws.terminate(); resolve(); }, 600);
      this.ws.once('close', () => { clearTimeout(timer); resolve(); });
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'goodbye', from: this.nodeId })); this.ws.close(1000, 'goodbye');
      } else this.ws.terminate();
    });
  }
}

function attachHostRelay(servers, options) {
  const relay = new RelayClient({ ...options, role: 'host' });
  const virtual = new Map(), expiry = new Map();
  const expire = id => {
    if (expiry.has(id)) return;
    // Preservar PeerMedia durante uma queda breve; mídia já negociada é independente.
    expiry.set(id, setTimeout(() => {
      virtual.get(id)?.close(); virtual.delete(id); expiry.delete(id);
    }, 90000));
  };
  relay.on('data', (body, id) => {
    clearTimeout(expiry.get(id)); expiry.delete(id);
    let socket = virtual.get(id);
    if (!socket) {
      if (body.type !== 'hello' || body.node_id !== id) return;
      socket = new EventEmitter(); socket.readyState = 1;
      socket.send = raw => relay.send(id, JSON.parse(raw));
      socket.close = (code = 1000, reason = '') => {
        if (socket.readyState === 3) return;
        socket.readyState = 3; virtual.delete(id); socket.emit('close', code, reason);
        relay.send(id, { type: 'transport_closed', code, reason });
      };
      virtual.set(id, socket); servers.acceptRelaySocket(socket);
    } else if (body.type === 'hello') {
      if (!servers.room.accepts(body) || body.node_id !== id) { socket.close(4001, 'invalid_password'); return; }
      socket.send(JSON.stringify({ type: 'welcome', ...servers.room.snapshot() })); return;
    }
    socket.emit('message', Buffer.from(JSON.stringify(body)));
  });
  relay.on('presence', m => { if (m.type === 'user_left' && virtual.has(m.node_id)) expire(m.node_id); });
  relay.on('status', status => { if (status.state !== 'online') for (const id of virtual.keys()) expire(id); });
  relay.on('registered', peers => {
    const ids = new Set(peers.map(p => p.node_id));
    for (const id of virtual.keys()) if (!ids.has(id)) expire(id);
  });
  const stop = relay.close.bind(relay);
  relay.close = async () => {
    for (const timer of expiry.values()) clearTimeout(timer);
    expiry.clear();
    for (const socket of virtual.values()) socket.close(); virtual.clear();
    await stop();
  };
  relay.start(); return relay;
}

// API IPC restrita: o renderer nunca recebe chave, ws de Node ou opções de TLS.
function installRelayIpc({ ipcMain, trusted, getWindow, getAccess, getSecret, getHostRelay, log = () => {} }) {
  let viewer, hello, destination;
  const closeViewer = () => {
    const previous = viewer; viewer = null;
    if (previous) previous.send(destination, { type: 'goodbye', node_id: previous.nodeId });
    return previous?.close();
  };
  const emit = (kind, value) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('relay-event', { kind, value });
  };
  ipcMain.handle('relay-open', async (event, endpoint, greeting) => {
    trusted(event);
    const access = getAccess();
    const allowed = access?.endpoints.find(e => e.type === 'relay' && e.url === endpoint.url);
    const secret = getSecret();
    if (!allowed || !secret || greeting.room !== access.room || greeting.password_hash !== secret.hash) throw new Error('Relay não autorizado');
    await closeViewer(); hello = greeting; destination = allowed.host;
    const client = viewer = new RelayClient({ ...allowed, hash: secret.hash, key: secret.key, nodeId: greeting.node_id, role: 'viewer', log });
    // Convites identificam o host. URL forçada descobre o host registrado na sala.
    client.on('registered', peers => {
      if (viewer !== client) return;
      destination ||= peers.filter(p => p.role === 'host' && p.node_id !== client.nodeId)
        .map(p => p.node_id).sort()[0];
      if (destination) client.send(destination, hello);
    });
    client.on('presence', m => {
      if (viewer !== client || m.type !== 'user_joined') return;
      if (!destination && m.role === 'host') destination = m.node_id;
      if (m.node_id === destination) client.send(destination, hello);
    });
    client.on('data', (body, from) => {
      if (viewer !== client || from !== destination) return;
      if (body.type === 'transport_closed') emit('close', body);
      else emit('message', JSON.stringify(body));
    });
    client.on('status', s => { if (viewer === client) emit('status', s); });
    client.on('rejected', reason => { if (viewer === client) emit('close', { code: reason === 'invalid_password' ? 4001 : 4003, reason }); });
    client.start();
  });
  ipcMain.handle('relay-send', (event, raw) => {
    trusted(event);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 180000) throw new Error('Mensagem relay inválida');
    const body = JSON.parse(raw);
    if (body.from && body.from !== viewer?.nodeId || body.node_id && body.node_id !== viewer?.nodeId) throw new Error('Identidade inválida');
    viewer?.send(destination, body);
  });
  ipcMain.handle('relay-close', event => { trusted(event); return closeViewer(); });
  ipcMain.handle('relay-status', event => { trusted(event); return (viewer || getHostRelay())?.status ||
    { state: 'disabled', status: 'disabled', url: null, reconnects: 0, backoff: 0 }; });
  return { close: closeViewer };
}
module.exports = { RelayClient, readRelayConfig, roomToken, relayKey, seal, open, attachHostRelay, installRelayIpc };

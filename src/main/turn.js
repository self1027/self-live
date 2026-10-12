const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');

const DEFAULT_TTL = 3600;
const MIN_TTL = 60;
const MAX_TTL = 86400;

// TURN usa URIs sem "//"; aceitar só os campos suportados evita userinfo,
// caminhos e parâmetros inesperados chegarem à configuração do Chromium.
function parseTurnUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const urls = value.trim();
  const match = /^(turns?):(?:\[([a-f\d:.]+)\]|([^\s?/#:@]+))(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(urls);
  if (!match) return null;
  const [, scheme, ipv6, name, explicitPort, transport] = match;
  const host = ipv6 || name;
  if (ipv6 && isIP(ipv6) !== 6) return null;
  if (name && !isIP(name)) {
    if (/^[\d.]+$/.test(name) || name.length > 253 || !name.split('.').every(label =>
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return null;
  }
  const port = explicitPort === undefined ? (scheme.toLowerCase() === 'turns' ? 5349 : 3478) : Number(explicitPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // TURN sobre TLS é TCP. DTLS não é oferecido como "turns:?transport=udp"
  // pelo cliente WebRTC Chromium utilizado pelo app.
  if (scheme.toLowerCase() === 'turns' && transport?.toLowerCase() === 'udp') return null;
  return { urls, host, port };
}

function validTtl(ttl) {
  return Number.isInteger(ttl) && ttl >= MIN_TTL && ttl <= MAX_TTL;
}

function readTurnConfig(env = process.env, log = console) {
  const url = env.SELF_LIVE_TURN_URL;
  const secret = env.SELF_LIVE_TURN_SECRET;
  if (!url || !url.trim()) return null;
  if (typeof secret !== 'string' || !secret.trim()) {
    log.warn('[TURN] SELF_LIVE_TURN_URL definido sem SELF_LIVE_TURN_SECRET; usando apenas STUN.');
    return null;
  }
  const parsed = parseTurnUrl(url);
  const rawTtl = env.SELF_LIVE_TURN_TTL;
  const ttl = rawTtl === undefined || rawTtl === '' ? DEFAULT_TTL : /^\d+$/.test(rawTtl) ? Number(rawTtl) : NaN;
  if (!parsed || !validTtl(ttl) || secret.length > 4096 || /[\r\n\0]/.test(secret)) {
    log.warn('[TURN] Configuração inválida: use uma URL turn/turns e TTL inteiro entre 60 e 86400; usando apenas STUN.');
    return null;
  }
  const safeHost = isIP(parsed.host) ? '[IP oculto]' : parsed.host;
  log.info(`[TURN] TURN configurado: ${safeHost}:${parsed.port}, TTL=${ttl}s`);
  // Esta configuração permanece exclusivamente no processo main.
  return { urls: parsed.urls, secret, ttl };
}

function generateTurnCredentials(config, nodeId, { now = Date.now } = {}) {
  if (!config) return null;
  if (typeof nodeId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(nodeId)) {
    throw new TypeError('nodeId inválido para credenciais TURN.');
  }
  if (typeof config.secret !== 'string' || !config.secret || !validTtl(config.ttl) || !parseTurnUrl(config.urls)) {
    throw new TypeError('Configuração TURN inválida.');
  }
  const timestamp = now();
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new TypeError('Relógio inválido para credenciais TURN.');
  const username = `${Math.floor(timestamp / 1000) + config.ttl}:${nodeId}`;
  // Coturn TURN REST API: https://github.com/coturn/coturn/blob/master/README.turnserver
  const credential = createHmac('sha1', config.secret).update(username).digest('base64');
  return { username, credential, urls: config.urls };
}

module.exports = { readTurnConfig, generateTurnCredentials };

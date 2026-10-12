const { isIP } = require('node:net');
const { isGlobalIPv6, isPublicIPv4 } = require('./network');
const { roomToken } = require('./relay-client');

const priorities = { ipv6: 1, 'ipv4-direct': 2, 'ipv4-manual': 3, relay: 3, lan: 4, 'ipv4-local': 4 };
const mappingMethods = new Set(['pcp', 'nat-pmp', 'upnp']);
const fingerprintPattern = /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i;
const maxEndpoints = 16;

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
function wssUrl(ip, port) {
  return `wss://${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`;
}
function localIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// A lista anuncia só listeners realmente ativos. Em CGNAT, a porta do roteador
// não torna o IP de saída alcançável: não publicar um endpoint IPv4 externo.
function buildAccessEndpoints({ endpoints = [], publicIp, wsPort, mapping,
  networkStatus = 'unknown', bindings } = {}) {
  if (!validPort(wsPort)) return [];
  const listeners = Array.isArray(bindings) ? bindings : ['::', '0.0.0.0'];
  const bound = ip => listeners.includes(isIP(ip) === 6 ? '::' : '0.0.0.0') || listeners.includes(ip);
  const ipv4Bound = listeners.includes('0.0.0.0') || endpoints.some(endpoint => isIP(endpoint.ip) === 4 && bound(endpoint.ip));
  const state = typeof networkStatus === 'string' ? networkStatus : networkStatus?.ipv4Status || networkStatus?.status;
  const list = [];
  const seen = new Set();
  const add = (type, ip, port, method) => {
    const url = wssUrl(ip, port);
    if (seen.has(url)) return;
    seen.add(url);
    const endpoint = { type, url, priority: priorities[type] };
    if (method) endpoint.method = method;
    list.push(endpoint);
  };
  for (const endpoint of endpoints) {
    if (isGlobalIPv6(endpoint.ip) && bound(endpoint.ip)) add('ipv6', endpoint.ip, wsPort);
  }
  // O IP público na própria interface não depende de um mapeamento do NAT.
  for (const endpoint of endpoints) {
    if (isPublicIPv4(endpoint.ip) && bound(endpoint.ip)) add('ipv4-direct', endpoint.ip, wsPort);
  }
  if (ipv4Bound && isPublicIPv4(publicIp) && state !== 'cgnat') {
    if ((state === 'public' || state === 'nat') && validPort(mapping?.tcp?.externalPort) && mappingMethods.has(mapping.method)) {
      add('ipv4-direct', publicIp, mapping.tcp.externalPort, mapping.method);
    } else {
      // WAN indisponível/UPnP off ainda permite uma rota candidata para quem
      // configurou port forwarding. O tipo manual não garante alcance externo.
      add('ipv4-manual', publicIp, wsPort, 'manual');
    }
  }
  // Endpoints LAN/loopback preservam a validação entre instâncias locais; não
  // são apresentados como rotas públicas. Tentativas remotas seguem após elas.
  for (const endpoint of endpoints) {
    if (localIPv4(endpoint.ip) && bound(endpoint.ip)) add('ipv4-local', endpoint.ip, wsPort);
  }
  if (bound('127.0.0.1')) add('ipv4-local', '127.0.0.1', wsPort);
  return list.sort((a, b) => a.priority - b.priority).slice(0, maxEndpoints);
}

function invalid() {
  const error = new Error('Link de acesso inválido');
  error.code = 'ERR_ACCESS_LINK';
  return error;
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value, keys) {
  return Object.keys(value).every(key => keys.includes(key));
}
function safeText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateEndpoint(value) {
  if (!plainObject(value) || !onlyKeys(value, value.type === 'relay' ? ['type', 'url', 'priority', 'room', 'fingerprint', 'host'] : ['type', 'url', 'priority', 'method']) ||
      !Object.hasOwn(priorities, value.type) || value.priority !== priorities[value.type] ||
      typeof value.url !== 'string' || value.url.length > 256) throw invalid();
  let parsed;
  try { parsed = new URL(value.url); } catch { throw invalid(); }
  const ip = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.hash || parsed.search ||
      (parsed.pathname !== '/' && parsed.pathname !== '') || !validPort(Number(parsed.port || 443))) throw invalid();
  if (value.type === 'ipv6' && !isGlobalIPv6(ip)) throw invalid();
  if ((value.type === 'ipv4-direct' || value.type === 'ipv4-manual') && !isPublicIPv4(ip)) throw invalid();
  if (value.type === 'ipv4-local' && !localIPv4(ip)) throw invalid();
  if (value.type === 'lan' && !localIPv4(ip)) throw invalid();
  if (value.method !== undefined) {
    if (value.type === 'ipv4-direct' && !mappingMethods.has(value.method)) throw invalid();
    if (value.type === 'ipv4-manual' && value.method !== 'manual') throw invalid();
    if (value.type === 'ipv6' || value.type === 'ipv4-local' || value.type === 'lan') throw invalid();
  }
  const endpoint = { type: value.type, url: parsed.origin, priority: value.priority };
  if (value.type === 'relay') {
    if (!/^[a-f0-9]{64}$/.test(value.room || '') || (value.host !== undefined && !safeText(value.host, 128)) ||
        (value.fingerprint !== undefined && !/^[a-f0-9]{64}$/i.test(value.fingerprint))) throw invalid();
    endpoint.room = value.room;
    if (value.host !== undefined) endpoint.host = value.host;
    if (value.fingerprint) endpoint.fingerprint = value.fingerprint.toUpperCase();
  }
  if (value.method !== undefined) endpoint.method = value.method;
  return endpoint;
}

function validatePayload(payload) {
  if (!plainObject(payload) || !onlyKeys(payload, ['node_id', 'name', 'room', 'fingerprint', 'endpoints']) ||
      typeof payload.node_id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(payload.node_id) ||
      !safeText(payload.name, 64) || !safeText(payload.room, 128) ||
      typeof payload.fingerprint !== 'string' || !fingerprintPattern.test(payload.fingerprint) ||
      !Array.isArray(payload.endpoints) || !payload.endpoints.length || payload.endpoints.length > maxEndpoints) throw invalid();
  const endpoints = payload.endpoints.map(value => validateEndpoint(
    value?.type === 'relay' && value.room === undefined ? { ...value, room: roomToken(payload.room) } : value
  )).sort((a, b) => a.priority - b.priority);
  if (new Set(endpoints.map(endpoint => endpoint.url)).size !== endpoints.length) throw invalid();
  return { node_id: payload.node_id, name: payload.name, room: payload.room,
    fingerprint: payload.fingerprint.toUpperCase(), endpoints };
}

// O link contém endereço e pin TLS, nunca senha ou segredo TURN. Base64url é
// somente transporte de JSON; a senha da sala ainda é pedida ao entrar.
function encodeAccessLink(payload) {
  const data = Buffer.from(JSON.stringify(validatePayload(payload)), 'utf8').toString('base64url');
  return `self-live://join?data=${data}`;
}

function decodeAccessLink(link) {
  if (typeof link !== 'string' || link.length > 16384) throw invalid();
  let parsed;
  try { parsed = new URL(link); } catch { throw invalid(); }
  if (parsed.protocol !== 'self-live:' || parsed.hostname !== 'join' || parsed.username || parsed.password ||
      parsed.port || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/') ||
      [...parsed.searchParams.keys()].length !== 1 || !parsed.searchParams.has('data')) throw invalid();
  const data = parsed.searchParams.get('data');
  if (!data || !/^[a-z0-9_-]+$/i.test(data)) throw invalid();
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.toString('base64url') !== data || bytes.length > 12288) throw invalid();
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw invalid(); }
  return validatePayload(payload);
}

module.exports = { buildAccessEndpoints, encodeAccessLink, decodeAccessLink };

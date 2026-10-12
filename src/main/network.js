const os = require('node:os');
const { isIP } = require('node:net');

// Endereços unicast globais ficam em 2000::/3. Exclui documentação e escopos
// locais; detectar um endereço não garante rota externa nem liberação no firewall.
// Referência: https://www.iana.org/assignments/iana-ipv6-special-registry/
function globalIPv6(ip) {
  const parts = ip.split(':');
  const first = Number.parseInt(parts[0], 16);
  const second = Number.parseInt(parts[1] || '0', 16);
  const documentation = (first === 0x2001 && second === 0xdb8) || (first === 0x3fff && second < 0x1000);
  const benchmark = first === 0x2001 && second === 2 && Number.parseInt(parts[2] || '0', 16) === 0;
  return first >= 0x2000 && first <= 0x3fff && !documentation && !benchmark;
}
function privateIPv4([a, b]) {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function usableIPv4([a, b, c]) {
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, não público
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmark
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function getPreferredEndpoints(interfaces = os.networkInterfaces()) {
  const found = [];
  const seen = new Set();
  for (const [iface, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.internal) continue;
      const ip = address.address.split('%')[0];
      const version = isIP(ip);
      let priority;
      if (version === 6 && globalIPv6(ip)) priority = 0;
      else if (version === 4 && usableIPv4(ip.split('.').map(Number))) {
        priority = privateIPv4(ip.split('.').map(Number)) ? 1 : 2;
      } else continue;
      const key = `${iface}/${ip}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ip, family: version === 6 ? 'IPv6' : 'IPv4', iface, priority });
    }
  }
  // Mantém a ordem das interfaces dentro da mesma prioridade.
  return found.sort((a, b) => a.priority - b.priority).map(({ ip, family, iface }) => ({ ip, family, iface }));
}

function isGlobalIPv6(ip) {
  return typeof ip === 'string' && isIP(ip) === 6 && globalIPv6(ip);
}
function isPublicIPv4(ip) {
  if (typeof ip !== 'string' || isIP(ip) !== 4) return false;
  const parts = ip.split('.').map(Number);
  return usableIPv4(parts) && !privateIPv4(parts);
}

// O endereço observado permanece neste módulo do main. As funções de estado
// abaixo nunca devolvem o IP, evitando incluí-lo acidentalmente no IPC/logs.
let observedPublicIp = null;
let cachedObservation = null;
let cachedFetch = null;
let observationExpires = 0;
const observationTtlMs = 60000;

function getObservedPublicIp() {
  return observedPublicIp;
}

async function queryPublicIp({ fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  try {
    if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const check = (async () => {
      try {
        const response = await fetchImpl('https://api.ipify.org', {
          signal: controller.signal, redirect: 'error', cache: 'no-store', headers: { Accept: 'text/plain' }
        });
        if (!response.ok) return null;
        const ip = (await response.text()).trim();
        return isPublicIPv4(ip) ? ip : null;
      } catch {
        return null;
      }
    })();
    return await Promise.race([check, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Reutiliza a consulta do boot por um minuto. Fetch injetado em testes não usa
// o cache global, para manter os cenários independentes e determinísticos.
async function observePublicIp({ fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  const useCache = fetchImpl === globalThis.fetch;
  if (useCache && cachedFetch === fetchImpl && cachedObservation && Date.now() < observationExpires) {
    observedPublicIp = await cachedObservation;
    return observedPublicIp;
  }
  const observation = queryPublicIp({ fetchImpl, timeoutMs });
  if (useCache) {
    cachedObservation = observation;
    cachedFetch = fetchImpl;
    observationExpires = Date.now() + observationTtlMs;
  }
  const ip = await observation;
  observedPublicIp = ip;
  return ip;
}

// Mantém o estado informativo original. Divergência com o IP local, sozinha,
// indica NAT provável; não distingue NAT doméstico de CGNAT/NAT duplo.
async function detectCgnat({ endpoints, ...options } = {}) {
  const ip = await observePublicIp(options);
  if (!ip) return { status: 'unknown' };
  const local = endpoints || getPreferredEndpoints();
  return { status: local.some(endpoint => endpoint.ip === ip) ? 'direct' : 'nat' };
}

async function boundedResult(action, timeoutMs) {
  let timer;
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
    return await Promise.race([
      Promise.resolve().then(action).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Compara a saída IPv4 com a WAN que o roteador informou. WAN diferente é um
// indício de NAT a montante/CGNAT, não uma identificação da rede da operadora.
// IPv6 global mantém o estado geral public mesmo se o IPv4 tiver CGNAT.
// publicIp/Promise pode ser a observação anterior: não faz outra consulta HTTP.
async function detectDoubleNat({ endpoints = getPreferredEndpoints(), publicIp, publicIpPromise,
  getPublicIp, getWanAddress, timeoutMs = 2000 } = {}) {
  const ipv6 = endpoints.some(endpoint => isGlobalIPv6(endpoint.ip));
  let ipv4Status = 'unknown';
  const ip = await boundedResult(() => {
    if (publicIp !== undefined) return publicIp;
    if (publicIpPromise) return publicIpPromise;
    if (typeof getPublicIp === 'function') return getPublicIp();
    return getObservedPublicIp();
  }, timeoutMs);
  if (isPublicIPv4(ip)) {
    if (endpoints.some(endpoint => endpoint.ip === ip)) ipv4Status = 'public';
    else if (typeof getWanAddress === 'function') {
      const wan = await boundedResult(getWanAddress, timeoutMs);
      // WAN privada/100.64/10 é útil aqui; loopback/zero/multicast não são WAN.
      if (typeof wan === 'string' && isIP(wan) === 4) {
        const [a, b] = wan.split('.').map(Number);
        if (a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254)) {
          ipv4Status = wan === ip ? 'nat' : 'cgnat';
        }
      }
    }
  }
  return { status: ipv6 ? 'public' : ipv4Status, ipv4Status };
}

module.exports = { getPreferredEndpoints, detectCgnat, detectDoubleNat,
  getObservedPublicIp, observePublicIp, isGlobalIPv6, isPublicIPv4 };

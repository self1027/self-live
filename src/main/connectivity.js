const { createPortMapper } = require('./portmapper');
const { detectCgnat, detectDoubleNat, getObservedPublicIp } = require('./network');
const { buildAccessEndpoints } = require('./access-link');

function readPortMappingConfig(env = process.env) {
  const mode = env.SELF_LIVE_UPNP || 'on';
  if (!['on', 'off', 'auto'].includes(mode)) throw new Error('SELF_LIVE_UPNP deve ser on, off ou auto.');
  const ttl = Number(env.SELF_LIVE_UPNP_TTL || 7200);
  if (!Number.isInteger(ttl) || ttl < 1200 || ttl > 86400) throw new Error('SELF_LIVE_UPNP_TTL deve ser inteiro entre 1200 e 86400 segundos.');
  return { mode, ttl };
}

// Descoberta/mapeamento em segundo plano: captura e dashboard não aguardam o roteador.
function createConnectivity({ servers, endpoints, udpPorts, mode, ttl, onUpdate = () => {} }) {
  let closed = false, started, publicIp = null;
  let network = { status: 'unknown', ipv4Status: 'unknown' };
  let nat = { status: 'unknown' };
  let natReady = Promise.resolve(nat);
  const ipv6 = endpoints.some(endpoint => endpoint.family === 'IPv6');
  const localOnly = servers.bindings.every(host => ['127.0.0.1', '::1', 'localhost'].includes(host));
  const mapper = createPortMapper({ mode: localOnly ? 'off' : mode, onUpdate: () => publish() });
  const snapshot = () => ({ network, portMapping: mapper.getStatus(), wsPort: servers.wsPort, udpPorts, ipv6 });
  function publish() { if (!closed) onUpdate(snapshot()); }
  return {
    snapshot,
    // Private ICE socket metadata stays in this process, separate from snapshots.
    getMappedUdp() {
      if (closed || !['public', 'nat'].includes(network.ipv4Status)) return null;
      const lease = mapper.getMappedUdp();
      return lease?.externalHost === publicIp ? lease : null;
    },
    natStatus: () => natReady,
    endpoints: () => buildAccessEndpoints({ endpoints, publicIp, wsPort: servers.wsPort,
      mapping: mapper.getStatus(), networkStatus: network, bindings: servers.bindings }),
    start() {
      if (started || closed) return started;
      natReady = detectCgnat({ endpoints }).then(result => { nat = result; publicIp = getObservedPublicIp(); return result; });
      started = (async () => {
        const mapping = mode === 'off' || localOnly ? Promise.resolve(null)
          : mapper.openPorts({ tcpPort: servers.wsPort, udpPort: udpPorts[0], udpPorts, ttl });
        await Promise.allSettled([natReady, mapping]);
        if (closed) return;
        // A descoberta WAN pode tentar PMP e depois SOAP. O orçamento cobre
        // ambos sem interromper a UI, que já recebeu o estado de mapeamento.
        network = await detectDoubleNat({ endpoints, publicIp, timeoutMs: 8000,
          getWanAddress: mode === 'off' || localOnly ? undefined : () => mapper.getWanAddress() });
        publish();
      })().catch(() => { publish(); });
      publish();
      return started;
    },
    async closePorts() { closed = true; await mapper.closePorts(); }
  };
}
module.exports = { createConnectivity, readPortMappingConfig };

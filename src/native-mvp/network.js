const { isIPv4 } = require('node:net');
const { createConnectivity, readPortMappingConfig } = require('../main/connectivity');
const { getPreferredEndpoints, isPublicIPv4 } = require('../main/network');

function createNativeNetwork({ servers, udpPorts, env = process.env, onUpdate = () => {} }) {
  if (!Array.isArray(udpPorts) || !udpPorts.length || udpPorts.length > 64 ||
      udpPorts.some((port, index) => !Number.isInteger(port) || port < 1 || port > 65535 || port !== udpPorts[0] + index)) {
    throw new Error('Faixa UDP invalida.');
  }
  let closed = false;
  const connectivity = createConnectivity({ servers, udpPorts: [...udpPorts], endpoints: getPreferredEndpoints(),
    ...readPortMappingConfig(env), onUpdate(snapshot) {
      if (closed) return;
      const mapping = snapshot.portMapping;
      const event = { type: 'port-mapping', status: mapping.status };
      if (mapping.method) event.method = mapping.method;
      if (mapping.reason) event.reason = mapping.reason;
      try { onUpdate(event); } catch { /* Subscribers cannot interrupt discovery or cleanup. */ }
    }
  });
  return {
    start: () => connectivity.start(),
    endpoints: () => connectivity.endpoints(),
    snapshot: () => connectivity.snapshot(),
    mappedIce(value) {
      if (closed || !value || typeof value.candidate !== 'string' || value.candidate.length > 4096 ||
          /[\u0000-\u001f\u007f]/u.test(value.candidate) || !Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 ||
          !Number.isInteger(value.generation) || value.generation < 1) return null;
      const parts = value.candidate.trim().split(/ +/);
      if (!/^candidate:[a-z0-9+/]{1,32}$/i.test(parts[0]) || !/^[12]$/.test(parts[1]) || !/^udp$/i.test(parts[2]) ||
          !/^\d+$/.test(parts[3]) || Number(parts[3]) > 0xffffffff || !isIPv4(parts[4]) ||
          !/^\d+$/.test(parts[5]) || parts[6] !== 'typ' || parts[7] !== 'host' || parts.length % 2 !== 0) return null;
      const port = Number(parts[5]);
      const lease = connectivity.getMappedUdp();
      if (!lease || !isPublicIPv4(lease.externalHost) || parts[4] !== lease.internalHost || !udpPorts.includes(port)) return null;
      const mapped = lease.ports.find(entry => entry.internalPort === port);
      if (!mapped) return null;
      // A mapped address shares the actual ICE socket; only its type preference changes.
      const priority = 100 * 0x1000000 + Number(parts[3]) % 0x1000000;
      const suffix = parts.length > 8 ? ` ${parts.slice(8).join(' ')}` : '';
      return { candidate: `candidate:sl${parts[0].slice(10, 40)} ${parts[1]} UDP ${priority} ${lease.externalHost} ${mapped.externalPort} typ srflx raddr ${parts[4]} rport ${port}${suffix}`,
        sdpMLineIndex: value.sdpMLineIndex, generation: value.generation };
    },
    closePorts() { closed = true; return connectivity.closePorts(); }
  };
}

module.exports = { createNativeNetwork };

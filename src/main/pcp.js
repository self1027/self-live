// PCP MAP (RFC 6887). nat-port-mapper implements UPnP/NAT-PMP, but not PCP.
// A nonce belongs to this process and is reused on renewal/deletion, so another
// device's mapping is never deleted. Only the gateway's UDP replies are accepted.
const dgram = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { isIPv4 } = require('node:net');

function failure(code) { return Object.assign(new Error(code), { code }); }

function buildMapRequest({ address, port, protocol, ttl, nonce, preferFailure = true }) {
  if (!isIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !['tcp', 'udp'].includes(protocol) || !Buffer.isBuffer(nonce) || nonce.length !== 12 ||
      !Number.isInteger(ttl) || ttl < 0 || ttl > 0xffffffff) throw failure('INVALID_PCP_REQUEST');
  const request = Buffer.alloc(preferFailure ? 64 : 60);
  request[0] = 2; // PCP version; MAP opcode = 1.
  request[1] = 1;
  request.writeUInt32BE(ttl, 4);
  request[18] = request[19] = 0xff; // IPv4-mapped IPv6 client address.
  address.split('.').forEach((octet, index) => { request[20 + index] = Number(octet); });
  nonce.copy(request, 24);
  request[36] = protocol === 'tcp' ? 6 : 17;
  request.writeUInt16BE(port, 40);
  request.writeUInt16BE(port, 42);
  // IPv4-specific wildcard (::ffff:0.0.0.0), not the IPv6 wildcard ::.
  // The Suggested External IP's family must match the requested mapping.
  request[54] = request[55] = 0xff;
  // PREFER_FAILURE: retain the requested external port, or report a conflict.
  // This app does not advertise a remapped UDP port in ICE candidates.
  if (preferFailure) request[60] = 2;
  return request;
}

function parseMapResponse(message, request) {
  if (message.length < 24 || message[0] !== 2 || message[1] !== 0x81) return null;
  if (message[3] !== 0) throw failure(`PCP_${message[3]}`);
  if (message.length < 60 || !message.subarray(24, 36).equals(request.subarray(24, 36)) ||
      message[36] !== request[36] || message.readUInt16BE(40) !== request.readUInt16BE(40)) return null;
  const ipv4 = message.subarray(44, 54).every(byte => byte === 0) && message[54] === 0xff && message[55] === 0xff;
  return {
    externalPort: message.readUInt16BE(42),
    externalHost: ipv4 ? [...message.subarray(56, 60)].join('.') : null,
    lifetime: message.readUInt32BE(4)
  };
}

function createPcpGateway({ gateway, address, timeoutMs = 1800, createSocket = dgram.createSocket }) {
  if (!isIPv4(gateway) || !isIPv4(address)) throw failure('NO_GATEWAY');
  const entries = new Map();
  const active = new Set();
  let stopped = false;
  let preferFailure = true;

  function exchange(request, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted || stopped) { reject(failure('ABORTED')); return; }
      const socket = createSocket('udp4');
      let complete = false;
      let deadline;
      let repeat;
      const finish = (error, value) => {
        if (complete) return;
        complete = true;
        clearTimeout(deadline);
        clearInterval(repeat);
        signal?.removeEventListener('abort', abort);
        active.delete(cancel);
        try { socket.close(); } catch { /* socket may not have bound yet */ }
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(failure('ABORTED'));
      const cancel = () => finish(failure('ABORTED'));
      active.add(cancel);
      signal?.addEventListener('abort', abort, { once: true });
      socket.on('error', () => finish(failure('PCP_SOCKET_ERROR')));
      socket.on('message', (message, remote) => {
        if (remote.address !== gateway || remote.port !== 5351) return;
        try {
          const result = parseMapResponse(message, request);
          if (result) finish(null, result);
        } catch (error) { finish(error); }
      });
      deadline = setTimeout(() => finish(failure('TIMEOUT')), timeoutMs);
      socket.bind(0, address, () => {
        if (complete) return;
        const send = () => {
          if (!complete) socket.send(request, 5351, gateway, error => {
            if (error) finish(failure('PCP_SOCKET_ERROR'));
          });
        };
        send();
        // Retransmissions are bounded by the discovery deadline.
        repeat = setInterval(send, 500);
      });
    });
  }

  return {
    async map(port, internalHost, { protocol = 'tcp', ttl = 7200, signal } = {}) {
      if (internalHost !== address) throw failure('INVALID_PCP_REQUEST');
      const key = `${protocol}:${port}`;
      const entry = entries.get(key) || { port, protocol, nonce: randomBytes(12) };
      // Remember pending requests too: a lost response can hide a created lease.
      entries.set(key, entry);
      const requestedPreference = preferFailure;
      let response;
      try {
        response = await exchange(buildMapRequest({ address, port, protocol, ttl, nonce: entry.nonce,
          preferFailure: requestedPreference }), signal);
      } catch (error) {
        if (error.code !== 'PCP_5' || !requestedPreference) throw error;
        // PREFER_FAILURE is optional. Retry once without it, keeping the nonce;
        // portmapper still rejects and rolls back a different external port.
        preferFailure = false;
        response = await exchange(buildMapRequest({ address, port, protocol, ttl, nonce: entry.nonce,
          preferFailure: false }), signal);
      }
      entry.externalHost = response.externalHost;
      return { ...response, internalPort: port, internalHost, protocol: protocol.toUpperCase() };
    },
    async unmap(port, { protocol = 'tcp', signal } = {}) {
      const key = `${protocol}:${port}`;
      const entry = entries.get(key);
      if (!entry) return;
      try {
        await exchange(buildMapRequest({ address, port, protocol, ttl: 0, nonce: entry.nonce,
          preferFailure: false }), signal);
      } finally { entries.delete(key); }
    },
    async externalIp() {
      return [...entries.values()].find(entry => entry.externalHost)?.externalHost || null;
    },
    async stop() {
      stopped = true;
      for (const cancel of active) cancel();
      entries.clear();
    }
  };
}

module.exports = { createPcpGateway, buildMapRequest, parseMapResponse };

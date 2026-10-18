// Ports are leased only for this process. Each protocol is tried independently;
// partial attempts are rolled back before moving to PCP -> NAT-PMP -> UPnP.
const os = require('node:os');
const { isIPv4 } = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { findPackageJSON } = require('node:module');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPcpGateway } = require('./pcp');

const runFile = promisify(execFile);
const WAN_SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:2';
const failure = code => Object.assign(new Error(code), { code });
const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;

function reasonCode(error) {
  const code = String(error?.code || error?.name || 'UNAVAILABLE');
  const message = String(error?.message || ''); // Never log a gateway's raw error.
  if (/TIMEOUT|TimeoutError|AbortError|ABORTED/.test(code)) return 'timeout';
  if (/CONFLICT|PCP_11/.test(code) || /Code 718\b/.test(message)) return 'port_conflict';
  if (/NO_GATEWAY/.test(code)) return 'no_gateway';
  if (/PCP_2|^2$/.test(code) || /Code 606\b/.test(message)) return 'disabled';
  if (/UNSUPPORTED|PCP_1|PCP_4|PCP_5|^1$|^5$/.test(code) || /Code (401|725)\b/.test(message)) return 'unsupported';
  if (/INVALID/.test(code)) return 'invalid_configuration';
  return 'unavailable';
}

// WMIC is absent in recent Windows 11 releases. Read the actual route using
// PowerShell there, and use default-gateway on other operating systems.
async function defaultRoute() {
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference='Stop'; $routes=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object { $_.NextHop -ne '0.0.0.0' }; $route=$routes | Sort-Object @{Expression={ $_.RouteMetric + (Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex | Select-Object -First 1).InterfaceMetric }} | Select-Object -First 1; if (-not $route) { throw 'NoGateway' }; $address=Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1; @{gateway=$route.NextHop; address=$address.IPAddress; iface=$route.InterfaceAlias} | ConvertTo-Json -Compress";
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 2500, maxBuffer: 65536
    });
    const route = JSON.parse(stdout.trim());
    if (!isIPv4(route.gateway) || !isIPv4(route.address)) throw failure('NO_GATEWAY');
    return route;
  }
  const { gateway4async } = await import('default-gateway');
  const route = await gateway4async();
  const interfaces = os.networkInterfaces();
  const addresses = Object.entries(interfaces).flatMap(([iface, entries]) =>
    (entries || []).filter(entry => !entry.internal && isIPv4(entry.address)).map(entry => ({ ...entry, iface })));
  const integer = ip => ip.split('.').reduce((value, byte) => (value * 256 + Number(byte)) >>> 0, 0);
  const address = addresses.find(entry => entry.iface === route.int) || addresses.find(entry =>
    entry.netmask && (integer(entry.address) & integer(entry.netmask)) === (integer(route.gateway) & integer(entry.netmask)));
  if (!isIPv4(route.gateway) || !address) throw failure('NO_GATEWAY');
  return { gateway: route.gateway, address: address.address, iface: address.iface };
}

let libraryPromise;
async function getLibrary() {
  if (!libraryPromise) libraryPromise = (async () => {
    // The upstream debug logger prints raw addresses and SOAP. Suppress it even
    // if DEBUG=* was inherited; our own diagnostics use fixed reason codes.
    (await import('@libp2p/logger')).disable();
    return import('@achingbrain/nat-port-mapper');
  })();
  return libraryPromise;
}

function soapResult(response, action) {
  const key = Object.keys(response || {}).find(name => name.split(':').at(-1) === `${action}Response`);
  if (!key) throw failure('UNSUPPORTED');
  return response[key];
}

// The current upstream UPnP implementation deletes with an empty protocol and
// does not retain an AddAnyPortMapping's allocated external port. Use the
// discovered gateway's SOAP transport for exact-port, ownership-checked leases.
function upnpAdapter(gateway, description) {
  const owned = new Map();
  let wanAddress;
  let wanCheckedAt = 0;
  let wanPending;
  function externalIp(options) {
    if (wanAddress && Date.now() - wanCheckedAt < 10_000) return Promise.resolve(wanAddress);
    if (!wanPending) wanPending = Promise.resolve().then(() => gateway.externalIp(options)).then(address => {
      wanAddress = address;
      wanCheckedAt = Date.now();
      return address;
    }).finally(() => { wanPending = null; });
    return wanPending;
  }
  async function query(device, port, protocol, signal) {
    try {
      const response = await device.run(WAN_SERVICE, 'GetSpecificPortMappingEntry', [
        ['NewRemoteHost', ''], ['NewExternalPort', port], ['NewProtocol', protocol.toUpperCase()]
      ], { signal });
      return soapResult(response, 'GetSpecificPortMappingEntry');
    } catch (error) {
      if (/Code 714\b/.test(String(error?.message))) return null; // NoSuchEntryInArray.
      throw error;
    }
  }
  return {
    async map(port, address, { protocol, ttl, signal }) {
      const device = await gateway.getGateway({ signal });
      const existing = await query(device, port, protocol, signal);
      if (existing && (existing.NewInternalClient !== address || Number(existing.NewInternalPort) !== port ||
          existing.NewPortMappingDescription !== description)) throw failure('PORT_CONFLICT');
      // Remember the request before sending: if its reply is lost, an
      // ownership-checked deletion can still clean up the newly created lease.
      owned.set(`${protocol}:${port}`, { address, port, protocol });
      await device.run(WAN_SERVICE, 'AddPortMapping', [
        ['NewRemoteHost', ''], ['NewExternalPort', port], ['NewProtocol', protocol.toUpperCase()],
        ['NewInternalPort', port], ['NewInternalClient', address], ['NewEnabled', 1],
        ['NewPortMappingDescription', description], ['NewLeaseDuration', ttl]
      ], { signal });
      return { externalPort: port, internalPort: port, internalHost: address, protocol: protocol.toUpperCase(),
        externalHost: await externalIp({ signal }) };
    },
    async unmap(port, { protocol, signal }) {
      const key = `${protocol}:${port}`;
      const entry = owned.get(key);
      if (!entry) return;
      try {
        const device = await gateway.getGateway({ signal });
        const current = await query(device, port, protocol, signal);
        if (!current || current.NewInternalClient !== entry.address || Number(current.NewInternalPort) !== port ||
            current.NewPortMappingDescription !== description) return;
        await device.run(WAN_SERVICE, 'DeletePortMapping', [
          ['NewRemoteHost', ''], ['NewExternalPort', port], ['NewProtocol', protocol.toUpperCase()]
        ], { signal });
      } finally { owned.delete(key); }
    },
    externalIp,
    stop: options => gateway.stop(options)
  };
}

async function pmpFactory(route) {
  await getLibrary();
  // pmpNat() has no client-port option and upstream binds every instance to
  // 5350. Reuse its full decoder/queue, overriding only binding before its
  // constructor calls connect(). RFC 6886 allows an ephemeral source port.
  const packagePath = findPackageJSON('@achingbrain/nat-port-mapper', pathToFileURL(__filename));
  const { PMPGateway } = await import(pathToFileURL(join(dirname(packagePath), 'dist/src/pmp/gateway.js')).href);
  class EphemeralPmpGateway extends PMPGateway {
    connect() {
      if (this.connecting) return;
      this.connecting = true;
      this.socket.bind(0);
    }
  }
  const gateway = new EphemeralPmpGateway(route.gateway, { autoRefresh: false });
  // PMPGateway is an EventEmitter and can emit socket errors before a request.
  gateway.on('error', () => {});
  // Ignore unrelated/malformed replies before the upstream decoder, and retain
  // the granted lease lifetime for our renewal timer.
  const lifetimes = new Map();
  const decode = gateway.onMessage.bind(gateway);
  gateway.onMessage = (message, remote) => {
    if (remote.address !== route.gateway || remote.port !== 5351 || message.length < 8 || message[0] !== 0) return;
    if (message.readUInt16BE(2) === 0) {
      if (message[1] === 128 && message.length < 12) return;
      if ([129, 130].includes(message[1])) {
        if (message.length < 16) return;
        const request = gateway.req;
        if (request?.buf && request.buf.length >= 6 && request.buf.readUInt16BE(4) !== message.readUInt16BE(8)) return;
        lifetimes.set(`${message[1] === 130 ? 'tcp' : 'udp'}:${message.readUInt16BE(8)}`, message.readUInt32BE(12));
      }
    }
    try { decode(message, remote); } catch { /* malformed gateway response */ }
  };
  const map = gateway.map.bind(gateway);
  gateway.map = async (port, address, options) => {
    const result = await map(port, address, options);
    return { ...result, lifetime: lifetimes.get(`${options?.protocol || 'tcp'}:${port}`) };
  };
  return gateway;
}

async function upnpFactory(route, options) {
  const client = (await getLibrary()).upnpNat({ autoRefresh: false });
  for await (const gateway of client.findGateways({ signal: options.signal })) {
    if (gateway.family !== 'IPv4' || gateway.host !== route.gateway) {
      await gateway.stop({ signal: options.signal }).catch(() => {});
      continue;
    }
    return upnpAdapter(gateway, options.description);
  }
  throw failure('UNSUPPORTED');
}

function createPortMapper({ mode = 'on', onUpdate = () => {}, log = console, dependencies = {} } = {}) {
  const deps = {
    getRoute: defaultRoute,
    pcpGateway: route => createPcpGateway(route),
    pmpGateway: pmpFactory,
    upnpGateway: upnpFactory,
    setInterval, clearInterval, attemptTimeoutMs: 4000, cleanupTimeoutMs: 500,
    ...dependencies,
    // A whole UPnP range needs an ownership query and AddPortMapping per port.
    // Preserve the smaller injected test deadline unless explicitly overridden.
    upnpAttemptTimeoutMs: dependencies.upnpAttemptTimeoutMs ?? dependencies.attemptTimeoutMs ?? 12_000
  };
  const description = `Self Live ${process.pid} ${randomUUID()}`;
  let state = { tcp: null, udp: null, method: null, status: mode === 'off' ? 'disabled' : 'checking' };
  let active;
  let pending;
  let wanPending;
  let wanAddress;
  let interval;
  let renewing = false;
  let stopped = false;
  let closing;
  const operations = new Set();

  const getStatus = () => structuredClone(state);
  // Process-private socket metadata; never include these addresses in status/IPC.
  function getMappedUdp() {
    if (stopped || state.status !== 'mapped' || !active || active.retiring) return null;
    const entries = active.entries.filter(entry => entry.protocol === 'udp');
    if (!entries.length || entries.some(entry => !isIPv4(entry.externalHost) || entry.expiresAt <= Date.now()) ||
        entries.some(entry => entry.externalHost !== entries[0].externalHost)) return null;
    return { internalHost: active.route.address, externalHost: entries[0].externalHost,
      ports: entries.map(entry => ({ internalPort: entry.port, externalPort: entry.externalPort })) };
  }
  function update(next) {
    state = { ...next };
    try { onUpdate(getStatus()); } catch { /* UI subscribers cannot break cleanup */ }
  }
  function warn(reason) {
    if (mode !== 'auto') log.warn?.(`UPnP/NAT-PMP indisponível: ${reason}. Para conectar de fora, configure port forwarding manual ou use IPv6.`);
  }
  // The outer deadline also handles clients that forget to observe AbortSignal.
  async function bounded(action, timeoutMs = deps.attemptTimeoutMs) {
    const controller = new AbortController();
    operations.add(controller);
    let timer;
    let abort;
    const timeout = new Promise((_, reject) => {
      abort = () => reject(failure('ABORTED'));
      controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        controller.signal.removeEventListener('abort', abort);
        controller.abort();
        reject(failure('TIMEOUT'));
      }, timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => action(controller.signal)), timeout]); }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      controller.abort();
      operations.delete(controller);
    }
  }
  async function cleanup(attempt) {
    if (!attempt?.gateway) return;
    attempt.retiring = true;
    await bounded(async signal => {
      const settled = await Promise.allSettled(attempt.entries.map(entry => attempt.gateway.unmap(entry.port, {
        protocol: entry.protocol, externalPort: entry.externalPort || entry.port,
        autoRefresh: false, signal
      })));
      if (settled.some(result => result.status === 'rejected') && mode !== 'auto') log.warn?.('UPnP: remoção de lease indisponível; o TTL limita sua duração.');
    }, deps.cleanupTimeoutMs).catch(() => {
      if (mode !== 'auto') log.warn?.('UPnP: timeout ao remover leases; os mapeamentos restantes expiram pelo TTL.');
    });
    await bounded(signal => attempt.gateway.stop({ signal }), 75).catch(() => {});
  }
  async function mapAttempt(method, route, ports, ttl) {
    const attempt = { method, entries: [], gateway: null, route, ports, ttl };
    active = attempt;
    try {
      return await bounded(async signal => {
        attempt.gateway = await deps[`${method === 'nat-pmp' ? 'pmp' : method}Gateway`](route, { signal, description });
        if (stopped || signal.aborted) { await cleanup(attempt); throw failure('ABORTED'); }
        for (const entry of ports) {
          if (stopped || signal.aborted) throw failure('ABORTED');
          const options = { protocol: entry.protocol, externalPort: entry.port, ttl, autoRefresh: false, description, signal };
          // NAT-PMP 4.0.5 writes this ttl to the wire in seconds, unlike the
          // upstream TypeScript annotation. UPnP adapter/PCP also accept seconds.
          const tracked = { ...entry, externalPort: entry.port };
          attempt.entries.push(tracked);
          const requestedAt = Date.now();
          const mapping = await attempt.gateway.map(entry.port, route.address, options);
          tracked.externalPort = mapping.externalPort;
          tracked.externalHost = mapping.externalHost;
          tracked.expiresAt = requestedAt + (Number.isFinite(mapping.lifetime) ? mapping.lifetime : ttl) * 1000;
          if (stopped || signal.aborted) {
            await cleanup(attempt);
            throw failure('ABORTED');
          }
          if (isIPv4(mapping.externalHost)) wanAddress = mapping.externalHost;
          if (mapping.externalPort !== entry.port) throw failure('PORT_CONFLICT');
          if (Number.isFinite(mapping.lifetime) && mapping.lifetime <= 0) throw failure('UNAVAILABLE');
          if (Number.isFinite(mapping.lifetime) && mapping.lifetime < ttl) attempt.ttl = Math.min(attempt.ttl, mapping.lifetime);
        }
        if (stopped || signal.aborted) throw failure('ABORTED');
        return attempt;
      }, method === 'upnp' ? deps.upnpAttemptTimeoutMs : deps.attemptTimeoutMs);
    } catch (error) {
      await cleanup(attempt);
      if (active === attempt) active = null;
      throw error;
    }
  }
  function result(attempt) {
    const tcp = attempt.entries.find(entry => entry.protocol === 'tcp');
    const udp = attempt.entries.filter(entry => entry.protocol === 'udp');
    return {
      tcp: { externalPort: tcp.externalPort, protocol: 'tcp' },
      udp: { externalPort: udp[0].externalPort, protocol: 'udp', ports: udp.map(entry => ({
        internalPort: entry.port, externalPort: entry.externalPort, protocol: 'udp'
      })) },
      method: attempt.method
    };
  }
  function scheduleRenewal(attempt) {
    // Some gateways grant a shorter lease than requested. Respect that lease;
    // normal 7200s leases are renewed exactly ten minutes before expiry.
    const everyMs = Math.max(1000, (attempt.ttl > 600 ? attempt.ttl - 600 : attempt.ttl / 2) * 1000);
    interval = deps.setInterval(async () => {
      if (stopped || renewing || active !== attempt) return;
      renewing = true;
      let shorterLease = false;
      try {
        await bounded(async signal => {
          for (const entry of attempt.entries) {
            const requestedAt = Date.now();
            const mapping = await attempt.gateway.map(entry.port, attempt.route.address, {
              protocol: entry.protocol, externalPort: entry.externalPort, ttl: attempt.ttl,
              autoRefresh: false, description, signal
            });
            if (mapping.externalPort !== entry.externalPort) throw failure('PORT_CONFLICT');
            if (Number.isFinite(mapping.lifetime) && mapping.lifetime <= 0) throw failure('UNAVAILABLE');
            entry.externalHost = mapping.externalHost;
            entry.expiresAt = requestedAt + (Number.isFinite(mapping.lifetime) ? mapping.lifetime : attempt.ttl) * 1000;
            if (Number.isFinite(mapping.lifetime) && mapping.lifetime < attempt.ttl) {
              attempt.ttl = mapping.lifetime;
              shorterLease = true;
            }
          }
        }, attempt.method === 'upnp' ? deps.upnpAttemptTimeoutMs : deps.attemptTimeoutMs);
      } catch (error) {
        if (!stopped) {
          deps.clearInterval(interval);
          interval = null;
          await cleanup(attempt);
          if (active === attempt) active = null;
          update({ tcp: null, udp: null, method: null, status: 'unavailable', reason: reasonCode(error) });
          warn(reasonCode(error));
        }
      } finally {
        renewing = false;
        if (shorterLease && !stopped && active === attempt) {
          deps.clearInterval(interval);
          scheduleRenewal(attempt);
        }
      }
    }, everyMs);
    interval?.unref?.();
  }
  function openPorts({ tcpPort, udpPort, udpPorts = [udpPort], ttl = 7200 } = {}) {
    if (mode === 'off' || stopped) return Promise.resolve(null);
    if (pending) return pending;
    if (active?.entries.length && state.status === 'mapped') return Promise.resolve(result(active));
    pending = (async () => {
      if (!validPort(tcpPort) || !validPort(udpPort) || !Array.isArray(udpPorts) || !udpPorts.length ||
          udpPorts.length > 64 || udpPorts[0] !== udpPort || udpPorts.some(port => !validPort(port)) ||
          !Number.isInteger(ttl) || ttl < 1200 || ttl > 86400) {
        update({ tcp: null, udp: null, method: null, status: 'unavailable', reason: 'invalid_configuration' });
        warn('invalid_configuration');
        return null;
      }
      update({ tcp: null, udp: null, method: null, status: 'checking' });
      let route;
      try { route = await bounded(() => deps.getRoute(), 3000); }
      catch (error) {
        if (!stopped) { update({ tcp: null, udp: null, method: null, status: 'unavailable', reason: reasonCode(error) }); warn(reasonCode(error)); }
        return null;
      }
      const ports = [{ port: tcpPort, protocol: 'tcp' }, ...[...new Set(udpPorts)].map(port => ({ port, protocol: 'udp' }))];
      let reason;
      for (const method of ['pcp', 'nat-pmp', 'upnp']) {
        if (stopped) return null;
        try {
          const attempt = await mapAttempt(method, route, ports, ttl);
          if (stopped) { await cleanup(attempt); return null; }
          const mapped = result(attempt);
          update({ ...mapped, status: 'mapped' });
          log.info?.(`UPnP: porta TCP ${mapped.tcp.externalPort} mapeada via ${method}`);
          log.info?.(`UPnP: porta UDP ${mapped.udp.externalPort}${ports.length > 2 ? `–${mapped.udp.ports.at(-1).externalPort}` : ''} mapeada via ${method}`);
          scheduleRenewal(attempt);
          return mapped;
        } catch (error) {
          const nextReason = reasonCode(error);
          const rank = { port_conflict: 5, disabled: 4, timeout: 3, no_gateway: 2, unavailable: 1, unsupported: 0 };
          if (!reason || rank[nextReason] >= rank[reason]) reason = nextReason;
        }
      }
      if (!stopped) { update({ tcp: null, udp: null, method: null, status: 'unavailable', reason }); warn(reason); }
      return null;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function readWan() {
    if (mode === 'off') return null;
    if (pending) await pending;
    if (stopped) return null;
    if (isIPv4(wanAddress)) return wanAddress;
    let route;
    try { route = await bounded(() => deps.getRoute(), 3000); } catch { return null; }
    for (const method of ['pmp', 'upnp']) {
      if (stopped) return null;
      let gateway;
      try {
        const address = await bounded(async signal => {
          gateway = await deps[`${method}Gateway`](route, { signal, description });
          if (stopped || signal.aborted) throw failure('ABORTED');
          return gateway.externalIp({ signal });
        }, 2000);
        if (isIPv4(address)) { wanAddress = address; return address; }
      } catch { /* Read-only discovery is informational. */ }
      finally { if (gateway) await bounded(signal => gateway.stop({ signal }), 100).catch(() => {}); }
    }
    return null;
  }
  function getWanAddress() {
    if (!wanPending) wanPending = readWan().finally(() => { wanPending = null; });
    return wanPending;
  }
  function closePorts() {
    if (closing) return closing;
    stopped = true;
    if (interval) deps.clearInterval(interval);
    interval = null;
    for (const controller of operations) controller.abort();
    closing = cleanup(active).finally(() => {
      active = null;
      update({ tcp: null, udp: null, method: null, status: 'disabled' });
    });
    return closing;
  }
  return { openPorts, closePorts, getStatus, getWanAddress, getMappedUdp };
}

// Function exports also support callers that need a single mapper instance.
let singleton;
const getSingleton = () => singleton || (singleton = createPortMapper());
module.exports = {
  createPortMapper,
  openPorts: options => getSingleton().openPorts(options),
  closePorts: () => getSingleton().closePorts(),
  getWanAddress: () => getSingleton().getWanAddress(),
  reasonCode,
  upnpAdapter,
  pmpFactory
};

// Os smokes nunca abrem portas no roteador. O contrato IPC/preload é real;
// somente a descoberta externa e o resultado do mapeamento são simulados.
const { X509Certificate } = require('node:crypto');
const { encodeAccessLink, decodeAccessLink } = require('../src/main/access-link');
const { selectMediaPorts } = require('../src/main/media-ports');

async function setupSmokeConnectivity({ ipcMain, ses, servers, url, fingerprint, name, endpoints = [], relayEndpoint, room = 'smoke' }) {
  const mediaRange = await selectMediaPorts();
  let access = null, window;
  let state = { network: { status: 'unknown', ipv4Status: 'unknown' },
    portMapping: { tcp: null, udp: null, method: null, status: 'disabled' },
    wsPort: servers.wsPort, udpPorts: mediaRange.ports, ipv6: endpoints.some(e => e.family === 'IPv6') };
  let allowed = new Set([new URL(url).href]);
  let expected = fingerprint;
  const verify = (request, callback) => {
    let valid = false;
    try { valid = request.hostname === '127.0.0.1' && new X509Certificate(request.certificate.data).fingerprint256 === expected; } catch {}
    callback(valid ? 0 : -2);
  };
  ses.setCertificateVerifyProc(verify);
  ses.webRequest.onBeforeRequest({ urls: ['wss://*/*'] }, (details, callback) => {
    callback({ cancel: !allowed.has(new URL(details.url).href) });
  });
  ipcMain.handle('connectivity', () => state);
  ipcMain.handle('generate-access-link', (_event, nodeId) => encodeAccessLink(access || {
    node_id: nodeId, name, room, fingerprint: servers.fingerprint,
    endpoints: [{ type: 'ipv4-local', url: servers.wsUrl, priority: 4 }, ...(relayEndpoint ? [relayEndpoint] : [])]
  }));
  ipcMain.handle('use-access-link', (_event, link) => {
    access = link === '' ? null : decodeAccessLink(link);
    expected = access?.fingerprint || fingerprint;
    allowed = new Set((access?.endpoints || [{ url }]).map(e => new URL(e.url).href));
    if (process.env.SELF_LIVE_SMOKE_BLOCKED_TARGET) allowed.add(new URL(process.env.SELF_LIVE_SMOKE_BLOCKED_TARGET).href);
    ses.setCertificateVerifyProc(verify);
    return access;
  });
  return {
    getAccess: () => access,
    mediaRange,
    attach(value) { window = value; window.webContents.setWebRTCUDPPortRange({ min: mediaRange.min, max: mediaRange.max }); },
    update(value) { state = value; window.webContents.send('connectivity-update', state); }
  };
}
module.exports = { setupSmokeConnectivity };

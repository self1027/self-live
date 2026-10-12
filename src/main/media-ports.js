const dgram = require('node:dgram');

// Vários viewers e o loopback precisam de sockets distintos durante a negociação.
// A faixa é aplicada ao Chromium antes de qualquer RTCPeerConnection existir.
const MEDIA_PORT_COUNT = 16;
async function selectMediaPorts(preferredPort, count = MEDIA_PORT_COUNT) {
  if (preferredPort !== undefined && (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort + count - 1 > 65535)) {
    throw new Error(`SELF_LIVE_MEDIA_PORT deve permitir ${count} portas UDP entre 1024 e 65535.`);
  }
  for (let attempt = 0; attempt < (preferredPort === undefined ? 20 : 1); attempt++) {
    const sockets = [];
    try {
      const first = dgram.createSocket('udp4'); sockets.push(first);
      await bind(first, preferredPort || 0);
      const min = first.address().port;
      if (min + count - 1 > 65535) continue;
      for (let offset = 1; offset < count; offset++) {
        const socket = dgram.createSocket('udp4'); sockets.push(socket);
        await bind(socket, min + offset);
      }
      return { min, max: min + count - 1, ports: Array.from({ length: count }, (_, index) => min + index) };
    } catch {
      if (preferredPort !== undefined) throw new Error('Faixa UDP configurada indisponível. Escolha outro SELF_LIVE_MEDIA_PORT.');
    } finally {
      await Promise.all(sockets.map(socket => new Promise(resolve => {
        try { socket.close(resolve); } catch { resolve(); }
      })));
    }
  }
  throw new Error('Não foi possível selecionar uma faixa UDP livre para mídia.');
}
function bind(socket, port) {
  return new Promise((resolve, reject) => {
    const failed = error => { socket.off('listening', ready); reject(error); };
    const ready = () => { socket.off('error', failed); resolve(); };
    socket.once('error', failed); socket.once('listening', ready);
    socket.bind({ port, address: '0.0.0.0', exclusive: true });
  });
}
module.exports = { selectMediaPorts, MEDIA_PORT_COUNT };

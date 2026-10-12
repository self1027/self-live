// The integration test changes a real router only with explicit opt-in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');
const { createPortMapper } = require('../src/main/portmapper');

test('integração opcional: leases TCP/UDP no roteador real e limpeza', {
  skip: process.env.SELF_LIVE_TEST_UPNP !== '1' ? 'Defina SELF_LIVE_TEST_UPNP=1 para autorizar leases reais no roteador.' : false,
  timeout: 25_000
}, async t => {
  const tcp = net.createServer(socket => socket.destroy());
  const udp = dgram.createSocket('udp4');
  const mapper = createPortMapper({ mode: 'auto' });
  try {
    await new Promise((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen({ port: 0, host: '0.0.0.0' }, resolve);
    });
    await new Promise((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '0.0.0.0', resolve);
    });
    // Keep both sockets reserved until the router mappings have been removed.
    const tcpPort = tcp.address().port;
    const udpPort = udp.address().port;
    const result = await mapper.openPorts({ tcpPort, udpPort, ttl: 1200 });
    if (!result) { t.skip('Roteador/protocolo indisponível nesta rede.'); return; }
    assert.ok(['pcp', 'nat-pmp', 'upnp'].includes(result.method));
    assert.equal(result.tcp.externalPort, tcpPort);
    assert.equal(result.udp.externalPort, udpPort);
    assert.equal(mapper.getStatus().status, 'mapped');
  } finally {
    await mapper.closePorts();
    assert.equal(mapper.getStatus().status, 'disabled');
    await Promise.all([
      new Promise(resolve => { if (tcp.listening) tcp.close(resolve); else resolve(); }),
      new Promise(resolve => { try { udp.close(resolve); } catch { resolve(); } })
    ]);
  }
});

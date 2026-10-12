function parseHello(raw) {
  const message = JSON.parse(raw.toString());
  if (message.type !== 'hello' || typeof message.room !== 'string' ||
      typeof message.node_id !== 'string' || !message.node_id.length || message.node_id.length > 128 ||
      !Array.isArray(message.endpoints) || message.endpoints.length > 8 ||
      !message.endpoints.every(e => typeof e === 'string' && e.length < 256)) {
    throw new Error('Handshake inválido');
  }
  return message;
}
module.exports = { parseHello };

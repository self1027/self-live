const { equalHash } = require('../shared/crypto');

class Room {
  constructor(name, hash) {
    this.name = name;
    this.hash = hash;
    this.peers = new Map();
    // MVP: um stream ativo por peer. A mídia continua fora do relay.
    this.streams = new Map();
  }
  accepts(message) {
    return message.room === this.name && equalHash(message.password_hash, this.hash);
  }
  snapshot() {
    return { peers: [...this.peers.values()].map(p => p.info), streams: [...this.streams.values()] };
  }
  addPeer(nodeId, socket, info) {
    this.peers.set(nodeId, { socket, info: { ...info, streaming: false } });
  }
  announcePeer(nodeId) {
    this.broadcast({ type: 'user_joined', node_id: nodeId, info: this.peers.get(nodeId).info }, nodeId);
  }
  startStream(nodeId, message) {
    if (!this.peers.has(nodeId) || typeof message.stream_id !== 'string' ||
        !message.stream_id.length || message.stream_id.length > 128 || message.codec !== 'h264' ||
        typeof message.res !== 'string' || !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(message.res) ||
        !Number.isFinite(message.fps) || message.fps <= 0 || message.fps > 240 ||
        !Number.isInteger(message.bitrate) || message.bitrate <= 0 || message.bitrate > 100000000) {
      throw new Error('Metadados de stream inválidos');
    }
    const previous = this.streams.get(nodeId);
    if (previous?.stream_id === message.stream_id) return;
    if (previous) this.stopStream(nodeId, previous.stream_id);
    const stream = { type: 'stream_started', node_id: nodeId, stream_id: message.stream_id,
      codec: message.codec, res: message.res, fps: message.fps, bitrate: message.bitrate };
    this.streams.set(nodeId, stream);
    this.peers.get(nodeId).info.streaming = true;
    this.broadcast(stream);
  }
  stopStream(nodeId, streamId, reason) {
    const stream = this.streams.get(nodeId);
    // Um stop atrasado de um stream antigo não encerra a nova transmissão.
    if (!stream || stream.stream_id !== streamId) return;
    this.streams.delete(nodeId);
    const peer = this.peers.get(nodeId);
    if (peer) peer.info.streaming = false;
    const event = { type: 'stream_stopped', node_id: nodeId, stream_id: streamId };
    if (reason === 'peer_shutdown') event.reason = reason;
    this.broadcast(event);
  }
  removePeer(nodeId) {
    if (!this.peers.has(nodeId)) return; // goodbye e close não duplicam user_left.
    this.peers.delete(nodeId);
    const stream = this.streams.get(nodeId);
    if (stream) this.stopStream(nodeId, stream.stream_id, 'peer_shutdown');
    this.broadcast({ type: 'user_left', node_id: nodeId });
  }
  broadcast(message, excludeId) {
    for (const [nodeId, { socket }] of this.peers) {
      if (nodeId === excludeId) continue;
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    }
  }
}
module.exports = { Room };

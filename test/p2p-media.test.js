const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../scripts/load-renderer-module');
test('temporary track end delegates to capture recovery without sending stream_stopped',async()=>{
  const {PeerMedia}=await loadRenderer('webrtc.js');
  const track=new EventTarget();track.kind='video';track.getSettings=()=>({width:1280,height:720,frameRate:60});track.stop=()=>{};
  const stream={active:true,recoverVideoCapture:true,getVideoTracks:()=>[track],getTracks:()=>[track]};
  const messages=[];const media=new PeerMedia({nodeId:'host',send:value=>messages.push(value),video:{srcObject:null},report(){}});
  await media.startStreaming({stream});const id=media.streamId;track.dispatchEvent(new Event('ended'));
  assert.equal(media.stream,stream);assert.equal(media.streamId,id);assert.ok(!messages.some(value=>value.type==='stream_stopped'));
  media.stopStreaming();assert.equal(messages.at(-1).type,'stream_stopped');
});

test('ICE anterior ao SDP aguarda; troca de viewer ignora sessão antiga e peer inativo rejeita watch', async t => {
  const original = globalThis.RTCPeerConnection;
  t.after(() => { if (original) globalThis.RTCPeerConnection = original; else delete globalThis.RTCPeerConnection; });
  class FakeConnection {
    constructor() { this.remoteDescription = null; this.candidates = []; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate(candidate) {
      assert.ok(this.remoteDescription, 'ICE nunca pode ser aplicado antes do SDP');
      this.candidates.push(candidate);
    }
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    close() { this.closed = true; }
  }
  globalThis.RTCPeerConnection = FakeConnection;
  const { PeerMedia } = await loadRenderer('webrtc.js');
  const messages = [];
  const media = new PeerMedia({ nodeId: 'viewer', send: message => messages.push(message), video: { srcObject: null }, report: () => {} });
  await media.startWatching('host');
  const first = media.watching;
  const envelope = { from: 'host', to: 'viewer', session_id: first.sessionId };
  const candidate = { candidate: 'candidate-before-sdp' };
  await media.handleMessage({ ...envelope, type: 'ice', candidate });
  assert.equal(first.pc.candidates.length, 0);
  await media.handleMessage({ ...envelope, type: 'offer', sdp: 'offer-sdp' });
  assert.deepEqual(first.pc.candidates, [candidate]);
  assert.equal(messages.at(-1).type, 'answer');
  await media.startWatching('other-host');
  assert.equal(first.pc.closed, true);
  assert.equal(messages.at(-2).type, 'stop_watching');
  assert.equal(messages.at(-2).to, 'host');
  const count = messages.length;
  await media.handleMessage({ ...envelope, type: 'offer', sdp: 'late-offer' });
  assert.equal(messages.length, count);
  assert.equal(media.watching.peerId, 'other-host');
  await media.handleMessage({ type: 'stream_stopped', node_id: 'host', stream_id: 'old-stream' });
  assert.equal(media.watching.peerId, 'other-host', 'Stop de outro streamer não afeta o viewer');
  await media.handleMessage({ type: 'watch_request', from: 'host', to: 'viewer', session_id: 'uninvited' });
  assert.equal(messages.at(-1).type, 'watch_rejected');
  assert.equal(media.stream, null, 'Pedido remoto nunca inicia captura');
  media.close();
});

test('streamer compartilha captura com dois viewers e stop_watching fecha somente o remetente', async t => {
  const originalPC = globalThis.RTCPeerConnection, originalSender = globalThis.RTCRtpSender;
  t.after(() => {
    if (originalPC) globalThis.RTCPeerConnection = originalPC; else delete globalThis.RTCPeerConnection;
    if (originalSender) globalThis.RTCRtpSender = originalSender; else delete globalThis.RTCRtpSender;
  });
  class FakeConnection {
    constructor() { this.tracks = []; }
    addTransceiver(track) { this.tracks.push(track); return { setCodecPreferences() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'opaque' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    close() { this.closed = true; }
  }
  globalThis.RTCPeerConnection = FakeConnection;
  globalThis.RTCRtpSender = { getCapabilities: kind => ({ codecs: [{ mimeType: kind === 'video' ? 'video/H264' : 'audio/opus' }] }) };
  const { PeerMedia } = await loadRenderer('webrtc.js');
  let stopped = 0;
  const video = { kind: 'video', addEventListener() {}, getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }), stop: () => stopped++ };
  const audio = { kind: 'audio', stop: () => stopped++ };
  const stream = { active: true, getVideoTracks: () => [video], getTracks: () => [video, audio] };
  const messages = [];
  const media = new PeerMedia({ nodeId: 'host', send: m => messages.push(m), video: { srcObject: null }, report() {} });
  await media.startStreaming({ stream });
  const streamId = media.streamId;
  assert.equal(messages[0].type, 'stream_started');
  for (const viewer of ['a', 'b']) {
    await media.handleMessage({ type: 'watch_request', from: viewer, to: 'host', session_id: viewer, stream_id: streamId });
  }
  assert.equal(media.viewerConnections.size, 2);
  const connectionA = media.viewerConnections.get('a'), connectionB = media.viewerConnections.get('b');
  assert.notEqual(connectionA, connectionB);
  assert.deepEqual(connectionA.tracks, [video, audio]);
  assert.deepEqual(connectionB.tracks, [video, audio]);
  await media.handleMessage({ type: 'stop_watching', from: 'a', to: 'host', session_id: 'a' });
  assert.equal(connectionA.closed, true);
  assert.equal(connectionB.closed, undefined);
  assert.equal(media.viewerConnections.size, 1);
  assert.equal(stopped, 0, 'Parar viewer preserva captura compartilhada');
  media.stopStreaming();
  assert.equal(connectionB.closed, true);
  assert.equal(media.viewerConnections.size, 0);
  assert.equal(stopped, 2);
  assert.deepEqual(messages.at(-1), { type: 'stream_stopped', node_id: 'host', stream_id: streamId });
});

test('troca e shutdown durante geração IPC não reabrem uma conexão antiga', async t => {
  const original = globalThis.RTCPeerConnection;
  t.after(() => { if (original) globalThis.RTCPeerConnection = original; else delete globalThis.RTCPeerConnection; });
  const connections = [], requests = [];
  globalThis.RTCPeerConnection = class {
    constructor(config) { this.config = config; connections.push(this); }
    close() { this.closed = true; }
  };
  const { PeerMedia } = await loadRenderer('webrtc.js');
  const messages = [];
  const media = new PeerMedia({ nodeId: 'viewer', send: m => messages.push(m), video: {}, report() {},
    iceFactory: () => new Promise(resolve => requests.push(resolve)) });
  const first = media.startWatching('a');
  const second = media.startWatching('b');
  requests[0]([{ urls: 'turn:example.test', username: '1', credential: 'temporary' }]);
  await first;
  assert.equal(connections[0].closed, true);
  assert.equal(messages.length, 0, 'Tentativa antiga não envia watch_request');
  requests[1]([]); await second;
  assert.equal(media.watching.peerId, 'b');
  assert.equal(messages.at(-1).to, 'b');
  const third = media.startWatching('c');
  media.close();
  requests[2]([]); await third;
  assert.equal(media.watching, null);
  assert.ok(connections.every(pc => pc.closed));
});

test('prazo de conexão fecha receiver e avisa streamer sem promise rejeitada', async t => {
  const original = globalThis.RTCPeerConnection;
  t.after(() => { if (original) globalThis.RTCPeerConnection = original; else delete globalThis.RTCPeerConnection; });
  globalThis.RTCPeerConnection = class { close() { this.closed = true; } };
  const { PeerMedia } = await loadRenderer('webrtc.js');
  const messages = [], diagnostics = [];
  const media = new PeerMedia({ nodeId: 'viewer', send: m => messages.push(m), video: {}, report() {},
    diagnostics: d => diagnostics.push(d), connectionTimeoutMs: 20 });
  await media.startWatching('host');
  const pc = media.watching.pc;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(pc.closed, true);
  assert.equal(media.watching, null);
  assert.equal(messages.at(-1).type, 'stop_watching');
  assert.equal(diagnostics.at(-1).mode, 'failed');
  media.close();
});

test('amostra atrasada não sobrescreve falha e outgoing não interfere no viewer', async t => {
  const original = globalThis.RTCPeerConnection;
  t.after(() => { if (original) globalThis.RTCPeerConnection = original; else delete globalThis.RTCPeerConnection; });
  let resolveStats;
  globalThis.RTCPeerConnection = class {
    constructor() { this.connectionState = 'new'; }
    getStats() { return new Promise(resolve => { resolveStats = resolve; }); }
    close() { this.connectionState = 'closed'; }
  };
  const { PeerMedia } = await loadRenderer('webrtc.js');
  const diagnostics = [], reports = [];
  const media = new PeerMedia({ nodeId: 'viewer', send() {}, video: {}, report: text => reports.push(text), diagnostics: d => diagnostics.push(d) });
  await media.startWatching('host');
  const receiver = media.watching;
  receiver.pc.connectionState = 'connected';
  receiver.pc.onconnectionstatechange();
  receiver.pc.connectionState = 'disconnected';
  receiver.pc.onconnectionstatechange();
  resolveStats(new Map());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(diagnostics.at(-1).mode, 'failed');
  const count = reports.length;
  const sender = await media.createConnection('another-viewer', 'session', 'send', 'stream');
  sender.pc.connectionState = 'failed'; sender.pc.onconnectionstatechange();
  assert.equal(reports.length, count, 'Falha de um viewer de envio não substitui o status recebido');
  media.closeConnection(sender); media.close();
});

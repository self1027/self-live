import { buildIceServers } from './ice.js';
import { getConnectionDiagnostics } from './connection-stats.js';
import { attachApplicationAudio } from './application-audio.js';
import { captureSize, resolutions, captureRates, captureModes, constrainCapture } from './capture-quality.js';

// Constraints compartilhadas pela prévia e pelo teste de codificação local.
export async function captureSystemMedia({ resolution = 'auto', fps = 60, original, videoOnly = false } = {}) {
  if ((!captureModes.includes(resolution) && !resolutions.includes(Number(resolution))) || !captureRates.includes(Number(fps))) throw new Error('Qualidade de captura inválida.');
  const target = captureSize(original?.width, original?.height, resolution);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: 1920, ideal: target.width }, height: { max: 1080, ideal: target.height }, frameRate: { ideal: Number(fps), max: Number(fps) } },
    audio: false // Audio is captured separately from the selected application.
  });
  if (!stream.getVideoTracks().length) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error('Captura sem vídeo. Verifique a fonte selecionada.');
  }
  try {
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const capabilities = track.getCapabilities?.();
    // Prefer physical source dimensions; unknown window sizes are not inferred from thumbnails.
    const source = original?.width && original?.height ? original : capabilities?.width?.max && capabilities?.height?.max ?
      { width: capabilities.width.max, height: capabilities.height.max } : { width: settings.width, height: settings.height };
    await constrainCapture(track, { resolution, fps, original: source });
    stream.captureOriginal = source;
    stream.originalKnown = Boolean(original?.width && original?.height || capabilities?.width?.max && capabilities?.height?.max);
    // Synthetic QA sources already provide their own isolated audio track.
    if (!videoOnly && !stream.getAudioTracks().length && window.selfLive?.applicationAudioStart) await attachApplicationAudio(stream, window.selfLive);
  } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  stream.getVideoTracks()[0].contentHint = 'motion';
  return stream;
}

// Reutiliza a captura ativa ou inicia uma nova. O chamador encerra as tracks ao parar.
export async function startLocalLoopbackTest({ loopback, preview, bitrate, stream }) {
  const captured = stream || await captureSystemMedia();
  try {
    preview.srcObject = captured;
    await preview.play();
    await loopback.start(captured, bitrate);
    return captured;
  } catch (error) {
    loopback.stop();
    if (!stream) {
      captured.stopApplicationAudio?.();
      captured.getTracks().forEach(track => track.stop());
      preview.srcObject = null;
    }
    throw error;
  }
}

// Um sender e um receiver são necessários para codificar e decodificar de fato.
// SDP/ICE ficam em memória. O teste não força relay; ICE prefere o caminho local.
export class LocalLoopback {
  constructor(video, report, { nodeId = 'local-loopback', iceFactory = buildIceServers } = {}) {
    this.video = video; this.report = report; this.nodeId = nodeId; this.iceFactory = iceFactory;
    this.generation = 0;
  }
  async start(stream, bitrate) {
    this.stop();
    const generation = this.generation;
    const [senderIce, receiverIce] = await Promise.all([this.iceFactory(this.nodeId), this.iceFactory(this.nodeId)]);
    if (generation !== this.generation) throw new Error('Teste local cancelado.');
    const sender = this.sender = new RTCPeerConnection({ iceServers: senderIce });
    const receiver = this.receiver = new RTCPeerConnection({ iceServers: receiverIce });
    const pendingSender = [], pendingReceiver = [];
    const relay = (target, queue) => event => {
      if (!event.candidate) return;
      if (!target.remoteDescription) queue.push(event.candidate);
      else target.addIceCandidate(event.candidate).catch(error => this.report(error.message));
    };
    sender.onicecandidate = relay(receiver, pendingReceiver);
    receiver.onicecandidate = relay(sender, pendingSender);
    receiver.ontrack = event => { this.video.srcObject = event.streams[0]; };
    receiver.onconnectionstatechange = () => this.report(`WebRTC: ${receiver.connectionState}`);
    try {
      for (const track of stream.getTracks()) {
        const transceiver = sender.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
        const capabilities = RTCRtpSender.getCapabilities(track.kind);
        const codecs = capabilities.codecs.filter(c => c.mimeType.toLowerCase() === (track.kind === 'video' ? 'video/h264' : 'audio/opus'));
        if (!codecs.length) throw new Error(`Codec ${track.kind === 'video' ? 'H.264' : 'Opus'} indisponível.`);
        transceiver.setCodecPreferences(codecs);
      }
      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription);
      for (const candidate of pendingReceiver.splice(0)) await receiver.addIceCandidate(candidate);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription);
      for (const candidate of pendingSender.splice(0)) await sender.addIceCandidate(candidate);
      for (const tx of sender.getSenders()) {
        const params = tx.getParameters();
        if (tx.track.kind === 'video') {
          params.encodings[0].maxBitrate = bitrate;
          params.encodings[0].maxFramerate = 60;
          params.degradationPreference = 'maintain-resolution';
          await tx.setParameters(params);
        }
      }
      this.timer = setInterval(async () => {
        try {
          const stats = await sender.getStats();
          const audio = [...stats.values()].find(stat => stat.type === 'outbound-rtp' && stat.kind === 'audio');
          const audioCodec = audio && stats.get(audio.codecId);
          for (const stat of stats.values()) {
            if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') continue;
            const codec = stats.get(stat.codecId);
            this.report(`${receiver.connectionState} · ${codec?.mimeType || 'aguardando codec'} · ${stat.frameWidth || '—'}×${stat.frameHeight || '—'} · ${stat.framesPerSecond ?? '—'} fps · ${audioCodec?.mimeType || 'aguardando áudio'} ${audioCodec?.clockRate || ''} · encoder: ${stat.encoderImplementation || 'não informado'}`);
          }
        } catch { /* Conexão pode ter sido encerrada entre amostras. */ }
      }, 1000);
    } catch (error) { this.stop(); throw error; }
  }
  stop() {
    this.generation++;
    clearInterval(this.timer);
    for (const pc of [this.sender, this.receiver]) {
      if (pc) { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); }
    }
    this.sender = this.receiver = null;
    this.video.srcObject = null;
  }
}

// Uma conexão por viewer; o viewer recebe uma stream por vez. session_id permite
// descartar candidatos atrasados após parar ou trocar a transmissão.
export class PeerMedia {
  constructor({ nodeId, send, video, report, diagnostics = () => {}, iceServers,
    iceFactory = buildIceServers, iceTransportPolicy = 'all', connectionTimeoutMs = 15000, statsIntervalMs = 3000 }) {
    this.nodeId = nodeId;
    this.send = send;
    this.video = video;
    this.report = report;
    this.diagnostics = diagnostics;
    this.iceFactory = iceServers ? async () => iceServers : iceFactory;
    this.iceTransportPolicy = iceTransportPolicy;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.statsIntervalMs = statsIntervalMs;
    this.watchGeneration = 0;
    this.closed = false;
    this.outgoing = new Map();
    // Mapa exigido pelo streamer: viewerId → RTCPeerConnection.
    // outgoing guarda, separadamente, o estado da negociação de cada viewer.
    this.viewerConnections = new Map();
    this.watching = null;
    this.stream = null;
    this.streamId = null;
    // Serializa SDP/ICE recebidos: ICE só é aplicado após remoteDescription.
    this.messages = Promise.resolve();
  }

  signal(type, connection, body = {}) {
    this.send({ type, from: this.nodeId, to: connection.peerId, session_id: connection.sessionId, stream_id: connection.streamId, ...body });
  }

  async createConnection(peerId, sessionId, direction, streamId) {
    // Toda nova conexão pede credenciais novas; conexões ativas não são reiniciadas.
    const iceServers = await this.iceFactory(this.nodeId);
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: this.iceTransportPolicy });
    const connection = { peerId, sessionId, direction, streamId, pc, candidates: [], closed: false };
    pc.onicecandidate = event => {
      if (!connection.closed && event.candidate) {
        try { this.signal('ice', connection, { candidate: event.candidate.toJSON() }); }
        catch (error) { this.report(error.message); }
      }
    };
    pc.ontrack = event => {
      if (this.watching !== connection) return;
      const received = event.streams[0] || this.video.srcObject || new MediaStream();
      if (this.video.srcObject !== received) this.video.srcObject = received;
      if (!event.streams[0]) this.video.srcObject.addTrack(event.track);
      this.video.play().catch(error => {
        if (error.name !== 'AbortError') this.report(`Clique em reproduzir para ouvir: ${error.message}`);
      });
    };
    pc.onconnectionstatechange = () => {
      if (connection.closed) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(connection.timeout);
        if (!connection.statsTimer) {
          void this.sampleConnection(connection);
          connection.statsTimer = setInterval(() => {
            if (pc.connectionState === 'connected') void this.sampleConnection(connection);
          }, this.statsIntervalMs);
          connection.statsTimer.unref?.();
        }
        if (direction === 'receive' || !this.watching) this.report(direction === 'receive' ? 'Assistindo' : 'Transmitindo', peerId);
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        console.warn(`[WebRTC] ${direction}: ${pc.connectionState} (ICE ${pc.iceConnectionState})`);
        if (direction === 'receive' || !this.watching) this.report(`Conexão ${pc.connectionState}. Inicie uma nova conexão manualmente.`, peerId);
        if (this.watching === connection) this.diagnostics({ mode: 'failed', rttMs: null, quality: 'unknown' });
      }
    };
    connection.timeout = setTimeout(() => {
      if (connection.closed || pc.connectionState === 'connected') return;
      console.warn(`[WebRTC] Falha: prazo de conexão excedido (${direction}).`);
      if (this.watching === connection) {
        this.stopWatching();
        this.report('Falha ao conectar em 15 segundos. Inicie uma nova conexão manualmente.');
        this.diagnostics({ mode: 'failed', rttMs: null, quality: 'unknown' });
      } else {
        try { this.signal('watch_rejected', connection, { reason: 'Falha ao conectar em 15 segundos.' }); } catch {}
        this.closeConnection(connection);
      }
    }, this.connectionTimeoutMs);
    connection.timeout.unref?.();
    return connection;
  }

  async sampleConnection(connection) {
    try {
      const info = getConnectionDiagnostics(await connection.pc.getStats());
      if (connection.closed || connection.pc.connectionState !== 'connected') return;
      if (this.watching === connection) this.diagnostics(info);
      const signature = `${info.mode}/${info.family}/${info.localType}/${info.remoteType}`;
      if (info.mode !== 'unknown' && connection.lastMode !== signature) {
        connection.lastMode = signature;
        // Nunca imprimir os objetos stats/candidate: contêm endereços e URLs TURN.
        console.info(`[WebRTC] ${info.mode === 'relay' ? 'relay' : 'direto'}; candidatos ${info.localType}/${info.remoteType}; RTT=${info.rttMs === null ? 'indisponível' : Math.round(info.rttMs) + 'ms'}`);
        if (info.mode === 'relay' && info.relayReason) console.info(`[WebRTC] ${info.relayReason}`);
      }
    } catch { /* Stats podem desaparecer durante shutdown ou troca de stream. */ }
  }

  async startStreaming({ stream, bitrate = 10000000, peerId, sessionId } = {}) {
    if (this.closed) throw new Error('Sessão de mídia encerrada.');
    if (!this.stream) {
      this.stream = stream || await captureSystemMedia();
      this.bitrate = bitrate;
      const captured = this.stream;
      captured.getVideoTracks()[0].addEventListener('ended', () => {
        if (this.stream === captured && !captured.recoverVideoCapture) this.stopStreaming();
      }, { once: true });
      this.streamId = crypto.randomUUID();
      const settings = this.stream.getVideoTracks()[0].getSettings();
      try {
        this.send({ type: 'stream_started', node_id: this.nodeId, stream_id: this.streamId,
          codec: 'h264', res: `${settings.width || 1920}x${settings.height || 1080}`,
          fps: settings.frameRate || 60, bitrate: this.bitrate });
      } catch (error) { this.stopStreaming(); throw error; }
    }
    if (!this.watching) this.report('Transmitindo');
    // Botão Iniciar prepara a captura. O watch_request dispara a oferta ao viewer.
    if (!peerId) return this.stream;
    const previous = this.outgoing.get(peerId);
    if (previous) this.closeConnection(previous);
    const captured = this.stream, streamId = this.streamId;
    const connection = await this.createConnection(peerId, sessionId || crypto.randomUUID(), 'send', streamId);
    if (this.closed || this.stream !== captured || this.streamId !== streamId) {
      this.closeConnection(connection);
      return this.stream;
    }
    this.outgoing.set(peerId, connection);
    this.viewerConnections.set(peerId, connection.pc);
    try {
      for (const track of this.stream.getTracks()) {
        const transceiver = connection.pc.addTransceiver(track, { direction: 'sendonly', streams: [this.stream] });
        const codecs = RTCRtpSender.getCapabilities(track.kind).codecs.filter(codec =>
          codec.mimeType.toLowerCase() === (track.kind === 'video' ? 'video/h264' : 'audio/opus'));
        if (!codecs.length) throw new Error(`Codec ${track.kind} indisponível.`);
        transceiver.setCodecPreferences(codecs);
      }
      await connection.pc.setLocalDescription(await connection.pc.createOffer());
      if (connection.closed) return this.stream;
      this.signal('offer', connection, { sdp: connection.pc.localDescription.sdp });
      return this.stream;
    } catch (error) {
      this.closeConnection(connection);
      throw error;
    }
  }

  async startWatching(targetPeerId, streamId) {
    if (this.closed) throw new Error('Sessão de mídia encerrada.');
    if (targetPeerId === this.nodeId) throw new Error('Escolha outro peer para assistir.');
    this.stopWatching();
    const generation = this.watchGeneration;
    this.report('Conectando...', targetPeerId);
    this.diagnostics({ mode: 'connecting', rttMs: null, quality: 'unknown' });
    const connection = await this.createConnection(targetPeerId, crypto.randomUUID(), 'receive', streamId);
    // Troca, saída e shutdown podem acontecer enquanto o main gera as credenciais.
    if (this.closed || generation !== this.watchGeneration) { this.closeConnection(connection); return; }
    this.watching = connection;
    try { this.signal('watch_request', connection); }
    catch (error) { this.stopWatching(false); throw error; }
  }

  async setRemote(connection, description) {
    await connection.pc.setRemoteDescription(description);
    for (const candidate of connection.candidates.splice(0)) {
      if (connection.closed) return;
      await connection.pc.addIceCandidate(candidate);
    }
  }

  handleMessage(message) {
    const operation = this.messages.then(() => this.processMessage(message));
    this.messages = operation.catch(error => {
      console.error(`[WebRTC] Falha na negociação: ${error.name || 'Error'}`);
      if (!this.watching) this.report('Falha na negociação WebRTC. Inicie uma nova conexão manualmente.');
    });
    return this.messages;
  }

  async processMessage(message) {
    // Evento da sala, não relay dirigido: só afeta o stream que este viewer vê.
    if (message.type === 'stream_stopped') {
      if (this.watching?.peerId === message.node_id &&
          (!this.watching.streamId || this.watching.streamId === message.stream_id)) {
        this.stopWatching(false);
        this.report(message.reason === 'peer_shutdown' ? 'Streamer desconectado' : 'Streamer parou de transmitir');
      }
      return;
    }
    if (message.type === 'error' && message.code === 'peer_not_found') {
      if (this.watching?.peerId === message.to && this.watching.sessionId === message.session_id) {
        this.stopWatching(false); this.report('Peer não encontrado.');
        this.diagnostics({ mode: 'failed', rttMs: null, quality: 'unknown' });
      }
      const outgoing = this.outgoing.get(message.to);
      if (outgoing?.sessionId === message.session_id) this.closeConnection(outgoing);
      return;
    }
    if (message.to !== this.nodeId || typeof message.from !== 'string' || typeof message.session_id !== 'string') return;
    if (message.type === 'watch_request') {
      const request = { peerId: message.from, sessionId: message.session_id };
      // Nunca inicia captura em resposta a um peer: aceita só transmissão autorizada.
      if (!this.stream?.active || (message.stream_id && message.stream_id !== this.streamId)) {
        this.signal('watch_rejected', request, { reason: 'Peer não está transmitindo esse stream.' }); return;
      }
      try { await this.startStreaming({ peerId: message.from, sessionId: message.session_id }); }
      catch (error) { this.signal('watch_rejected', request, { reason: 'Falha ao preparar a transmissão.' }); throw error; }
      return;
    }
    const receive = this.watching;
    const send = this.outgoing.get(message.from);
    const connection = receive?.peerId === message.from && receive.sessionId === message.session_id ? receive :
      send?.sessionId === message.session_id ? send : null;
    if (!connection || connection.closed) return;
    try {
      if (message.type === 'offer' && connection.direction === 'receive') {
        await this.setRemote(connection, { type: 'offer', sdp: message.sdp });
        await connection.pc.setLocalDescription(await connection.pc.createAnswer());
        if (!connection.closed) this.signal('answer', connection, { sdp: connection.pc.localDescription.sdp });
      } else if (message.type === 'answer' && connection.direction === 'send') {
        await this.setRemote(connection, { type: 'answer', sdp: message.sdp });
        for (const sender of connection.pc.getSenders()) {
          if (sender.track?.kind !== 'video') continue;
          const params = sender.getParameters();
          params.encodings[0].maxBitrate = this.bitrate;
          params.encodings[0].maxFramerate = 60;
          params.degradationPreference = 'maintain-resolution';
          await sender.setParameters(params);
        }
      } else if (message.type === 'ice' && message.candidate) {
        if (!connection.pc.remoteDescription) {
          if (connection.candidates.length >= 128) throw new Error('Muitos candidatos ICE pendentes.');
          connection.candidates.push(message.candidate);
        } else await connection.pc.addIceCandidate(message.candidate);
      } else if (['stop_watching', 'watch_stop'].includes(message.type) && connection.direction === 'send') {
        this.closeConnection(connection);
      } else if (message.type === 'watch_rejected' && connection.direction === 'receive') {
        this.stopWatching(false);
        this.report(message.reason || 'Transmissão encerrada.', message.from);
        this.diagnostics({ mode: 'failed', rttMs: null, quality: 'unknown' });
      }
    } catch (error) {
      // Uma negociação cancelada não pode encerrar a nova stream do viewer.
      if (connection.closed) return;
      if (connection.direction === 'receive' && this.watching === connection) {
        this.stopWatching();
        this.diagnostics({ mode: 'failed', rttMs: null, quality: 'unknown' });
      }
      else this.closeConnection(connection);
      throw error;
    }
  }

  closeConnection(connection) {
    connection.closed = true;
    clearTimeout(connection.timeout);
    clearInterval(connection.statsTimer);
    connection.candidates.length = 0;
    connection.pc.onicecandidate = connection.pc.ontrack = connection.pc.onconnectionstatechange = null;
    connection.pc.close();
    if (connection.direction === 'send' && this.outgoing.get(connection.peerId) === connection) {
      this.outgoing.delete(connection.peerId);
      this.viewerConnections.delete(connection.peerId);
    }
  }

  stopWatching(notify = true) {
    this.watchGeneration++;
    if (this.watching) {
      if (notify) { try { this.signal('stop_watching', this.watching); } catch { /* Socket já encerrado. */ } }
      this.closeConnection(this.watching);
      this.watching = null;
    }
    this.video.srcObject = null;
    this.diagnostics({ mode: 'unknown', rttMs: null, quality: 'unknown' });
  }

  stopStreaming({ reason } = {}) {
    for (const connection of this.outgoing.values()) {
      this.closeConnection(connection);
    }
    this.outgoing.clear();
    this.viewerConnections.clear();
    if (this.streamId) {
      try {
        const event = { type: 'stream_stopped', node_id: this.nodeId, stream_id: this.streamId };
        if (reason === 'peer_shutdown') event.reason = reason;
        this.send(event);
      }
      catch { /* Socket já encerrado: a sala limpa o stream em user_left. */ }
    }
    this.streamId = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
  }

  peerLeft(peerId) {
    if (this.watching?.peerId === peerId) { this.stopWatching(false); this.report('Streamer desconectado'); }
    const connection = this.outgoing.get(peerId);
    if (connection) this.closeConnection(connection);
  }

  close() { this.closed = true; this.stopWatching(); this.stopStreaming(); }
}

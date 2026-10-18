const video = document.getElementById('video'), status = document.getElementById('status'), metrics = document.getElementById('metrics');
const remote = new URLSearchParams(location.search).get('remote')==='1';
const storageKey=remote?'native-mvp-remote-token':'native-mvp-token';
const token = location.hash.slice(1) || sessionStorage.getItem(storageKey);
if (token) { sessionStorage.setItem(storageKey,token); history.replaceState(null,'',location.pathname+location.search); }
const peer = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
const socket = new WebSocket(`ws://${location.host}/${remote?'remote-signal':'signal'}`);
const send = value => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
let pendingIce = [], messages = Promise.resolve(), previous, rendered = 0, previousRendered = 0, lastPresented, gaps = [], terminalMessage, deadline;
socket.onopen = () => send({type:'join',token});
peer.onicecandidate = event => { if (event.candidate) send({type:'ice',candidate:event.candidate.candidate,sdpMLineIndex:event.candidate.sdpMLineIndex}); };
peer.ontrack = event => {
  video.srcObject = event.streams[0] || new MediaStream([event.track]);
  video.play().catch(() => { status.textContent = 'Clique no vídeo para reproduzir'; });
  document.getElementById('waiting').hidden = true;
};
video.onclick = () => video.play().catch(() => {});
peer.onconnectionstatechange = () => {
  status.textContent = ({connected:'Vídeo conectado',connecting:'Conectando vídeo…',failed:'Falha de conexão — tente reconectar',disconnected:'Conexão interrompida',closed:'Conexão encerrada'})[peer.connectionState] || 'Negociando vídeo…';
  if(['connected','failed','closed'].includes(peer.connectionState))clearTimeout(deadline);
  if(peer.connectionState==='failed')status.textContent='A conexão direta falhou. Configure TURN no transmissor e tente novamente.';
};
socket.onmessage = event => {
  messages = messages.then(async () => {
    const value = JSON.parse(event.data);
    if(value.type==='connecting') {
      peer.setConfiguration({iceServers:value.iceServers,iceTransportPolicy:value.iceTransportPolicy||'all'});
      clearTimeout(deadline);deadline=setTimeout(()=>{if(peer.connectionState!=='connected')status.textContent='Sem rota de mídia. Configure TURN no transmissor para redes com NAT restritivo.';},25000);
    } else if (value.type === 'offer') {
      if(peer.remoteDescription?.sdp===value.sdp && peer.localDescription) { send({type:'answer',sdp:peer.localDescription.sdp});return; }
      await peer.setRemoteDescription({type:'offer',sdp:value.sdp});
      for (const candidate of pendingIce) await peer.addIceCandidate(candidate);
      pendingIce = [];
      await peer.setLocalDescription(await peer.createAnswer());
      send({type:'answer',sdp:peer.localDescription.sdp});
    } else if (value.type === 'ice') {
      const candidate = {candidate:value.candidate,sdpMLineIndex:value.sdpMLineIndex};
      if (peer.remoteDescription) await peer.addIceCandidate(candidate); else pendingIce.push(candidate);
    } else if (value.type === 'error') {terminalMessage=value.message;status.textContent=value.message;}
    else if (value.type === 'stopped') {terminalMessage='A captura foi encerrada';status.textContent=terminalMessage;}
    else if(value.type==='signaling-status' && peer.connectionState!=='connected')status.textContent=value.state==='online'?'Negociando conexão P2P…':'Conectando à sinalização de internet…';
  }).catch(() => { status.textContent = 'Falha ao negociar o vídeo. Tente reconectar.'; });
};
socket.onclose = () => { clearInterval(timer);clearTimeout(deadline); peer.close(); status.textContent = terminalMessage || 'Transmissão desconectada — reconecte para tentar novamente'; };
socket.onerror = () => { status.textContent = 'Não foi possível conectar ao transmissor'; };
if ('requestVideoFrameCallback' in video) {
  const frame = now => {
    rendered++;
    if (document.visibilityState === 'visible') { if (lastPresented != null) gaps.push(now - lastPresented); lastPresented = now; }
    else lastPresented = null;
    video.requestVideoFrameCallback(frame);
  };
  video.requestVideoFrameCallback(frame);
}
const timer = setInterval(async () => {
  try {
    const report = await peer.getStats();
    const row = [...report.values()].find(item => item.type === 'inbound-rtp' && item.kind === 'video');
    if (!row) return;
    const now = performance.now(), seconds = previous ? (now - previous.now)/1000 : 0;
    const transportRow=[...report.values()].find(item=>item.type==='transport'&&item.selectedCandidatePairId);
    const pair=report.get(transportRow?.selectedCandidatePairId) || [...report.values()].find(item=>item.type==='candidate-pair'&&item.nominated&&item.state==='succeeded');
    const local=report.get(pair?.localCandidateId), distant=report.get(pair?.remoteCandidateId);
    const transport={mode:!pair?'unknown':local?.candidateType==='relay'||distant?.candidateType==='relay'?'relay':'direct',localType:local?.candidateType,remoteType:distant?.candidateType,protocol:local?.protocol,rttMs:pair?.currentRoundTripTime*1000};
    const frames = previous ? row.framesDecoded - previous.frames : 0;
    const sorted = gaps.sort((a,b) => a-b);
    const value = {type:'sample',transport,visible:document.visibilityState === 'visible',framesDecoded:row.framesDecoded,framesDropped:row.framesDropped,
      freezeCount:row.freezeCount,totalFreezesDuration:row.totalFreezesDuration,jitterMs:row.jitter*1000,
      frameWidth:row.frameWidth,frameHeight:row.frameHeight,
      ...(seconds > 0 ? {decodedFps:frames/seconds,renderedFps:(rendered-previousRendered)/seconds,receiveKbps:(row.bytesReceived-previous.bytes)*8/seconds/1000} : {}),
      ...(frames > 0 ? {decodeMs:(row.totalDecodeTime-previous.decodeTime)*1000/frames} : {}),
      ...(sorted.length ? {renderGapP95Ms:sorted[Math.floor((sorted.length-1)*.95)],renderGapMaxMs:sorted[sorted.length-1]} : {})};
    if (seconds > 0) { metrics.textContent = `${value.decodedFps.toFixed(1)} fps recebidos · ${row.frameWidth || video.videoWidth} × ${row.frameHeight || video.videoHeight} · ${value.receiveKbps.toFixed(0)} kbps · ${transport.mode==='relay'?'via TURN':'P2P direto'}`; send(value); }
    previous = {now,frames:row.framesDecoded,bytes:row.bytesReceived,decodeTime:row.totalDecodeTime}; previousRendered = rendered; gaps = [];
  } catch { /* Stats may be unavailable during disconnect. */ }
},1000);
document.getElementById('reconnect').onclick = () => location.reload();
document.getElementById('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.getElementById('stage').requestFullscreen(); }
  catch { status.textContent = 'O navegador não permitiu tela cheia'; }
};
window.addEventListener('pagehide',() => { clearInterval(timer); socket.close(); peer.close(); });

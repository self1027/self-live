const video = document.getElementById('video'), status = document.getElementById('status'), metrics = document.getElementById('metrics');
const remote = new URLSearchParams(location.search).get('remote')==='1';
const storageKey=remote?'native-mvp-remote-token':'native-mvp-token';
const token = location.hash.slice(1) || sessionStorage.getItem(storageKey);
if (token) { sessionStorage.setItem(storageKey,token); history.replaceState(null,'',location.pathname+location.search); }
const peer = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
const socket = new WebSocket(`ws://${location.host}/${remote?'remote-signal':'signal'}`);
const send = value => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
let pendingIce = [], messages = Promise.resolve(), previous, rendered = 0, previousRendered = 0, lastPresented, gaps = [], terminalMessage, deadline;
const routeNames = {ipv6:'IPv6 direto','ipv4-direct':'IPv4 direto','ipv4-manual':'IPv4 configurado',relay:'relay seguro','ipv4-local':'rede local'};
function showStatus(text, failed=false) { status.textContent=text;status.classList.toggle('error',failed); }
function showMedia(mode) { document.getElementById('media-path').textContent=mode==='relay'?'Mídia: via TURN':mode==='direct'?'Mídia: P2P direta':'Mídia: verificando rota selecionada'; }
function fail(text) { terminalMessage=text;showStatus(text,true);document.getElementById('waiting').textContent=text;document.getElementById('waiting').hidden=false; }
socket.onopen = () => send({type:'join',token});
peer.onicecandidate = event => { if (event.candidate) send({type:'ice',candidate:event.candidate.candidate,sdpMLineIndex:event.candidate.sdpMLineIndex}); };
peer.ontrack = event => {
  if(terminalMessage)return;
  video.srcObject = event.streams[0] || new MediaStream([event.track]);
  video.play().catch(() => { showStatus('Clique no vídeo ou pressione espaço para reproduzir'); });
  document.getElementById('waiting').hidden = true;
};
video.onclick = () => video.play().catch(() => {});
video.onkeydown = event => { if(event.key===' '||event.key==='Enter'){event.preventDefault();video.click();} };
peer.onconnectionstatechange = () => {
  send({type:'receiver-state',state:peer.connectionState});
  if(terminalMessage){clearTimeout(deadline);showStatus(terminalMessage,true);return;}
  showStatus(terminalMessage || ({connected:'Vídeo conectado',connecting:'Conectando vídeo…',failed:'Não foi possível estabelecer a mídia. Tente reconectar.',disconnected:'Vídeo interrompido — aguardando recuperação…',closed:'Conexão encerrada'})[peer.connectionState] || 'Negociando vídeo…',!!terminalMessage||peer.connectionState==='failed');
  if(peer.connectionState==='connected') { document.getElementById('waiting').hidden=true;showMedia(); }
  if(peer.connectionState==='failed') { document.getElementById('media-path').textContent='Mídia: conexão falhou'; fail('Sem rota de mídia. Tente reconectar; em redes restritivas, o transmissor pode configurar TURN nas opções avançadas.'); }
  if(peer.connectionState==='disconnected') { document.getElementById('waiting').textContent='Conexão de vídeo interrompida. Aguardando recuperação…';document.getElementById('waiting').hidden=false; }
  if(['connected','failed','closed'].includes(peer.connectionState))clearTimeout(deadline);
};
socket.onmessage = event => {
  messages = messages.then(async () => {
    const value = JSON.parse(event.data);
    if(value.type==='connecting') {
      peer.setConfiguration({iceServers:value.iceServers,iceTransportPolicy:value.iceTransportPolicy||'all'});
      send({type:'receiver-state',state:'connecting'});
      document.getElementById('media-path').textContent='Mídia: negociando conexão';
      clearTimeout(deadline);deadline=setTimeout(()=>{if(peer.connectionState!=='connected'&&!terminalMessage)showStatus('A mídia está demorando. Tente reconectar se o vídeo não iniciar.',true);},25000);
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
    } else if (value.type === 'error') { clearTimeout(deadline);fail(value.message || 'Não foi possível conectar. Peça um convite atual e tente novamente.'); }
    else if (value.type === 'stopped') {clearTimeout(deadline);terminalMessage='A captura foi encerrada';showStatus(terminalMessage);document.getElementById('waiting').textContent=terminalMessage;document.getElementById('waiting').hidden=false;}
    else if(value.type==='connection-stage') {
      if(terminalMessage)return;
      const route=routeNames[value.method] || 'rota automática';
      if(value.stage==='trying') { document.getElementById('signal-path').textContent=`Sinalização: tentando ${route}…`;showStatus('Buscando o transmissor…'); }
      else if(value.stage==='connected') { document.getElementById('signal-path').textContent=`Sinalização: ${route}`;showStatus('Transmissor encontrado. Negociando vídeo…'); }
      else if(value.stage==='failed') {
        if(value.code==='media_disconnected'||value.code==='media_failed'){
          document.getElementById('media-path').textContent=value.code==='media_disconnected'?'Mídia: conexão interrompida':'Mídia: conexão falhou';
          showStatus(value.code==='media_disconnected'?'Vídeo interrompido — aguardando recuperação…':'A conexão de vídeo falhou. Tente reconectar.',value.code==='media_failed');
        } else {document.getElementById('signal-path').textContent=`Sinalização: falha em ${route}`;if(!terminalMessage)showStatus('Tentando outras rotas disponíveis…');}
      }
      else if(value.stage==='media-connecting')document.getElementById('media-path').textContent='Mídia: negociando conexão';
      else if(value.stage==='media-connected') { showStatus('Vídeo conectado');showMedia(); }
      else if(value.stage==='closed'&&!terminalMessage&&peer.connectionState!=='connected')showStatus('Conexão encerrada — tente reconectar');
    }
    else if(value.type==='signaling-status' && peer.connectionState!=='connected'&&!terminalMessage)showStatus(value.state==='online'?'Transmissor encontrado. Negociando vídeo…':'Conectando à sinalização de internet…');
  }).catch(() => { fail('Falha ao negociar o vídeo. Tente reconectar.'); });
};
socket.onclose = () => { clearInterval(timer);clearTimeout(deadline); peer.close();document.getElementById('media-path').textContent='Mídia: conexão encerrada';showStatus(terminalMessage || 'Transmissão desconectada — reconecte para tentar novamente',!!terminalMessage);document.getElementById('waiting').textContent=terminalMessage || 'Transmissão desconectada. Use Reconectar para tentar novamente.';document.getElementById('waiting').hidden=false; };
socket.onerror = () => { showStatus('Não foi possível conectar ao transmissor. Verifique o convite e tente novamente.',true); };
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
    showMedia(transport.mode);
    if (seconds > 0) { metrics.textContent = `${value.decodedFps.toFixed(1)} fps recebidos · ${row.frameWidth || video.videoWidth} × ${row.frameHeight || video.videoHeight} · ${value.receiveKbps.toFixed(0)} kbps`; send(value); }
    previous = {now,frames:row.framesDecoded,bytes:row.bytesReceived,decodeTime:row.totalDecodeTime}; previousRendered = rendered; gaps = [];
  } catch { /* Stats may be unavailable during disconnect. */ }
},1000);
document.getElementById('reconnect').onclick = () => location.reload();
document.getElementById('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.getElementById('stage').requestFullscreen(); }
  catch { showStatus('O navegador não permitiu tela cheia',true); }
};
document.addEventListener('fullscreenchange',()=>{document.getElementById('fullscreen').textContent=document.fullscreenElement?'Sair da tela cheia':'Tela cheia';});
window.addEventListener('pagehide',() => { clearInterval(timer);clearTimeout(deadline);socket.close();peer.close(); });

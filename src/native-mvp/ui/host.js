const bridge = window.nativeMvp;
const byId = id => document.getElementById(id);
let active = false, busy = false;
function controls() {
  for (const id of ['source','adapter','resolution','fps','bitrate','priority','logging','refresh','turn-url','turn-user','turn-password','force-relay','save-network','clear-turn']) byId(id).disabled = active || busy;
  byId('start').disabled = active || busy || !/^\d+$/.test(byId('source').value);
  byId('stop').disabled = !active || busy;
  for (const id of ['viewer','links','copy']) byId(id).disabled = !active || busy;
}
function status(text, failed = false) { byId('status').textContent = text; byId('status').classList.toggle('error',failed); }
async function refresh() {
  busy = true; controls();
  try {
    const value = await bridge.sources();
    byId('source').replaceChildren(...value.windows.map(row => new Option(row.name,row.id)));
    if (!value.windows.length) byId('source').add(new Option('Nenhuma janela disponível',''));
    byId('adapter').replaceChildren(new Option('Automática — maior memória dedicada','-1'),...value.adapters.map(row => new Option(row.name,row.index)));
    status(value.windows.length ? 'Pronto para capturar' : 'Abra a janela que deseja compartilhar');
  } catch (error) { status(error.message,true); }
  finally { busy = false; controls(); }
}
byId('refresh').onclick = refresh;
byId('source').onchange = controls;
byId('start').onclick = async () => {
  busy = true; controls(); status('Iniciando captura C++…');
  try {
    const value = await bridge.start({window:byId('source').value,adapter:Number(byId('adapter').value),height:Number(byId('resolution').value),fps:Number(byId('fps').value),bitrateKbps:Number(byId('bitrate').value),gpuPriority:byId('priority').checked,logging:byId('logging').checked});
    active = true;
    const links = [value.local,...value.lan,...(value.internet?[value.internet]:[])];
    byId('links').replaceChildren(...links.map((link,index) => new Option(link.startsWith('selflive-native:')?'Internet · convite para outro MVP':index ? `Rede local · ${link.split('/')[2]}` : 'Neste PC · 127.0.0.1',index)));
    if (value.internet) byId('links').selectedIndex=links.length-1;
    else if (value.lan.length) byId('links').selectedIndex = 1;
    byId('network-path').textContent='Aguardando conexão de mídia.';
    byId('details').textContent = `${value.adapter} · ${value.encoder} · ${value.width} × ${value.height} · ${value.fps} fps`;
    byId('log-file').textContent = value.log ? `Log: ${value.log}` : 'Logs desativados.';
    status('Captura ativa — conecte o espectador');
  } catch (error) { status(error.message,true); }
  finally { busy = false; controls(); }
};
byId('stop').onclick = async () => {
  busy = true; controls();
  try { await bridge.stop(); active = false; status('Captura encerrada'); }
  catch (error) { status(error.message,true); }
  finally { busy = false; controls(); }
};
byId('viewer').onclick = () => bridge.openViewer().catch(error => status(error.message,true));
byId('copy').onclick = () => bridge.copyLink(Number(byId('links').value)).then(() => status('Link copiado — envie ao espectador')).catch(error => status(error.message,true));
byId('logs').onclick = () => bridge.openLogs().catch(error => status(error.message,true));
bridge.onEvent(value => {
  if (value.type === 'sample') {
    byId('captured').textContent = value.captureFps.toFixed(1); byId('encoded').textContent = value.encodedFps.toFixed(1);
    byId('latency').textContent = Number.isFinite(value.submitToEncodedP95Ms) ? `${value.submitToEncodedP95Ms.toFixed(1)} ms` : '—';
    byId('source-state').textContent = `${value.minimized ? 'Janela minimizada' : value.focused ? 'Janela em foco' : 'Janela em segundo plano'} · GPU 3D ${Number.isFinite(value.gpu?.threeD) ? value.gpu.threeD.toFixed(0)+'%' : '—'} · prioridade GPU ${value.gpuPriority === 4 ? 'HIGH confirmada' : value.gpuPriority >= 0 ? value.gpuPriority : 'indisponível'} · descartes: ${value.superseded + value.poolDrops}`;
  } else if (value.type === 'receiver-sample') {
    byId('received').textContent = Number.isFinite(value.decodedFps) ? value.decodedFps.toFixed(1) : '—';
    if(value.transport)byId('network-path').textContent=value.transport.mode==='relay'?'Mídia via TURN':value.transport.mode==='direct'?'Mídia P2P direta':'Negociando rota de mídia';
  }
  else if (value.type === 'viewer-connected') status('Espectador conectado — negociando vídeo');
  else if (value.type === 'viewer-disconnected') { byId('received').textContent = '—'; if (active) status('Captura ativa — aguardando espectador'); }
  else if (value.type === 'error' || value.type === 'stopped') { active = false; status(value.message || 'A janela foi fechada; captura encerrada.',value.type === 'error'); controls(); }
  else if(value.type==='signaling-status')byId('network-state').textContent=({online:'Sinalização de internet conectada.',connecting:'Conectando à sinalização de internet…',reconnecting:'Reconectando sinalização; a mídia ativa pode continuar.',offline:'Sinalização indisponível; tentando novamente.'})[value.state]||'';
  else if(value.type==='peer-state'&&value.state==='connected')status('Transmitindo vídeo');
});
byId('join').onclick=async()=>{
  byId('join').disabled=true;
  try{await bridge.join(byId('invitation').value.trim());byId('invitation').value='';byId('join-status').textContent='Espectador aberto. A conexão é negociada pela internet.';}
  catch(error){byId('join-status').textContent=error.message;}
  finally{byId('join').disabled=false;}
};
function network(value) {
  byId('turn-url').value=value.turnUrl;byId('turn-user').value=value.turnUsername;byId('turn-password').value='';
  byId('turn-password').placeholder=value.hasCredential?'Já configurada; deixe em branco para manter':'';
  byId('force-relay').checked=value.forceRelay;
  byId('turn-status').textContent=value.hasCredential?`TURN configurado${value.environmentCredentials?' pelo ambiente':''}.`:'STUN ativo; TURN não configurado.';
}
async function saveNetwork(clear=false) {
  try {network(await bridge.saveNetwork({turnUrl:byId('turn-url').value,turnUsername:byId('turn-user').value,turnCredential:byId('turn-password').value,forceRelay:clear?false:byId('force-relay').checked,clear}));}
  catch(error){byId('turn-status').textContent=error.message;}
}
byId('save-network').onclick=()=>saveNetwork();byId('clear-turn').onclick=()=>saveNetwork(true);
bridge.network().then(network).catch(error=>{byId('turn-status').textContent=error.message;});
void refresh();

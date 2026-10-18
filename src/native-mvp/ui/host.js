const bridge = window.nativeMvp;
const byId = id => document.getElementById(id);
let active = false, busy = false, joining = false;
const routeNames = {ipv6:'IPv6 direto','ipv4-direct':'IPv4 direto','ipv4-manual':'IPv4 configurado',relay:'relay seguro','ipv4-local':'rede local'};
function joinStatus(text, failed = false) {
  byId('join-status').textContent = text;
  byId('join-status').classList.toggle('error',failed);
}
function controls() {
  for (const id of ['source','adapter','resolution','fps','bitrate','priority','logging','refresh','turn-url','turn-auth','turn-secret','turn-user','turn-password','force-relay','save-network','clear-turn']) byId(id).disabled = active || busy;
  byId('start').disabled = active || busy || !/^\d+$/.test(byId('source').value);
  byId('stop').disabled = !active || busy;
  for (const id of ['viewer','links','copy']) byId(id).disabled = !active || busy;
  byId('start').textContent = busy && !active ? 'Preparando…' : 'Iniciar captura';
  byId('refresh').textContent = busy && !active ? 'Carregando…' : 'Atualizar janelas';
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
    byId('links').replaceChildren(...links.map((link,index) => new Option(link.startsWith('selflive-native:')?'Convite automático · outro PC':index ? `Rede local · ${link.split('/')[2]}` : 'Neste PC · 127.0.0.1',index)));
    if (value.internet) byId('links').selectedIndex=links.length-1;
    else if (value.lan.length) byId('links').selectedIndex = 1;
    byId('network-path').textContent='Mídia: aguardando espectador';
    byId('details').textContent = `${value.adapter} · ${value.encoder} · ${value.width} × ${value.height} · ${value.fps} fps`;
    byId('log-file').textContent = value.log ? `Log: ${value.log}` : 'Logs desativados.';
    byId('source-state').textContent = 'Captura iniciada. Aguardando métricas da janela.';
    status('Captura ativa — conecte o espectador');
  } catch (error) { status(error.message,true); }
  finally { busy = false; controls(); }
};
byId('stop').onclick = async () => {
  busy = true; controls();
  try { await bridge.stop(); active = false; status('Captura encerrada'); byId('received').textContent='—'; byId('network-path').textContent='Mídia: captura encerrada'; byId('source-state').textContent='Sem transmissão ativa.'; }
  catch (error) { status(error.message,true); }
  finally { busy = false; controls(); }
};
byId('viewer').onclick = () => bridge.openViewer().catch(error => status(error.message,true));
byId('copy').onclick = () => bridge.copyLink(Number(byId('links').value)).then(() => status('Convite ou link copiado — envie ao espectador')).catch(error => status(error.message,true));
byId('logs').onclick = () => bridge.openLogs().catch(error => status(error.message,true));
bridge.onEvent(value => {
  if (value.type === 'sample') {
    byId('captured').textContent = value.captureFps.toFixed(1); byId('encoded').textContent = value.encodedFps.toFixed(1);
    byId('latency').textContent = Number.isFinite(value.submitToEncodedP95Ms) ? `${value.submitToEncodedP95Ms.toFixed(1)} ms` : '—';
    byId('source-state').textContent = `${value.minimized ? 'Janela minimizada' : value.focused ? 'Janela em foco' : 'Janela em segundo plano'} · GPU 3D ${Number.isFinite(value.gpu?.threeD) ? value.gpu.threeD.toFixed(0)+'%' : '—'} · prioridade GPU ${value.gpuPriority === 4 ? 'HIGH confirmada' : value.gpuPriority >= 0 ? value.gpuPriority : 'indisponível'} · descartes: ${value.superseded + value.poolDrops}`;
  } else if (value.type === 'receiver-sample') {
    byId('received').textContent = Number.isFinite(value.decodedFps) ? value.decodedFps.toFixed(1) : '—';
    if(value.transport)byId('network-path').textContent=value.transport.mode==='relay'?'Mídia: via TURN':value.transport.mode==='direct'?'Mídia: P2P direta':'Mídia: negociando rota';
  }
  else if (value.type === 'viewer-connected') status('Espectador conectado — negociando vídeo');
  else if (value.type === 'viewer-disconnected') { byId('received').textContent = '—'; if (active) status('Captura ativa — aguardando espectador'); }
  else if (value.type === 'error' || value.type === 'stopped') { active = false; status(value.message || 'A janela foi fechada; captura encerrada.',value.type === 'error'); controls(); }
  else if(value.type==='signaling-status')byId('network-state').textContent=({online:'Sinalização: relay de internet disponível',connecting:'Sinalização: conectando ao relay…',reconnecting:'Sinalização: reconectando ao relay; a mídia ativa pode continuar',offline:'Sinalização: relay indisponível; rotas diretas podem funcionar'})[value.state]||'';
  else if(value.type==='connection-stage' && value.role==='receiver') {
    const route=routeNames[value.method] || 'rota automática';
    if(value.stage==='trying') { byId('join-signal').textContent=`Sinalização: tentando ${route}…`; joinStatus('Buscando o transmissor pelas rotas disponíveis…'); }
    else if(value.stage==='connected') { byId('join-signal').textContent=`Sinalização: ${route}`; joinStatus('Transmissor encontrado. Negociando o vídeo…'); }
    else if(value.stage==='failed') {
      if(value.code==='media_disconnected'||value.code==='media_failed'){
        byId('join-media').textContent=value.code==='media_disconnected'?'Mídia: conexão interrompida':'Mídia: conexão falhou';
        joinStatus(value.code==='media_disconnected'?'O vídeo foi interrompido. Aguardando recuperação…':'A conexão de vídeo falhou. Tente reconectar no player.',value.code==='media_failed');
      } else {byId('join-signal').textContent=`Sinalização: falha em ${route}`;joinStatus('Rota indisponível. Consulte o progresso e o diagnóstico no player.');}
    }
    else if(value.stage==='media-connecting') { byId('join-media').textContent='Mídia: negociando conexão'; joinStatus('Player aberto. Conectando o vídeo…'); }
    else if(value.stage==='media-connected') { byId('join-media').textContent='Mídia: conectada · rota no player'; joinStatus('Vídeo conectado no player.'); }
    else if(value.stage==='closed') { byId('join-media').textContent='Mídia: conexão encerrada'; joinStatus('Recepção encerrada. Cole um convite para assistir novamente.'); }
  }
  else if(value.type==='port-mapping') {
    byId('mapping-state').textContent=value.status==='mapped'?'Mapeamento automático de portas ativo.':value.status==='checking'?'Verificando mapeamento automático de portas…':value.status==='disabled'?'Mapeamento automático desativado; as outras rotas continuam disponíveis.':'Mapeamento automático indisponível; as outras rotas continuam disponíveis.';
  }
  else if(value.type==='peer-state'&&value.state==='connected')status('Transmitindo vídeo');
});
byId('join').onclick=async()=>{
  if(joining)return;
  const invitation=byId('invitation').value.trim();
  byId('invitation').setAttribute('aria-invalid',String(!invitation));
  if(!invitation){joinStatus('Cole o convite enviado pelo transmissor.',true);byId('invitation').focus();return;}
  joining=true;byId('join').disabled=true;byId('join').textContent='Abrindo…';byId('invitation').readOnly=true;
  joinStatus('Validando o convite e abrindo o player…');
  byId('join-signal').textContent='Sinalização: buscando transmissor';byId('join-media').textContent='Mídia: aguardando negociação';
  try{await bridge.join(invitation,byId('logging').checked);byId('invitation').value='';joinStatus('Player aberto. A conexão continua automaticamente.');}
  catch(error){byId('invitation').setAttribute('aria-invalid','true');joinStatus(error.message,true);byId('join-signal').textContent='Sinalização: conexão não iniciada';byId('join-media').textContent='Mídia: não iniciada';byId('invitation').focus();}
  finally{joining=false;byId('join').disabled=false;byId('join').textContent='Assistir';byId('invitation').readOnly=false;}
};
byId('invitation').oninput=()=>byId('invitation').removeAttribute('aria-invalid');
byId('invitation').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();byId('join').click();}};
let savedNetwork;
function authentication() {
  const secret=byId('turn-auth').value==='secret';
  byId('turn-secret-fields').hidden=!secret;byId('turn-credential-fields').hidden=secret;
  byId('turn-secret').placeholder=savedNetwork?.hasCredential&&savedNetwork.turnAuth==='secret'?'Já configurado; deixe em branco para manter':'';
  byId('turn-password').placeholder=savedNetwork?.hasCredential&&savedNetwork.turnAuth==='credentials'?'Já configurada; deixe em branco para manter':'';
}
function network(value) {
  savedNetwork=value;
  byId('turn-url').value=value.turnUrl;byId('turn-user').value=value.turnUsername;byId('turn-password').value='';byId('turn-secret').value='';
  byId('turn-auth').value=value.turnAuth;authentication();
  byId('force-relay').checked=value.forceRelay;
  byId('turn-status').textContent=value.hasCredential?`TURN configurado${value.environmentCredentials?' pelo ambiente':''}${value.turnAuth==='secret'?'; credenciais temporárias geradas automaticamente':''}.`:'STUN ativo; TURN não configurado.';
}
async function saveNetwork(clear=false) {
  busy=true;controls();byId('save-network').textContent='Salvando…';byId('turn-status').classList.remove('error');
  try {network(await bridge.saveNetwork({turnUrl:byId('turn-url').value,turnAuth:byId('turn-auth').value,turnSecret:byId('turn-secret').value,turnUsername:byId('turn-user').value,turnCredential:byId('turn-password').value,forceRelay:clear?false:byId('force-relay').checked,clear}));}
  catch(error){byId('turn-status').textContent=error.message;byId('turn-status').classList.add('error');}
  finally{busy=false;byId('save-network').textContent='Salvar rede';controls();}
}
byId('save-network').onclick=()=>saveNetwork();byId('clear-turn').onclick=()=>saveNetwork(true);
byId('turn-auth').onchange=()=>{byId('turn-secret').value='';byId('turn-password').value='';authentication();};
bridge.network().then(network).catch(error=>{byId('turn-status').textContent=error.message;});
void refresh();

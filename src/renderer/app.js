import { LocalLoopback, PeerMedia, captureSystemMedia, startLocalLoopbackTest } from './webrtc.js';
import { shutdownMedia } from './shutdown.js';
import { connectSignaling, relaySocket } from './signaling.js';
import { getConnectionDiagnostics } from './connection-stats.js';
import { createShareWizard } from './share-wizard.js';
import { iconButton } from './ui-icons.js';
import { createMediaAuditSampler } from './media-audit.js';
const $ = id => document.getElementById(id);
const api = window.selfLive;
const auditSampler = createMediaAuditSampler();
let auditActive = false;
const auditStatus = document.createElement('p'); auditStatus.className = 'meta'; auditStatus.id = 'audit-status';
document.getElementById('encoder-info').after(auditStatus);
const nodeId = crypto.randomUUID();
for (const [id, glyph, label] of [
  ['pilot-settings', 'settings', 'Configurações'], ['save-user-name', 'check', 'Salvar meu nome'],
  ['open-diagnostics', 'activity', 'Diagnóstico de conexão'], ['close-diagnostics', 'close', 'Fechar diagnóstico'],
  ['close-connectivity-help', 'close', 'Fechar ajuda'],
  ['pilot-close', 'close', 'Fechar configurações'], ['fullscreen-toggle', 'fullscreen', 'Entrar em tela cheia'],
  ['play-pause', 'pause', 'Pausar vídeo'], ['theater-toggle', 'panels', 'Ocultar painéis (modo teatro)'],
]) iconButton($(id), glyph, label);
$('want-stream').classList.replace('btn-secondary', 'btn-primary');
$('copy-link').textContent = 'Copiar link';
$('copy-link').classList.replace('btn-primary', 'btn-secondary');
const networkSettings = document.createElement('details');
const networkSummary = document.createElement('summary'); networkSummary.textContent = 'Rede e conexão (avançado)'; networkSettings.append(networkSummary);
for (const id of ['pilot-relay', 'pilot-upnp']) networkSettings.append(document.querySelector(`label[for="${id}"]`), $(id));
$('pilot-message').before(networkSettings);
$('pilot-dialog').querySelector('h2').textContent = 'Configurações';
$('p2p-status').classList.add('sr-only');
function selectEntry(mode) {
  for (const name of ['create', 'join']) {
    $(`entry-${name}`).setAttribute('aria-selected', String(name === mode));
    $(`entry-${name}`).tabIndex = name === mode ? 0 : -1;
    $(`${name}-panel`).hidden = name !== mode;
  }
}
for (const mode of ['create', 'join']) {
  $(`entry-${mode}`).onclick = () => selectEntry(mode);
  $(`entry-${mode}`).onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'create' : event.key === 'End' ? 'join' : mode === 'create' ? 'join' : 'create';
      selectEntry(next); $(`entry-${next}`).focus();
    }
  };
}
selectEntry('create');
let stream, socket, config, media, busy = false, joined = false, generation = 0;
let shuttingDown = false, shutdownPromise;
let joinAbort;
let connectivity;
let hostRelayState = { state: 'disabled' };
let viewerRelayState, activeSignaling, hosting = false;
let currentView = 'landing';
let savingName = false;
function nameValid() { return Boolean($('user-name').value.trim()) && $('user-name').checkValidity(); }
function identityControls() {
  const disabled = !config || !nameValid() || savingName || shuttingDown;
  $('create-room').disabled = disabled;
  $('join').querySelector('button').disabled = disabled || Boolean(joinAbort && !joined);
  $('save-user-name').disabled = disabled;
}
async function saveUserName() {
  if (!nameValid()) { $('user-name').reportValidity(); $('user-name').focus(); return false; }
  const name = $('user-name').value.trim();
  if (config.name === name && !config.requiresName) return true;
  savingName = true; identityControls();
  try {
    config.name = api.saveUserName ? await api.saveUserName(name) : name;
    config.requiresName = false; $('user-name').value = config.name;
    $('user-name-status').textContent = 'Nome salvo neste PC.';
    return true;
  } finally { savingName = false; identityControls(); }
}
function setTheater(enabled) {
  document.body.classList.toggle('watching-theater', enabled);
  $('theater-toggle').setAttribute('aria-pressed', String(enabled));
  iconButton($('theater-toggle'), 'panels', enabled ? 'Mostrar painéis' : 'Ocultar painéis (modo teatro)');
}
function setView(name) {
  if (name !== currentView) {
    setTheater(name === 'watching');
    if (name !== 'watching' && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  currentView = name;
  document.body.dataset.view = name;
  for (const view of ['landing', 'room', 'streaming', 'watching']) {
    const section = $(`view-${view}`);
    section.classList.toggle('hidden', view !== name);
    section.setAttribute('aria-hidden', String(view !== name));
  }
  $('room-header').classList.toggle('hidden', name === 'landing');
  $('media-indicators').classList.toggle('hidden', !['streaming', 'watching'].includes(name));
  for (const [slot, id] of [['users', 'users-card'], ['streams', 'streams-card'], ['capture', 'capture-card'], ['share', 'share-card']]) {
    const target = $(`view-${name}`).querySelector(`[data-slot="${slot}"]`);
    const destination = target || $('view-room').querySelector(`[data-slot="${slot}"]`);
    if ($(id).parentElement !== destination) destination.append($(id));
  }
  $('want-stream').classList.toggle('hidden', name === 'streaming');
  const active = streams.get(media?.watching?.peerId);
  const streamer = peers.get(media?.watching?.peerId)?.name || 'Stream remoto';
  $('watching-title').textContent = streamer;
  $('watching-info').textContent = active ? `${streamer} · ${active.res} · ${active.fps} fps` : 'Preparando a transmissão…';
  $('session-summary').textContent = ({ landing: 'Compartilhe com convidados', room: 'Você está na sala', streaming: 'Sua tela está ao vivo', watching: 'Recebendo transmissão' })[name];
  if (!busy) $('status').textContent = ({ landing: 'Pronto', room: 'Sala conectada', streaming: 'Transmitindo', watching: 'Assistindo' })[name];
}
function renderRelay(state, host = true) {
  if (host) hostRelayState = state;
  else viewerRelayState = state;
  if (activeSignaling === 'relay' && viewerRelayState) state = viewerRelayState;
  const label = ({ online: '🟢 Relay online', connecting: '🟡 Relay conectando',
    reconnecting: `🟡 Relay reconectando (${state.backoff || 0}s)`, offline: '🔴 Relay offline (modo P2P puro)',
    disabled: '⚪ Relay desativado' })[state.state] || '🔴 Relay offline';
  $('relay-status').textContent = label;
  $('relay-status').dataset.status = state.state;
  $('relay-indicator').textContent = label;
  if (!host) {
    $('signaling-mode').textContent = state.state === 'online' ? '🟡 Via relay' : '🔴 Falha (reconectando)';
    const signaling = state.state === 'online' ? 'relay' : 'failed';
    api.setSignaling?.(signaling); $('signaling-mode').dataset.signaling = signaling;
  }
  const online = activeSignaling !== 'relay' && hostRelayState.state === 'online';
  const onlyRelay = connectivity?.network?.ipv4Status === 'cgnat' && !connectivity?.ipv6;
  $('relay-notice').textContent = !online ? '' : onlyRelay ?
    'Seu host não é alcançável diretamente. Todos os viewers conectarão via relay.' :
    'Relay ativo como fallback. Conexões diretas continuam preferidas.';
  $('relay-notice').title = 'Estimativa baseada no diagnóstico da rede; confira rota e firewall.';
}
let invitationGeneration = 0;
const peers = new Map();
const streams = new Map(); // node_id → stream ativo anunciado pela sala
const loopback = new LocalLoopback($('remote'), text => { $('rtc-info').textContent = text; });
let sampling = false;
const uiTimer = setInterval(async () => {
  if (sampling || shuttingDown || !media?.stream) return;
  sampling = true;
  const current = media;
  try {
    const results = await Promise.all([...current.outgoing.values()].map(async connection => {
      const stats = await connection.pc.getStats();
      const info = getConnectionDiagnostics(stats);
      const outbound = [...stats.values()].find(stat => stat.type === 'outbound-rtp' && stat.kind === 'video');
      return { peerId: connection.peerId, info, encoder: outbound?.encoderImplementation, audit:{...auditSampler.sample(connection.pc,stats),transport:info} };
    }));
    if (media !== current || !current.stream || shuttingDown) return;
    $('viewer-list').replaceChildren(...results.map(({ peerId, info }) => {
      const item = document.createElement('li');
      item.textContent = peers.get(peerId)?.name || 'Convidado';
      item.title = info.rttMs === null ? 'Latência indisponível' : `RTT: ${Math.round(info.rttMs)} ms`;
      item.className = `quality-${info.quality}`; return item;
    }));
    if (!results.length) $('viewer-list').textContent = 'Nenhum viewer conectado.';
    const settings = current.stream.getVideoTracks()[0]?.getSettings() || {};
    if (auditActive) api.mediaAuditSample?.({ capture:{ width:settings.width, height:settings.height, frameRate:settings.frameRate,
      bitrate:current.bitrate, viewers:results.length, previewVisible:document.visibilityState === 'visible' && Boolean($('preview').getClientRects().length),
      loopbackActive:Boolean(loopback.sender) }, connections:results.map(result=>result.audit) });
    $('capture-info').textContent = `${settings.width || '—'} × ${settings.height || '—'} · ${Math.round(settings.frameRate || 0)} fps · ${current.bitrate / 1000000} Mbps`;
    $('encoder-info').textContent = `H.264 / Opus · ${results.find(result => result.encoder)?.encoder || 'Encoder aguardando conexão'}`;
    if (currentView === 'streaming') renderDiagnostics(results.find(result => result.info.mode === 'relay')?.info || results[0]?.info || { mode: 'unknown', rttMs: null, quality: 'unknown' });
  } catch { /* A conexão pode fechar enquanto os stats são coletados. */ }
  finally { sampling = false; }
}, 2000);
const failure = error => { console.error(`[Dashboard] ${error.name || 'Error'}`); $('error').textContent = error.message; };

function controls() {
  document.body.dataset.busy = String(busy);
  identityControls();
  $('share-password').disabled = !joined || !hosting || busy;
  $('share-password').title = hosting ? 'Copiar senha da sala' : 'Somente o anfitrião pode copiar a senha';
  $('copy-link').disabled = !joined || busy;
  if (shuttingDown) { document.querySelectorAll('button').forEach(button => { button.disabled = true; }); return; }
  $('start').disabled = busy || Boolean(stream);
  $('stop').disabled = busy || !stream;
  $('loopback').disabled = busy;
  $('stop-test').disabled = busy || !loopback.sender;
  $('start-stream').disabled = busy || !joined || Boolean(media?.stream) || ($('share-dialog').open && !$('source').value);
  $('want-stream').disabled = busy || !joined || Boolean(stream);
  for (const id of ['share-cancel', 'share-back', 'share-next']) $(id).disabled = busy;
  document.querySelectorAll('.source-tile').forEach(button => { button.disabled = busy || Boolean(stream); });
  $('stop-stream').disabled = busy || !media?.stream;
  $('stop-watch').disabled = !media?.watching;
  $('preset').disabled = busy || Boolean(stream);
  $('resolution').disabled = busy || Boolean(stream);
  $('capture-fps').disabled = busy || Boolean(stream);
  $('source').disabled = busy || Boolean(stream);
  $('audio-app').disabled = busy || Boolean(stream);
  $('audio-mode').disabled = busy || Boolean(stream);
  $('audio-manual').disabled = busy || Boolean(stream);
  $('refresh').disabled = busy || Boolean(stream);
  setView(media?.stream ? 'streaming' : media?.watching ? 'watching' : joined ? 'room' : 'landing');
  renderPeers();
  renderStreams();
}

async function refresh() {
  const previousSource = $('source').value;
  const sources = await api.sources();
  $('source').replaceChildren(...sources.map(source => {
    const option = new Option(source.name, source.id);
    option.dataset.thumbnail = source.thumbnail || '';
    option.dataset.width = source.width || ''; option.dataset.height = source.height || '';
    return option;
  }));
  if (sources.some(source => source.id === previousSource)) $('source').value = previousSource;
  const selected = new Set([...$('audio-app').selectedOptions].map(option => option.value));
  const remembered = [...$('audio-app').selectedOptions].map(option => ({ name: option.value, blocked: option.dataset.blocked === 'true' }));
  let audioSources;
  try { audioSources = await api.applicationAudioSources?.(); } catch { /* Keep video available. */ }
  const applications = [...(audioSources?.applications || [])];
  for (const app of remembered) if (!applications.some(item => item.name === app.name)) applications.push(app);
  $('audio-app').replaceChildren(...applications.map(app => {
    const option = new Option(app.name, app.name);
    option.dataset.blocked = String(app.blocked); option.selected = selected.has(app.name); return option;
  }));
  $('audio-availability').textContent = audioSources?.reason || 'Abra o aplicativo e reproduza um som para aparecer na lista. Atualizar preserva sua seleção.';
  if ($('share-dialog').open && !previousSource) {
    const placeholder = new Option('Selecione uma tela ou janela', '', true, true);
    placeholder.disabled = true; $('source').prepend(placeholder); $('source').value = '';
  }
  updateAudioChoice();
}
function updateAudioChoice() {
  const windowSource = $('source').value.startsWith('window:');
  const mode = $('audio-mode').value;
  const desktop = mode === 'on' && $('source').value.startsWith('screen:');
  $('audio-choice').hidden = !desktop;
  $('audio-manual-choice').hidden = !desktop;
  $('audio-app-label').textContent = 'Não compartilhar som destes aplicativos';
  for (const option of $('audio-app').options) option.disabled = false;
  const exclusions = [...$('audio-app').selectedOptions].map(option => option.value.replace(/\.exe$/i, ''));
  $('capture-audio-info').textContent = mode === 'none' ? 'Sem áudio.' : windowSource ?
    'Som do aplicativo desta janela, incluindo outras janelas e chamadas do mesmo app. As exclusões da tela inteira não se aplicam.' : desktop ?
      `Som dos aplicativos disponíveis${exclusions.length ? ` · Excluídos: ${exclusions.join(', ')}` : ' · Nenhum aplicativo excluído'}. Ajuste em Mais opções.` : 'Com áudio · O som acompanha a tela ou janela escolhida.';
}

function stop() {
  if (auditActive) { auditActive = false; api?.mediaAuditStop?.(); auditSampler.reset(); }
  generation++;
  loopback.stop();
  media?.stopStreaming();
  stream?.stopApplicationAudio?.();
  stream?.getTracks().forEach(track => track.stop());
  stream = null; $('preview').srcObject = null;
  $('audio-live-state').textContent = '';
  $('status').textContent = 'Pronto para capturar'; $('rtc-info').textContent = 'Aguardando captura.';
  if (!media?.watching) $('p2p-status').textContent = 'Transmissão parada.';
  api?.streaming(false);
  controls();
}

async function ensureCapture() {
  if (stream) return stream;
  if (!$('source').value) throw new Error('Selecione uma tela ou janela.');
  const current = generation;
  const mode = $('audio-mode').value;
  const applications = [...$('audio-app').selectedOptions].filter(option => !option.disabled).map(option => option.value);
  if (mode === 'on') applications.push(...$('audio-manual').value.split(/[;,\n]/).map(value => value.trim()).filter(Boolean));
  await api.selectSource($('source').value, mode === 'none' ? { mode: 'none', applications: [] } :
    $('source').value.startsWith('window:') ? { mode: 'window', sourceId: $('source').value } : { mode: 'desktop', applications });
  const captured = await captureSystemMedia({ resolution: $('resolution').value, fps: Number($('capture-fps').value) });
  if (current !== generation) {
    captured.stopApplicationAudio?.();
    captured.getTracks().forEach(track => track.stop());
    throw new Error('Captura cancelada.');
  }
  stream = captured;
  captured.getVideoTracks()[0].addEventListener('ended', stop, { once: true });
  const settings = captured.getVideoTracks()[0].getSettings();
  $('capture-info').textContent = `Captura: ${settings.width}×${settings.height} · ${settings.frameRate} fps. Prévia silenciosa.`;
  $('capture-audio-info').textContent = captured.audioNote || 'Áudio da fonte selecionada.';
  captured.addEventListener('application-audio-change', () => { $('capture-audio-info').textContent = captured.audioNote; });
  $('preview').srcObject = captured;
  $('status').textContent = 'Captura ativa'; api.streaming(true);
  return captured;
}

async function runMedia(action) {
  if (busy || shuttingDown) return;
  busy = true; $('error').textContent = ''; controls();
  try { await action(); }
  catch (error) { stop(); failure(error); shareWizard.error(error.message); }
  finally { busy = false; controls(); }
}

function send(message) {
  if (!joined || socket?.readyState !== WebSocket.OPEN) throw new Error('Entre na sala antes de conectar a mídia.');
  socket.send(JSON.stringify(message));
}

function renderPeers() {
  $('peers').replaceChildren(...[...peers.values()].map(peer => {
    const item = document.createElement('li');
    item.dataset.peerId = peer.node_id;
    item.dataset.streaming = String(streams.has(peer.node_id));
    item.textContent = `${peer.name || 'Convidado'}${peer.node_id === nodeId ? ' (você)' : ''} · `;
    const indicator = document.createElement('span');
    indicator.className = 'status-indicator';
    indicator.dataset.active = String(streams.has(peer.node_id));
    indicator.textContent = streams.has(peer.node_id) ? 'Ao vivo' : 'Disponível';
    item.append(indicator);
    if (peer.node_id !== nodeId && streams.has(peer.node_id)) item.append(watchButton(peer.node_id));
    return item;
  }));
  if (!peers.size) { const item = document.createElement('li'); item.textContent = 'Ninguém conectado.'; $('peers').append(item); }
}

function renderDiagnostics(info) {
  const labels = {
    connecting: 'Conectando…', failed: '🔴 Falha', unknown: 'Aguardando conexão',
    relay: '🟡 Relay (TURN)', direct: info.family === 'IPv6' ? '🟢 Direta (IPv6)' : '🟢 Direta (P2P)'
  };
  $('connection-mode').textContent = labels[info.mode] || labels.unknown;
  $('connection-rtt').textContent = info.rttMs === null ? 'RTT: —' : `RTT: ${Math.round(info.rttMs)} ms`;
  $('connection-rtt').className = `quality-${info.quality}`;
  $('connection-rtt').title = ({ good: 'RTT baixo: abaixo de 100 ms', fair: 'RTT moderado: abaixo de 250 ms',
    poor: 'RTT alto: 250 ms ou mais', unknown: 'RTT indisponível' })[info.quality];
}

function renderConnectivity(info) {
  connectivity = info;
  renderRelay(hostRelayState);
  const state = info.network?.status || 'unknown';
  const cgnat = state === 'cgnat' || info.network?.ipv4Status === 'cgnat';
  const mapping = info.portMapping || api?.portMapping || {};
  const mapped = mapping.status === 'mapped';
  const labels = { public: '🟢 Pública', nat: mapped ? '🟡 NAT (UPnP ativo)' : '🟡 NAT (sem UPnP)',
    cgnat: '🔴 CGNAT / NAT duplo', unknown: '⚪ Desconhecido' };
  $('connectivity-state').textContent = `Estado da rede: ${labels[state] || labels.unknown}`;
  $('connectivity-state').className = `network-${state}${state === 'nat' && !mapped ? '-unmapped' : ''}`;
  const method = ({ pcp: 'PCP', 'nat-pmp': 'NAT-PMP', upnp: 'UPnP' })[mapping.method] || 'UPnP';
  const portText = (protocol, ports, result) => {
    const label = Array.isArray(ports) ? ports.length > 1 ? `${ports[0]}–${ports.at(-1)}` : ports[0] : ports;
    const prefix = `${protocol} ${label || '—'}`;
    // Um mapeamento doméstico não remove a camada NAT da operadora.
    if (cgnat) return info.ipv6 ? `${prefix} — IPv4 sem rota (CGNAT); use IPv6` : `${prefix} — sem rota (CGNAT)`;
    if (result) return `${prefix} — mapeada via ${method}`;
    if (info.ipv6) return `${prefix} — acesso por IPv6; confira o firewall`;
    if (info.network?.ipv4Status === 'public') return `${prefix} — acesso direto; confira o firewall`;
    return `${prefix} — port forwarding manual necessário`;
  };
  $('mapping-tcp').textContent = portText('TCP', info.wsPort || config?.wsPort, mapping.tcp);
  $('mapping-udp').textContent = portText('UDP', info.udpPorts || [], mapping.udp);
  $('connectivity-ipv6').textContent = `IPv6: ${info.ipv6 ? 'Disponível' : 'Ausente'}`;
  $('cgnat-warning').hidden = !cgnat;
  $('nat-status').textContent = cgnat && info.ipv6 ? 'Rede: IPv6 pública; IPv4 com CGNAT ou NAT duplo' : state === 'cgnat' ? 'Rede: CGNAT ou NAT duplo detectado' : state === 'nat' ?
    'Rede: NAT detectado — conexões podem precisar de relay' : state === 'public' ? 'Rede: pública ou IPv6 disponível' : 'Rede: não foi possível determinar';
  if ($('connectivity-help').open) renderConnectivityHelp();
  if ($('invitation-link').value && !shuttingDown) updateInvitation(true).catch(() => {
    $('invitation-status').textContent = 'A conectividade mudou. Gere e copie um novo link antes de compartilhá-lo.';
  });
}

async function updateInvitation(refreshOnly = false) {
  const current = ++invitationGeneration;
  const link = await api.generateAccessLink(nodeId);
  if (current !== invitationGeneration || shuttingDown) return;
  const changed = $('invitation-link').value !== link;
  $('invitation-link').value = link; $('copy-link').disabled = false;
  if (!refreshOnly || changed) $('invitation-status').textContent = refreshOnly ?
    'Os endereços foram atualizados. Copie o novo link para compartilhar.' : 'Link pronto. Envie-o com a senha por um canal privado.';
}

function renderConnectivityHelp() {
  const state = connectivity?.network?.ipv4Status === 'cgnat' ? 'cgnat' : connectivity?.network?.status || 'unknown';
  const tips = {
    public: ['Compartilhe o link de acesso com a pessoa que vai entrar na sala.',
      'Permita o Self Live no firewall de rede privada. Para IPv6, a regra também deve permitir a porta WSS e a faixa UDP mostradas no dashboard.'],
    nat: ['Ative UPnP ou NAT-PMP no roteador e reinicie o Self Live para tentar mapear as portas.',
      'Se o roteador não oferecer mapeamento automático, configure port forwarding TCP para a porta WSS e UDP para a faixa de mídia mostradas aqui, apontando para este computador.',
      'Habilitar IPv6 no roteador pode permitir conexão direta sem port forwarding. O firewall continua precisando permitir o aplicativo.'],
    cgnat: ['Você está atrás de CGNAT. Para que outros possam se conectar ao seu WSS, é necessário IPv6 ou um servidor de signaling relay. UPnP não funciona neste cenário.',
      'Solicite IPv6 à operadora e ative IPv6 no roteador. Outra opção é solicitar um IPv4 público e então abrir as portas no roteador.',
      'TURN resolve o transporte de mídia; ele não torna a sinalização WSS acessível. Configure o signaling relay e compartilhe um link atualizado.'],
    unknown: ['Confira a conexão à Internet e permita a consulta de rede no firewall. Sem diagnóstico, teste primeiro duas instâncias em localhost ou na mesma LAN.',
      'Ative UPnP no roteador ou configure port forwarding TCP/UDP para as portas exibidas. Se houver CGNAT, solicite IPv6 ou IPv4 público à operadora.']
  };
  $('connectivity-instructions').replaceChildren(...(tips[state] || tips.unknown).map(text => {
    const item = document.createElement('li'); item.textContent = text; return item;
  }));
}

function showConnectivityHelp(event) {
  event?.preventDefault(); renderConnectivityHelp(); $('connectivity-help').showModal();
}

$('connection-help').onclick = showConnectivityHelp;
$('diagnostic-link').onclick = showConnectivityHelp;
$('close-connectivity-help').onclick = () => $('connectivity-help').close();
$('generate-link').onclick = async () => {
  try {
    if (shuttingDown) return;
    await updateInvitation();
  } catch (error) { failure(error); }
};
$('copy-link').onclick = async () => {
  try { await updateInvitation(); await api.copyText($('invitation-link').value); $('invitation-status').textContent = 'Link copiado.'; }
  catch { $('invitation-status').textContent = 'Não foi possível copiar o link. Tente novamente.'; }
};

function watchButton(peerId) {
  const button = document.createElement('button');
  button.textContent = 'Assistir'; button.disabled = !joined || busy;
  button.className = 'btn-primary';
  button.classList.toggle('hidden', currentView !== 'room');
  button.onclick = async () => {
    try {
      const active = streams.get(peerId);
      if (!active) throw new Error('Esse peer não está transmitindo.');
      // startWatching avisa o streamer anterior, fecha sua conexão e abre a nova.
      await media.startWatching(peerId, active.stream_id); controls();
    } catch (error) { failure(error); }
  };
  return button;
}

function renderStreams() {
  $('streams').replaceChildren(...[...streams.values()].map(active => {
    const item = document.createElement('li');
    item.dataset.peerId = active.node_id;
    item.dataset.self = String(active.node_id === nodeId);
    item.textContent = peers.get(active.node_id)?.name || 'Convidado';
    item.title = `${active.res} · H.264 · ${active.fps} fps · ${active.bitrate / 1000000} Mbps`;
    if (active.node_id !== nodeId) item.append(watchButton(active.node_id));
    else item.append(document.createTextNode(' · Sua transmissão'));
    return item;
  }));
  if (!streams.size) { const item = document.createElement('li'); item.className = 'empty-state'; item.textContent = 'Nenhuma transmissão por enquanto. Quando alguém compartilhar a tela, ela aparecerá aqui.'; $('streams').append(item); }
}

function disconnect() {
  shareWizard.close();
  joinAbort?.abort(); joinAbort = null;
  joined = false;
  hosting = false;
  activeSignaling = null; viewerRelayState = null;
  renderRelay(hostRelayState);
  const previous = socket; socket = null;
  media?.close(); media = null; stop(); previous?.close(1000, 'leave');
  peers.clear(); streams.clear(); renderPeers(); renderStreams();
  $('connection').textContent = 'Desconectado'; $('leave').disabled = true;
  $('signaling-mode').textContent = '🔴 Falha';
  api.setSignaling?.('failed'); $('signaling-mode').dataset.signaling = 'failed';
  $('join').querySelector('button').disabled = false;
  $('p2p-status').textContent = 'Entre na sala para transmitir ou assistir.';
  $('capture-settings').classList.add('hidden');
  $('error').textContent = '';
  renderDiagnostics({ mode: 'unknown', rttMs: null, quality: 'unknown' });
  controls();
}

$('join').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || shuttingDown) return;
  let attempt;
  try {
    if (!await saveUserName()) return;
    const password = $('password').value;
    const accessLink = $('access-link').value.trim();
    disconnect();
    attempt = joinAbort = new AbortController();
    $('join').querySelector('button').disabled = true;
    $('leave').disabled = false; $('diagnostic-link').hidden = true;
    const invitation = await api.useAccessLink(accessLink);
    if (attempt.signal.aborted) return;
    const room = invitation?.room || config.room;
    const endpoints = invitation?.endpoints || config.signalEndpoints || [{ type: 'localhost', url: config.wsUrl, priority: 1 }];
    const hash = await api.hash(password, room);
    if (attempt.signal.aborted) return;
    $('password').value = '';
    $('connection').textContent = 'Conectando…';
    const connection = await connectSignaling({ endpoints, signal: attempt.signal,
      makeSocket: (url, endpoint) => endpoint.type === 'relay' ? relaySocket(api, endpoint, state => renderRelay(state, false)) : new WebSocket(url),
      hello: { type: 'hello', room, password_hash: hash, node_id: nodeId, name: config.name,
        endpoints: [...(config.endpointUrls || []).slice(0, 7), config.localWsUrl] },
      onAttemptStatus: text => { if (!attempt.signal.aborted) $('connection').textContent = text; } });
    if (attempt.signal.aborted || shuttingDown) { connection.socket.close(1000, 'leave'); return; }
    const current = socket = connection.socket;
    $('room-name').textContent = room;
    const onMessage = async event => {
      if (socket !== current || shuttingDown) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'welcome') {
          joined = true;
          hosting = connection.endpoint.url === config.localWsUrl;
          $('room-name').textContent = hosting ? 'Sua sala' : invitation?.name ? `Sala de ${invitation.name}` : 'Sala compartilhada';
          $('room-name').title = room;
          peers.clear(); message.peers.forEach(peer => peers.set(peer.node_id, peer));
          streams.clear(); message.streams.forEach(active => streams.set(active.node_id, active));
          media ??= new PeerMedia({ nodeId, send, video: $('p2p-video'), diagnostics: renderDiagnostics,
            iceTransportPolicy: config.iceTransportPolicy || 'all', report: (text, id) => {
            $('p2p-status').textContent = text === 'Assistindo' ? `Assistindo ${peers.get(id)?.name || id}` : text;
            controls();
          } });
          $('connection').textContent = `Conectado à sala ${room} · ${connection.endpoint.url}`;
          activeSignaling = connection.endpoint.type === 'relay' ? 'relay' : 'direct';
          api.setSignaling?.(activeSignaling); $('signaling-mode').dataset.signaling = activeSignaling;
          renderRelay(hostRelayState);
          $('signaling-mode').textContent = connection.endpoint.type === 'relay' ? '🟡 Via relay' : '🟢 Direta (host)';
          $('p2p-status').textContent = 'Sala conectada. Inicie a transmissão ou escolha um peer.';
          $('leave').disabled = false;
        } else if (message.type === 'user_joined') peers.set(message.node_id, message.info);
        else if (message.type === 'user_left') { peers.delete(message.node_id); streams.delete(message.node_id); media?.peerLeft(message.node_id); }
        else if (message.type === 'stream_started') streams.set(message.node_id, message);
        else if (message.type === 'stream_stopped') {
          if (streams.get(message.node_id)?.stream_id === message.stream_id) streams.delete(message.node_id);
          await media?.handleMessage(message);
        }
        else await media?.handleMessage(message);
        controls();
      } catch (error) { failure(error); }
    };
    const onClose = event => {
      if (socket !== current || shuttingDown) return;
      const watching = Boolean(media?.watching) || $('p2p-status').textContent === 'Streamer desconectado';
      disconnect();
      $('connection').textContent = `Conexão encerrada${event.reason ? ': ' + event.reason : ''}`;
      if (watching) $('p2p-status').textContent = 'Streamer desconectado';
    };
    const onError = () => { if (!shuttingDown) $('connection').textContent = 'Falha no canal WSS. Confira endereço e impressão do certificado.'; };
    await onMessage({ data: JSON.stringify(connection.welcome) });
    connection.bind({ onMessage, onClose, onError });
  } catch (error) {
    if (error.name === 'AbortError' || attempt?.signal.aborted) return;
    disconnect(); failure(error);
    if (error.name === 'ConnectivityError') $('diagnostic-link').hidden = false;
  }
});

$('start').onclick = () => runMedia(ensureCapture);
$('stop').onclick = stop;
$('refresh').onclick = () => refresh().catch(failure);
$('source').onchange = updateAudioChoice;
$('audio-mode').onchange = updateAudioChoice;
$('audio-app').onchange = updateAudioChoice;
$('audio-manual').oninput = updateAudioChoice;
$('leave').onclick = () => {
  disconnect(); $('access-link').value = ''; $('password').value = '';
};
$('loopback').onclick = () => runMedia(async () => {
  const captured = await ensureCapture();
  await startLocalLoopbackTest({ loopback, preview: $('preview'), stream: captured, bitrate: Number($('preset').value) });
  $('status').textContent = 'Teste de mídia local ativo';
});
$('stop-test').onclick = stop;
$('start-stream').onclick = () => {
  if ($('share-dialog').open && !shareWizard.valid()) return;
  return runMedia(async () => {
  if (!joined || !media) throw new Error('Entre na sala antes de transmitir.');
  const connection = media;
  const captured = await ensureCapture();
  if (connection !== media || !joined) throw new Error('Sala desconectada durante a captura.');
  await media.startStreaming({ stream: captured, bitrate: Number($('preset').value) });
  if (!auditActive) {
    auditSampler.reset();
    try {
      const settings = captured.getVideoTracks()[0].getSettings();
      const audit = await api.mediaAuditStart?.({ width:settings.width, height:settings.height, frameRate:settings.frameRate, bitrate:Number($('preset').value) });
      auditActive = Boolean(audit?.enabled);
      auditStatus.textContent = audit?.enabled ? `Diagnóstico salvo em ${audit.name}${audit.fallback ? ' (pasta de dados do app; pasta do EXE sem permissão)' : ' (ao lado do EXE)'}.` : 'Não foi possível criar o log de diagnóstico.';
    } catch { auditStatus.textContent = 'Não foi possível criar o log de diagnóstico. A transmissão continua.'; }
  }
  await shareWizard.complete();
  $('status').textContent = 'Transmitindo';
  });
};
$('stop-stream').onclick = stop;
$('stop-watch').onclick = () => { media?.stopWatching(); $('p2p-status').textContent = media?.stream ? 'Transmitindo' : 'Viewer parado.'; controls(); };
$('back-room').onclick = () => $('stop-watch').click();
const shareWizard = createShareWizard({ api, refresh, updateAudioChoice, canOpen: () => joined && !busy && !stream && !media?.watching });
$('want-stream').onclick = () => shareWizard.open();
$('create-room').onclick = async () => {
  if (!nameValid()) { $('user-name').reportValidity(); $('user-name').focus(); return; }
  $('access-link').value = '';
  try {
    if (config?.pilotEnabled || !$('password').value) $('password').value = await api.pilotPassword();
    $('join').requestSubmit();
  } catch (error) { failure(error); }
};
$('user-name').oninput = () => {
  $('user-name').setCustomValidity($('user-name').value && !$('user-name').value.trim() ? 'Informe seu nome.' : '');
  $('user-name-status').textContent = 'Seu nome será lembrado ao criar ou entrar em uma sala.';
  identityControls();
};
$('identity-form').onsubmit = async event => {
  event.preventDefault();
  if (savingName) return;
  try { if (await saveUserName()) $('create-room').focus(); }
  catch (error) { $('user-name-status').textContent = error.message; }
};
$('pilot-settings').onclick = async () => {
  try {
    const settings = await api.pilotSettings();
    for (const key of ['name', 'room', 'relay', 'upnp']) $(`pilot-${key}`).value = settings[key === 'relay' ? 'relayUrl' : key];
    $('pilot-password').value = ''; $('pilot-message').textContent = 'Senha protegida no perfil Windows. Compartilhe-a por um canal privado.';
    $('pilot-shared-password').value = ''; $('pilot-shared-password').hidden = true;
    $('pilot-restart').disabled = true; $('pilot-dialog').showModal();
  } catch (error) { failure(error); }
};
$('pilot-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await api.pilotSave({ name: $('pilot-name').value.trim(), room: $('pilot-room').value.trim(),
      relayUrl: $('pilot-relay').value.trim(), upnp: $('pilot-upnp').value,
      ...($('pilot-password').value ? { password: $('pilot-password').value } : {}) });
    $('pilot-password').value = ''; $('pilot-message').textContent = 'Salvo. Reinicie o aplicativo para aplicar.';
    $('pilot-restart').disabled = false;
  } catch (error) { $('pilot-message').textContent = error.message; }
};
$('pilot-show-password').onclick = async () => {
  try {
    $('pilot-shared-password').value = await api.pilotPassword();
    $('pilot-shared-password').hidden = false; $('pilot-shared-password').select();
    $('pilot-message').textContent = 'Senha da sala atual. Use Ctrl+C e compartilhe por um canal privado.';
  }
  catch (error) { $('pilot-message').textContent = error.message; }
};
$('pilot-close').onclick = () => $('pilot-dialog').close();
$('pilot-dialog').addEventListener('close', () => {
  $('pilot-message').textContent = ''; $('pilot-password').value = '';
  $('pilot-shared-password').value = ''; $('pilot-shared-password').hidden = true;
});
$('pilot-restart').onclick = () => api.pilotRestart().catch(failure);
$('share-password').onclick = async () => {
  if (!joined || !hosting || shuttingDown) return;
  const button = $('share-password'); button.disabled = true;
  try {
    await api.copyText(await api.pilotPassword());
    $('invitation-status').textContent = 'Senha copiada.';
  } catch {
    $('invitation-status').textContent = 'Não foi possível copiar a senha. Tente novamente.';
  } finally { controls(); }
};
$('open-diagnostics').onclick = () => $('diagnostics-dialog').showModal();
$('close-diagnostics').onclick = () => $('diagnostics-dialog').close();
$('play-pause').onclick = async () => {
  try {
    if ($('p2p-video').paused) await $('p2p-video').play(); else $('p2p-video').pause();
  } catch (error) { failure(error); }
};
$('p2p-video').onplay = () => { iconButton($('play-pause'), 'pause', 'Pausar vídeo'); };
$('p2p-video').onpause = () => { iconButton($('play-pause'), 'play', 'Reproduzir vídeo'); };
$('volume').oninput = () => { $('p2p-video').volume = Number($('volume').value); };
$('theater-toggle').onclick = () => setTheater(!document.body.classList.contains('watching-theater'));
$('fullscreen-toggle').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('watch-player-container').requestFullscreen();
  } catch (error) { failure(error); }
};
document.addEventListener('fullscreenchange', () => {
  const fullscreen = Boolean(document.fullscreenElement);
  iconButton($('fullscreen-toggle'), 'fullscreen', fullscreen ? 'Sair da tela cheia' : 'Entrar em tela cheia');
  $('fullscreen-toggle').setAttribute('aria-label', fullscreen ? 'Sair da tela cheia' : 'Entrar em tela cheia');
});
$('sound').onchange = () => { $('remote').muted = !$('sound').checked; };
$('p2p-sound').onchange = () => { $('p2p-video').muted = !$('p2p-sound').checked; };

if (api) {
  api.onApplicationAudioState?.(state => {
    $('audio-live-state').textContent = `Enviando: ${(state.capturing || []).join(', ') || 'nenhum som'}. Excluídos: ${(state.excluded || []).join(', ') || 'nenhum identificado'}.`;
  });
  api.onShutdown(() => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true; generation++; joinAbort?.abort(); controls();
    clearInterval(uiTimer);
    stream?.stopApplicationAudio?.();
    shutdownPromise = shutdownMedia({ media, loopback, stream, socket, nodeId, log: api.shutdownLog });
    return shutdownPromise;
  });
  api.onAction(action => {
    if (action === 'start') shareWizard.open();
    else if (action === 'stop') stop();
  });
  try {
    config = await api.config(); $('room-name').textContent = config.room;
    $('user-name').value = config.requiresName ? '' : config.name || '';
    $('user-name-status').textContent = config.requiresName ? 'Escolha um nome para começar. Ele será lembrado neste PC.' : 'Este é o nome que os convidados verão. Você pode alterá-lo.';
    if (config.requiresName) $('user-name').focus();
    $('local-wss-status').textContent = '🟢 WSS do host local ativo';
    api.onRelay?.(event => { if (event.kind === 'host-status') renderRelay(event.value); });
    api.relayStatus?.().then(state => renderRelay(state)).catch(() => {});
    $('turn-status').textContent = config.iceTransportPolicy === 'relay' ? 'Teste: uso de relay obrigatório.' :
      config.turnEnabled ? 'TURN configurado como fallback.' : 'STUN configurado; TURN não configurado.';
    api.onConnectivity?.(renderConnectivity);
    if (api.connectivity) api.connectivity().then(renderConnectivity).catch(() => renderConnectivity({ network: { status: 'unknown' } }));
    else renderConnectivity({ network: { status: 'unknown' }, ipv6: (config.endpoints || []).some(endpoint => endpoint.family === 'IPv6'), wsPort: config.wsPort });
    $('host-info').textContent = `WSS local: ${config.localWsUrl} · SHA-256: ${config.fingerprint}`;
    const endpoints = config.endpoints || [];
    const ipv6 = endpoints.some(endpoint => endpoint.family === 'IPv6');
    $('network-status').textContent = ipv6 ? 'IPv6 disponível' : 'Apenas IPv4';
    $('network-status').classList.toggle('ipv6-available', ipv6);
    $('endpoints').replaceChildren(...endpoints.map((endpoint, index) => {
      const item = document.createElement('li');
      item.textContent = `${endpoint.family} · ${config.endpointUrls?.[index] || endpoint.ip} · ${endpoint.iface}`;
      if (endpoint.family === 'IPv6') item.classList.add('ipv6-available');
      return item;
    }));
    if (!endpoints.length) $('endpoints').textContent = 'Nenhum endereço externo elegível detectado. Use localhost para testes.';
    await refresh(); await shareWizard.load(); $('status').textContent = 'Pronto para capturar'; controls();
  } catch (error) { failure(error); }
} else {
  $('error').textContent = 'Abra este dashboard pelo Self Live (Electron). O navegador externo não possui a ponte de captura.';
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
}
window.addEventListener('beforeunload', () => { clearInterval(uiTimer); if (!shuttingDown) disconnect(); });


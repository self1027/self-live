import { constrainCapture, assertFhd, captureSize } from './capture-quality.js';
import { createAdaptiveQuality, createCaptureMetrics } from './adaptive-quality.js';
import { captureSystemMedia } from './webrtc.js';
import { attachApplicationAudio } from './application-audio.js';
import { createCaptureLifecycle } from './capture-lifecycle.js';
import { replaceCaptureVideo } from './replace-capture-video.js';

export function createCaptureControls({ api, preview, getStream, getMedia, getLoopback, sourceSelect, onEnded, onError, selectSource }) {
  const $ = id => document.getElementById(id);
  let settings = { loggingEnabled:false, gpuPriorityEnabled:false, adaptiveQuality:true, previewHidden:false, resolution:'auto', frameRate:60 };
  let priorityStatus = { state:'disabled' }, priorityChanging = false;
  let active = false, changing = false, epoch = 0, policy, metrics, effective;
  const anchor = document.createComment('preview'); preview.before(anchor);
  $('diagnostic-settings-panel').innerHTML = `<details><summary>CONFIGURAÇÕES DE DIAGNÓSTICO</summary>
    <label class="check"><input id="logging-enabled" type="checkbox">ATIVAR LOGS DE DIAGNÓSTICO</label>
    <p class="muted">Grava métricas de captura, GPU, rede e encoder em arquivo. Desative para reduzir uso de CPU e I/O.</p>
    <p class="muted">Com adaptive ativo, métricas mínimas continuam sendo medidas, sem gravação.</p>
    <label class="check"><input id="gpu-priority-enabled" type="checkbox">usar prioridade de gpu</label>
    <p class="muted">Experimental. Compare com e sem a opção, mantendo as mesmas configurações do jogo e da transmissão.</p>
    <p id="gpu-priority-feedback" class="muted" role="status"></p>
    <button id="open-logs-folder" class="btn-secondary">ABRIR PASTA DE LOGS</button><p id="logging-feedback" role="status"></p></details>`;
  $('advanced-capture-panel').innerHTML = `<details class="card capture-experiments"><summary>CONTROLES DE CAPTURA (AVANÇADO)</summary>
    <label class="check"><input id="adaptive-enabled" type="checkbox" checked>ADAPTIVE ON/OFF</label><p id="adaptive-status" class="muted" role="status"></p>
    <label class="check"><input id="preview-hidden" type="checkbox">OCULTAR PREVIEW DURANTE TRANSMISSÃO</label>
    <label for="experimental-resolution">RESOLUÇÃO DE CAPTURA</label><select id="experimental-resolution"><option value="auto">NATIVA (ATÉ FHD)</option><option>1920x1080</option><option>1280x720</option><option>960x540</option><option>854x480</option></select>
    <p class="muted">MÁXIMO PERMITIDO: 1920x1080. Resoluções acima são reduzidas automaticamente.</p>
    <label for="experimental-fps">CAP DE FPS DE CAPTURA</label><select id="experimental-fps"><option>60</option><option>45</option><option>30</option><option>20</option><option>15</option></select><p class="muted">Não limita o FPS do jogo. Só da captura.</p>
    <label class="check"><input id="cpu-capture" type="checkbox">FORÇAR CAPTURA POR CPU (EXPERIMENTAL)</label>
    <p class="muted">Geralmente não melhora o desempenho. O DWM compõe o desktop na GPU. Use apenas para medição.</p>
    <p id="cpu-capture-status" class="muted">Não suportado neste pipeline Chromium. A captura permanece no modo GPU; nenhum encoder é desativado.</p>
    <label for="experimental-source">TELA OU JANELA ESPECÍFICA</label><select id="experimental-source"></select><button id="refresh-experimental-sources" class="btn-secondary">ATUALIZAR FONTES</button>
    <button id="export-diagnostic" class="btn-secondary">EXPORTAR DIAGNÓSTICO</button><p id="experiment-feedback" role="status"></p></details>`;
  const continuityStatus = document.createElement('p'); continuityStatus.id = 'capture-continuity-status';
  continuityStatus.className = 'meta'; continuityStatus.setAttribute('role','status'); preview.before(continuityStatus);
  const lifecycle = createCaptureLifecycle({
    getSourceState: () => api.captureSourceState?.() || Promise.resolve({available:false}),
    recover: async () => {
      const current = getStream(), token = epoch;
      if (!active || !current || changing || !api.recoverCapture) return null;
      changing = true; update();
      try {
        await api.recoverCapture();
        if (!active || token !== epoch || current !== getStream()) return null;
        let deadline, timedOut = false;
        const acquisition = captureSystemMedia({resolution:effective.resolution,fps:effective.frameRate,
          original:current.captureOriginal,videoOnly:true}).then(replacement=>{
          if (timedOut) { replacement.getTracks().forEach(track=>track.stop()); throw new Error('Captura indisponível.'); }
          return replacement;
        });
        let replacement;
        try { replacement = await Promise.race([acquisition,new Promise((_,reject)=>{deadline = setTimeout(()=>{
          timedOut = true; reject(new Error('Aguardando recuperação da captura.'));
        },8000);})]); } finally { clearTimeout(deadline); }
        const getSenders = () => [...(getMedia()?.outgoing?.values() || [])].flatMap(connection=>connection.pc.getSenders())
          .concat(getLoopback?.()?.getSenders() || []).filter(sender=>sender.track?.kind === 'video');
        const next = await replaceCaptureVideo({stream:current,replacement,getSenders,
          isCurrent:()=>active && token === epoch && current === getStream()});
        visibility(effective.previewHidden); metrics = createCaptureMetrics();
        return next;
      } finally { changing = false; update(); }
    },
    onClosed: () => { onError(new Error('A janela compartilhada foi fechada.')); onEnded(); },
    onState: value => {
      const messages = { background:value.reason === 'minimized' ? 'Janela minimizada. A transmissão continua conectada e retoma a imagem quando a janela voltar.' :
        'Janela em segundo plano. Compartilhamento mantido.', waiting:'Aguardando a fonte voltar a fornecer imagem. A transmissão continua conectada.',
        recovering:'Restabelecendo o vídeo da fonte compartilhada…',live:'' };
      continuityStatus.textContent = messages[value.status] || '';
      if (active) api.diagnosticEvent?.({action:'capture_state',captureMode:mode(),captureLifecycle:value}).catch(()=>{});
    }
  });
  function visibility(hidden) {
    if (hidden) { preview.pause(); preview.srcObject = null; preview.remove(); }
    else { if (!preview.isConnected) anchor.after(preview); preview.srcObject = getStream(); if (preview.srcObject) preview.play().catch(()=>{}); }
  }
  function mode() {
    const stream = getStream(), track = stream?.getVideoTracks()[0], current = track?.getSettings() || {};
    const original = stream?.captureOriginal;
    const fhd = stream?.originalKnown && (original.width > 1920 || original.height > 1080);
    return { originalResolution:stream?.originalKnown ? `${original.width}x${original.height}` : null,
      effectiveResolution:current.width && current.height ? `${current.width}x${current.height}` : null,
      downscaled:Boolean(original && (current.width < original.width || current.height < original.height)),
      reason:fhd ? 'fhd_cap' : original && (current.width < original.width || current.height < original.height) ? 'quality' : null,
      frameRate:effective?.frameRate || current.frameRate, source:sourceSelect.value.startsWith('window:') ? 'window' : 'screen', mode:'gpu', previewHidden:effective?.previewHidden === true };
  }
  function update() {
    $('logging-enabled').checked = settings.loggingEnabled;
    $('logging-enabled').disabled = Boolean(getStream()) || priorityChanging; $('logging-enabled').title = getStream() ? 'Pare a transmissão para alterar' : '';
    $('gpu-priority-enabled').checked = settings.gpuPriorityEnabled === true;
    $('gpu-priority-enabled').disabled = Boolean(getStream()) || priorityChanging;
    $('gpu-priority-enabled').title = getStream() ? 'Pare a transmissão para alterar' : '';
    const priorityMessages = { disabled:'Prioridade de GPU desativada.', applying:'Aplicando prioridade de GPU…',
      applied:'Prioridade de GPU alta confirmada pelo Windows.', partial:'Prioridade aplicada parcialmente. Consulte os resultados por processo nos logs.',
      failed:'O Windows não aplicou a prioridade de GPU. Consulte o motivo nos logs.',
      waiting_gpu:'Aguardando o processo GPU para confirmar a aplicação.', helper_missing:'Prioridade indisponível: componente nativo ausente.',
      unsupported:'Prioridade de GPU disponível somente no Windows.', metrics_unavailable:'Não foi possível identificar os processos do aplicativo.',
      restore_failed:'Não foi possível confirmar a restauração da prioridade. Feche e abra o aplicativo antes de comparar.' };
    $('gpu-priority-feedback').textContent = priorityChanging ? 'Atualizando prioridade de GPU…' :
      priorityStatus.state === 'partial' && priorityStatus.gpuProcessConfirmed ? 'Prioridade alta confirmada no processo GPU; aplicação parcial nos demais processos. Detalhes nos logs.' :
      priorityMessages[priorityStatus.state] || 'Verificando prioridade de GPU…';
    $('logging-indicator').hidden = !active || !settings.loggingEnabled;
    $('adaptive-enabled').checked = settings.adaptiveQuality;
    for (const id of ['preview-hidden','experimental-resolution','experimental-fps']) $(id).disabled = !active || changing || settings.adaptiveQuality;
    $('experimental-source').disabled = !active || changing;
    $('adaptive-enabled').disabled = changing;
    $('preview-hidden').checked = effective?.previewHidden ?? settings.previewHidden;
    const resolution = effective?.resolution || settings.resolution;
    if (![...$('experimental-resolution').options].some(option=>option.value === resolution)) {
      $('experimental-resolution').add(new Option(`${resolution}p (CONFIGURADO NO MODAL)`,resolution));
    }
    $('experimental-resolution').value = resolution;
    $('experimental-fps').value = String(effective?.frameRate || settings.frameRate);
    const current = mode();
    $('fhd-badge').hidden = current.reason !== 'fhd_cap';
    $('fhd-badge').textContent = `FONTE > FHD — REDUZIDO PARA ${current.effectiveResolution || 'ATÉ 1920x1080'}`;
    $('adaptive-status').textContent = settings.adaptiveQuality ? 'CONTROLADO AUTOMATICAMENTE · AGUARDANDO MEDIÇÕES DE CAPTURA E GPU' : 'CONTROLE MANUAL';
  }
  async function save(value) { settings = api.saveDiagnosticSettings ? await api.saveDiagnosticSettings(value) : { ...settings, ...value }; update(); }
  async function sources() {
    const list = await api.sources();
    $('experimental-source').replaceChildren(...list.map(source => {
      const option = new Option(source.id.startsWith('screen:') ? `TELA INTEIRA — ${source.name}` : source.name, source.id);
      option.dataset.width = source.width || ''; option.dataset.height = source.height || ''; return option;
    }));
    $('experimental-source').value = sourceSelect.value;
  }
  async function apply(next, action = 'manual') {
    const stream = getStream(), token = epoch;
    if (!active || !stream || changing) return false;
    changing = true; update();
    try {
      if (next.resolution !== effective.resolution || next.frameRate !== effective.frameRate)
        await constrainCapture(stream.getVideoTracks()[0], { resolution:next.resolution, fps:next.frameRate, original:stream.captureOriginal });
      if (token !== epoch || stream !== getStream()) return false;
      effective = { ...next }; visibility(effective.previewHidden);
      await api.diagnosticEvent?.({ action, captureMode:mode() });
      const actual = mode().effectiveResolution;
      $('experiment-feedback').textContent = action === 'degrade' ? `QUALIDADE REDUZIDA PARA ${actual} @ ${next.frameRate} FPS POR CARGA NA GPU` :
        action === 'recover' ? `QUALIDADE RESTAURADA PARA ${actual} @ ${next.frameRate} FPS` : `CAPTURA: ${actual} @ ${next.frameRate} FPS`;
      return true;
    } catch (error) {
      api.diagnosticEvent?.({ action:'capture_error', captureMode:mode() }).catch(()=>{});
      try { assertFhd(stream.getVideoTracks()[0]); } catch { onEnded(); }
      onError(error); return false;
    } finally { changing = false; update(); }
  }
  $('logging-enabled').onchange = async () => {
    try { await save({ loggingEnabled:$('logging-enabled').checked }); $('logging-feedback').textContent = settings.loggingEnabled ? 'LOGS ATIVADOS' : 'LOGS DESATIVADOS'; }
    catch (error) { update(); onError(error); }
  };
  api.onGpuPriorityStatus?.(state => { priorityStatus = state; update(); });
  $('gpu-priority-enabled').onchange = async () => {
    const enabled = $('gpu-priority-enabled').checked;
    priorityChanging = true; update();
    try {
      await save({ gpuPriorityEnabled:enabled });
      if (api.gpuPriorityStatus) priorityStatus = await api.gpuPriorityStatus();
    } catch (error) { onError(error); }
    finally { priorityChanging = false; update(); }
  };
  $('open-logs-folder').onclick = () => api.openLogsFolder?.().catch(onError);
  $('export-diagnostic').onclick = async () => {
    try { const result = await api.exportDiagnostic(); $('experiment-feedback').textContent = `EXPORTADO: ${result.name} (${result.samples} AMOSTRAS)`; } catch (error) { onError(error); }
  };
  const exportLast = document.createElement('button'); exportLast.id = 'export-diagnostic-last'; exportLast.className = 'btn-secondary'; exportLast.textContent = 'EXPORTAR DIAGNÓSTICO';
  const exportStatus = document.createElement('p'); exportStatus.setAttribute('role','status');
  exportLast.onclick = async () => { try { const result = await api.exportDiagnostic(); exportStatus.textContent = `EXPORTADO: ${result.name} (${result.samples} AMOSTRAS)`; } catch (error) { onError(error); } };
  $('diagnostics-dialog').append(exportLast, exportStatus);
  $('adaptive-enabled').onchange = async () => {
    try {
      await save({ adaptiveQuality:$('adaptive-enabled').checked });
      policy = createAdaptiveQuality(effective || settings, getStream()?.captureOriginal);
    } catch (error) { update(); onError(error); }
  };
  for (const id of ['preview-hidden','experimental-resolution','experimental-fps']) $(id).onchange = async () => {
    const next = { resolution:$('experimental-resolution').value, frameRate:Number($('experimental-fps').value), previewHidden:$('preview-hidden').checked };
    if (await apply(next)) { try { await save(next); } catch (error) { onError(error); } }
  };
  $('cpu-capture').onchange = () => {
    $('cpu-capture').checked = false;
    $('cpu-capture-status').textContent = 'EXPERIMENTO NÃO SUPORTADO: GPU MANTIDA. DESATIVAR ACELERAÇÃO GLOBAL EXIGE REINÍCIO E TAMBÉM AFETA O ENCODER.';
    api.diagnosticEvent?.({ action:'cpu_unsupported', captureMode:mode() }).catch(onError);
  };
  $('refresh-experimental-sources').onclick = () => sources().catch(onError);
  $('experimental-source').onchange = async () => {
    const stream = getStream(), media = getMedia(), token = epoch;
    if (!active || !stream || changing) return;
    changing = true; update();
    let replacement, swaps = [], committed = false;
    const previousId = sourceSelect.value;
    try {
      const id = $('experimental-source').value;
      // Use the existing authenticated source handler, not legacy getUserMedia constraints.
      await selectSource(id);
      const option = $('experimental-source').selectedOptions[0];
      replacement = await captureSystemMedia({ resolution:effective.resolution, fps:effective.frameRate, videoOnly:true,
        original:{ width:Number(option?.dataset.width), height:Number(option?.dataset.height) } });
      if (token !== epoch || stream !== getStream() || media !== getMedia()) throw new Error('Troca de fonte cancelada.');
      const video = replacement.getVideoTracks()[0];
      const connections = [...(media?.outgoing?.values() || []), ...(getLoopback?.() ? [{pc:getLoopback()}] : [])];
      for (const connection of connections) {
        const sender = connection.pc.getSenders().find(sender => sender.track?.kind === 'video');
        if (sender) { const old = sender.track; await sender.replaceTrack(video); swaps.push({sender,old}); }
      }
      if (token !== epoch || stream !== getStream()) throw new Error('Troca de fonte cancelada.');
      await api.confirmCaptureSource?.(id);
      if (token !== epoch || stream !== getStream()) throw new Error('Troca de fonte cancelada.');
      const oldVideo = stream.getVideoTracks()[0]; stream.removeTrack(oldVideo); stream.addTrack(video);
      stream.captureOriginal = replacement.captureOriginal; stream.originalKnown = replacement.originalKnown;
      oldVideo.stop(); committed = true;
      for (const connection of media?.outgoing?.values() || []) {
        const sender = connection.pc.getSenders().find(sender=>sender.track?.kind === 'video');
        if (sender && sender.track !== video) await sender.replaceTrack(video);
      }
      if (![...sourceSelect.options].some(option=>option.value === id)) sourceSelect.add(new Option(option.textContent,id));
      sourceSelect.value = id;
      lifecycle.bind(video);
      // Reconfigure isolated application audio with the existing source policy.
      const oldAudio = stream.getAudioTracks(); stream.stopApplicationAudio?.();
      oldAudio.forEach(track => { stream.removeTrack(track); track.stop(); });
      if (replacement.getAudioTracks().length) replacement.getAudioTracks().forEach(track=>stream.addTrack(track));
      else if (oldAudio.length) await attachApplicationAudio(stream, api);
      if (token !== epoch || stream !== getStream()) {
        stream.stopApplicationAudio?.(); stream.getTracks().forEach(track=>track.stop()); throw new Error('Troca de fonte cancelada.');
      }
      const audio = stream.getAudioTracks()[0] || null;
      for (const connection of connections) {
        const sender = connection.pc.getSenders().find(sender => sender.track?.kind === 'audio') ||
          connection.pc.getTransceivers().find(transceiver=>transceiver.receiver.track.kind === 'audio')?.sender;
        if (sender) await sender.replaceTrack(audio);
      }
      policy = createAdaptiveQuality(effective, stream.captureOriginal); metrics = createCaptureMetrics();
      visibility(effective.previewHidden); await api.diagnosticEvent?.({ action:'manual', captureMode:mode() });
      $('experiment-feedback').textContent = 'FONTE ATUALIZADA. CONEXÕES PRESERVADAS.';
    } catch (error) {
      if (!committed) { await Promise.allSettled(swaps.map(({sender,old})=>sender.replaceTrack(old))); replacement?.getTracks().forEach(track=>track.stop()); sourceSelect.value = previousId; $('experimental-source').value = previousId; }
      onError(error);
    } finally { changing = false; update(); }
  };
  return {
    async load() {
      if (api.diagnosticSettings) settings = await api.diagnosticSettings();
      if (api.gpuPriorityStatus) {
        try { priorityStatus = await api.gpuPriorityStatus(); } catch { /* Older QA bridges may omit this experiment. */ }
      }
      update();
    },
    update,
    needsMetrics: () => active, // Minimal track progress is needed for recovery even with logs/adaptive OFF.
    captureEnded: () => { if (active) void lifecycle.tick(); else onEnded(); },
    async started(stream, resolution, fps) {
      epoch++; active = true; effective = { resolution, frameRate:Number(fps), previewHidden:settings.previewHidden };
      policy = createAdaptiveQuality(effective, stream.captureOriginal); metrics = createCaptureMetrics(); visibility(effective.previewHidden); update();
      const recording = await api.mediaAuditStart?.({ captureMode:mode() });
      lifecycle.start(stream.getVideoTracks()[0]);
      if (settings.loggingEnabled && !recording?.enabled) onError(new Error('Não foi possível gravar os logs. Confira as permissões de Documents/SelfLive-Logs.'));
      await sources().catch(onError);
    },
    stopped() { epoch++; active = false; lifecycle.stop(); continuityStatus.textContent = ''; policy = null; effective = null; api.mediaAuditStop?.(); visibility(false); update(); },
    async sample(connections) {
      if (!active) return;
      const stream = getStream(), token = epoch;
      const track = stream.getVideoTracks()[0];
      const measured = track?.getSettings() || {};
      try { if (track?.readyState !== 'ended' && !track?.muted && measured.width > 0 && measured.height > 0) assertFhd(track); } catch (error) {
        // Stop an oversized track even when diagnostic IPC is unavailable.
        onEnded(); onError(error);
        await api.diagnosticEvent?.({action:'capture_error',captureMode:mode()}).catch(()=>{});
        return;
      }
      if (!this.needsMetrics()) return;
      const statistics = metrics.sample(connections, effective.frameRate);
      lifecycle.observe(statistics);
      const captureLifecycle = lifecycle.snapshot();
      const settingsNow = stream.getVideoTracks()[0].getSettings();
      const data = { ...statistics, captureLifecycle, captureMode:mode(), connections, capture:{ ...settingsNow, bitrate:getMedia()?.bitrate, viewers:connections.length,
        previewVisible:!effective.previewHidden && document.visibilityState === 'visible', loopbackActive:false } };
      const gpu = await api.diagnosticSample?.(data);
      if (token !== epoch || !active || !settings.adaptiveQuality || changing) return;
      const change = policy.observe({ ...statistics, ...gpu,sourcePaused:captureLifecycle.suppressAdaptive });
      if (captureLifecycle.suppressAdaptive) { $('adaptive-status').textContent = 'ADAPTIVE: QUALIDADE PRESERVADA DURANTE PAUSA OU RETOMADA DA FONTE'; return; }
      $('adaptive-status').textContent = !policy.eligible ? 'ADAPTIVE: CONFIGURAÇÃO INICIAL ABAIXO DO PISO — QUALIDADE PRESERVADA' : !gpu?.available ? 'ADAPTIVE: GPU INDISPONÍVEL — QUALIDADE PRESERVADA' : statistics.captureStall === null ?
        'ADAPTIVE: AGUARDANDO VIEWER / FPS OBSERVADO' : 'CONTROLADO AUTOMATICAMENTE';
      if (change && await apply(change.settings, change.action) && token === epoch) policy.commit(change);
    }
  };
}

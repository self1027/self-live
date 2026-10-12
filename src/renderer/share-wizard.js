// Reutiliza os mesmos controles de captura; não modifica o transporte de mídia.
import { captureSize, resolutions } from './capture-quality.js';
import { icon, iconButton } from './ui-icons.js';
export function createShareWizard({ api, refresh, updateAudioChoice, canOpen }) {
  const $ = id => document.getElementById(id);
  const dialog = $('share-dialog');
  let opening = false;
  let preferences = { audioMode: 'on', applications: ['Discord.exe'], manual: '', bitrate: '10000000', resolution: 'auto', fps: '60' };
  let desiredResolution = 'auto';
  const move = (target, ids) => ids.forEach(id => {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) $(target).append(label);
    $(target).append($(id));
  });
  // A linha da fonte contém o botão Atualizar e permanece intacta.
  $('share-source-controls').append(document.querySelector('label[for="source"]'), $('source').parentElement);
  $('source').classList.add('sr-only'); $('source').tabIndex = -1;
  document.querySelector('label[for="source"]').classList.add('sr-only');
  iconButton($('refresh'), 'refresh', 'Atualizar prévias');
  iconButton($('share-cancel'), 'close', 'Cancelar compartilhamento');
  move('share-audio-advanced', ['audio-mode']);
  $('share-audio-advanced').append($('audio-choice'));
  $('share-audio-advanced').append($('audio-manual-choice'));
  $('share-audio-controls').append($('capture-audio-info'));
  move('share-quality-controls', ['preset']);
  $('share-confirm').append($('start-stream'));
  $('start-stream').textContent = 'Compartilhar';
  $('diagnostics-dialog').append($('audio-live-state'));
  $('capture-settings').classList.add('hidden');
  document.querySelector('label[for="preset"]').textContent = 'Limite de envio';
  $('want-stream').textContent = 'Compartilhar tela';
  const summary = document.createElement('p'); summary.id = 'share-saved';
  summary.className = 'muted'; $('capture-card').append(summary);
  // Checkboxes evitam a seleção pouco evidente por Ctrl+clique.
  const choices = document.createElement('div'); choices.className = 'audio-checkboxes';
  choices.setAttribute('role', 'group'); choices.setAttribute('aria-labelledby', 'audio-app-label');
  $('audio-app').classList.add('sr-only'); $('audio-app').tabIndex = -1;
  $('audio-app').setAttribute('aria-hidden', 'true');
  $('audio-app').after(choices);
  function renderAudio() {
    choices.replaceChildren(...[...$('audio-app').options].map(option => {
      const label = document.createElement('label'); label.className = 'check';
      const input = document.createElement('input'); input.type = 'checkbox';
      input.checked = option.selected; input.disabled = option.disabled;
      input.onchange = () => { option.selected = input.checked; updateAudioChoice(); };
      label.append(input, document.createTextNode(option.textContent)); return label;
    }));
  }
  new MutationObserver(renderAudio).observe($('audio-app'), { childList: true, subtree: true, attributes: true });
  $('audio-mode').addEventListener('change', renderAudio);
  function renderSources() {
    $('source-gallery').replaceChildren(...[...$('source').options].filter(option => option.value).map(option => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'source-tile';
      button.disabled = opening || document.body.dataset.busy === 'true';
      button.dataset.sourceId = option.value; button.setAttribute('aria-pressed', String(option.selected));
      button.setAttribute('aria-label', `Compartilhar ${option.textContent}`);
      if (option.dataset.thumbnail) {
        const image = document.createElement('img'); image.src = option.dataset.thumbnail; image.alt = ''; button.append(image);
      } else { const fallback = document.createElement('span'); fallback.className = 'source-placeholder'; fallback.innerHTML = icon(option.value.startsWith('window:') ? 'window' : 'screen'); button.append(fallback); }
      const name = document.createElement('span'); name.className = 'source-name'; name.textContent = option.textContent;
      button.title = option.textContent; button.append(name);
      button.onclick = () => { $('source').value = option.value; $('source').dispatchEvent(new Event('change')); };
      return button;
    }));
    if (!$('source-gallery').children.length) $('source-gallery').textContent = 'Nenhuma fonte disponível. Tente atualizar as prévias.';
    updateSourcePreview();
  }
  function updateSourcePreview() {
    const option = $('source').selectedOptions[0];
    const thumbnail = option?.dataset.thumbnail;
    const image = $('source-preview-image');
    image.hidden = !thumbnail;
    if (thumbnail) image.src = thumbnail; else image.removeAttribute('src');
    $('source-preview-note').textContent = !option?.value ? 'Selecione uma tela ou janela para ver a prévia.' :
      thumbnail ? option.textContent : 'Prévia indisponível. Janelas minimizadas ou conteúdo protegido podem não aparecer.';
    const width = Number(option?.dataset.width), height = Number(option?.dataset.height);
    const maximum = captureSize(width, height);
    const previous = desiredResolution;
    $('resolution').replaceChildren(new Option(width && height ? `Máxima da fonte (${maximum.width} × ${maximum.height})` : 'Máxima da fonte (até Full HD)', 'auto'),
      ...resolutions.filter(value => value <= maximum.height).map(value => new Option(`${value}p${value === 1080 ? ' · Full HD' : ''}`, String(value))));
    $('resolution').value = [...$('resolution').options].some(item => item.value === previous) ? previous : 'auto';
    $('resolution-note').textContent = width && height ? `Fonte: ${width} × ${height}. As opções respeitam seu tamanho e o limite Full HD.` :
      'O tamanho real da janela será conferido ao iniciar. Janelas menores não serão ampliadas.';
    document.querySelectorAll('.source-tile').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sourceId === $('source').value)));
    $('start-stream').disabled = opening || !$('source').value || document.body.dataset.busy === 'true';
    $('share-selection').textContent = option?.value ? option.textContent : 'Escolha uma tela ou janela para começar.';
  }
  $('source').addEventListener('change', updateSourcePreview);
  $('resolution').addEventListener('change', () => { desiredResolution = $('resolution').value; });
  new MutationObserver(renderSources).observe($('source'), { childList: true });
  function values() {
    return { audioMode: $('audio-mode').value, applications: [...$('audio-app').selectedOptions].map(option => option.value),
      manual: $('audio-manual').value, bitrate: $('preset').value, resolution: $('resolution').value, fps: $('capture-fps').value };
  }
  function restore() {
    desiredResolution = preferences.resolution || 'auto';
    $('audio-mode').value = preferences.audioMode; $('preset').value = preferences.bitrate;
    $('resolution').value = preferences.resolution || 'auto'; $('capture-fps').value = preferences.fps || '60';
    updateSourcePreview();
    $('audio-manual').value = preferences.manual;
    // Mantém apps salvos que estejam fechados, inclusive exclusões preventivas.
    for (const name of preferences.applications) if (![...$('audio-app').options].some(option => option.value === name)) {
      $('audio-app').add(new Option(`${name} (indisponível agora)`, name));
    }
    for (const option of $('audio-app').options) option.selected = preferences.applications.includes(option.value);
    updateAudioChoice(); renderAudio();
  }
  function render() {
    $('share-back').hidden = true; $('share-next').hidden = true;
    $('share-confirm').hidden = false; $('share-error').textContent = '';
    $('share-review').replaceChildren();
    for (const [label, value] of [['Imagem', $('source').selectedOptions[0]?.textContent || 'Nenhuma'],
      ['Áudio', $('audio-mode').selectedOptions[0].textContent],
      ['Resolução', $('resolution').selectedOptions[0]?.textContent || 'Máxima da fonte'],
      ['Fluidez', `${$('capture-fps').value} fps`], ['Limite de envio', $('preset').selectedOptions[0].textContent]]) {
      const term = document.createElement('dt'), detail = document.createElement('dd');
      term.textContent = label; detail.textContent = value; $('share-review').append(term, detail);
    }
  }
  function valid() {
    if (!$('source').value) { $('share-error').textContent = 'Escolha uma tela ou janela para continuar.'; return false; }
    if ($('audio-mode').value === 'on' && $('source').value.startsWith('screen:')) {
      const names = [...$('audio-app').selectedOptions].map(option => option.value).concat($('audio-manual').value.split(/[;,\n]/).map(value => value.trim()).filter(Boolean));
      if (new Set(names.map(name => name.toLowerCase())).size > 16 || names.some(name => !/^[^\\/\x00-\x1f]{1,120}\.exe$/i.test(name))) {
        $('share-error').textContent = 'Use até 16 exclusões e nomes de aplicativos terminados em .exe, sem caminhos.'; return false;
      }
    }
    return true;
  }
  const cancel = () => { dialog.close(); restore(); };
  for (const id of ['source', 'audio-mode', 'audio-app', 'audio-manual']) $(id).addEventListener('change', () => { $('share-error').textContent = ''; });
  $('share-cancel').onclick = cancel;
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (document.body.dataset.busy !== 'true') cancel(); });
  return {
    valid,
    async load() {
      try { if (api.sharePreferences) preferences = await api.sharePreferences(); } catch { /* Defaults keep capture available. */ }
      if (!['on', 'none'].includes(preferences.audioMode)) preferences = { ...preferences,
        applications: ['Discord.exe', ...(preferences.audioMode === 'exclude' ? preferences.applications : [])],
        manual: preferences.audioMode === 'exclude' ? preferences.manual : '', audioMode: 'on' };
      restore(); $('share-saved').textContent = 'Áudio e qualidade são lembrados neste PC.';
    },
    async open() {
      if (opening || !canOpen()) return;
      opening = true; $('share-advanced').open = false; render(); dialog.showModal(); $('start-stream').disabled = true;
      try {
        await refresh(); restore();
        for (const option of [...$('source').options]) if (!option.value) option.remove();
        const placeholder = new Option('Selecione uma tela ou janela', '', true, true);
        placeholder.disabled = true; $('source').prepend(placeholder); $('source').value = '';
        updateAudioChoice(); renderSources(); render(); $('source-gallery').querySelector('button')?.focus();
      } catch { $('share-error').textContent = 'Não foi possível listar as telas. Tente Atualizar.'; }
      finally { opening = false; document.querySelectorAll('.source-tile').forEach(button => { button.disabled = false; }); updateSourcePreview(); }
    },
    async complete() {
      preferences = values(); dialog.close();
      try { if (api.saveSharePreferences) await api.saveSharePreferences(preferences); }
      catch { $('share-saved').textContent = 'Transmissão ativa. Não foi possível salvar as preferências neste PC.'; }
    },
    error(message) { if (dialog.open) $('share-error').textContent = message; },
    close() { if (dialog.open) cancel(); }
  };
}

const { desktopCapturer, screen } = require('electron');

function setupCaptureHandlers(session, getWindow, origin) {
  let selected, audioSource;
  session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === getWindow()?.webContents && contents.getURL().startsWith(origin + '/') && ['media', 'display-capture'].includes(permission));
  });
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    let response = null; // null é a negativa explícita da API; rejeita getDisplayMedia.
    try {
      // securityOrigin pode incluir uma barra final, conforme a versão do Chromium.
      const trustedOrigin = new URL(request.securityOrigin).origin === origin;
      if (trustedOrigin && request.frame === getWindow()?.webContents.mainFrame && selected) {
        // Consome a seleção antes do await: outra solicitação não pode reutilizá-la.
        const sourceId = selected;
        selected = undefined;
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const source = sources.find(s => s.id === sourceId);
        // Revalida a janela após a operação assíncrona.
        if (source && request.frame === getWindow()?.webContents.mainFrame) {
          response = { video: source }; // Never capture the mixed system output.
        }
      }
    } catch (error) {
      console.error('Falha ao selecionar a fonte de captura:', error);
    }
    // Callback obrigatório da API moderna, de uso único. Nunca repetir no catch:
    // o Electron pode lançar quando a solicitação foi cancelada ou invalidada.
    try { callback(response); }
    catch (error) { console.error('Falha ao responder à solicitação de captura:', error); }
  });
  return {
    async sources() {
      const displays = screen?.getAllDisplays() || [];
      return (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 640, height: 360 } }))
        .map(s => {
          const display = s.id.startsWith('screen:') && displays.find(item => String(item.id) === s.display_id);
          return { id: s.id, name: s.name, thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
            width: display ? Math.round(display.size.width * display.scaleFactor) : null,
            height: display ? Math.round(display.size.height * display.scaleFactor) : null };
        });
    },
    select(id, audioId) {
      if (typeof id !== 'string' || id.length > 256 || (audioId !== undefined && typeof audioId !== 'object' && (typeof audioId !== 'string' || audioId.length > 256))) throw new Error('Fonte inválida');
      selected = id;
      audioSource = audioId && typeof audioId === 'object' ? audioId : id.startsWith('window:') ? id : audioId;
    },
    audioSource() { const value = audioSource; audioSource = undefined; return value; }
  };
}
module.exports = { setupCaptureHandlers };

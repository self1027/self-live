const { randomUUID } = require('node:crypto');

const stages = new Set(['Parando transmissão', 'Fechando conexões WebRTC', 'Parando tracks de captura', 'Enviando goodbye', 'Fechando WebSocket']);

function createShutdown({ app, ipcMain, getWindow, getServers, getTray, closePorts = async () => {}, onStart = () => {}, timeoutMs = 3000 }) {
  let pending;
  const recordedStages = new Set();
  function logStage(stage) {
    if (recordedStages.has(stage)) return;
    recordedStages.add(stage); console.log(`[Shutdown] ${stage}`);
  }
  ipcMain.on('shutdown-log', (event, stage, errorName) => {
    const contents = getWindow()?.webContents;
    if (event.sender !== contents || event.senderFrame !== contents?.mainFrame || !stages.has(stage)) return;
    // Só registra rótulos conhecidos e nome de erro, nunca payloads de mídia.
    if (errorName) console.warn(`[Shutdown] ${stage}: ${/^[A-Za-z]+Error$|^Error$/.test(errorName) ? errorName : 'Error'}`);
    else logStage(stage);
  });

  function stopRenderer() {
    const contents = getWindow()?.webContents;
    if (!contents || contents.isDestroyed()) return Promise.resolve();
    const token = randomUUID();
    return new Promise((resolve, reject) => {
      const ack = (event, responseToken) => {
        if (event.sender === contents && event.senderFrame === contents.mainFrame && responseToken === token) finish();
      };
      const destroyed = () => finish(new Error('Renderer encerrado antes da confirmação'));
      const timer = setTimeout(() => finish(new Error('Timeout aguardando renderer')), Math.min(2000, timeoutMs));
      function finish(error) {
        clearTimeout(timer); ipcMain.off('shutdown-complete', ack); contents.off('destroyed', destroyed);
        if (error) reject(error); else resolve();
      }
      ipcMain.on('shutdown-complete', ack); contents.once('destroyed', destroyed);
      try { contents.send('shutdown-request', token); }
      catch (error) { finish(error); }
    });
  }

  // Chamadas repetidas (tray/before-quit) compartilham a mesma operação.
  return function shutdown() {
    if (pending) return pending;
    onStart();
    pending = new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true; clearTimeout(deadline);
        try { getTray()?.tray.destroy(); } catch (error) { console.warn('[Shutdown] Falha ao remover tray:', error.name); }
        console.log('[Shutdown] Encerrando app');
        resolve(); app.exit(0);
      };
      const deadline = setTimeout(() => {
        console.warn(`[Shutdown] Limite de ${timeoutMs / 1000} segundos atingido; forçando saída.`); finish();
      }, timeoutMs);
      (async () => {
        logStage('Parando transmissão');
        try { await stopRenderer(); } catch (error) { console.warn('[Shutdown] Renderer:', error.message); }
        console.log('[Shutdown] Removendo mapeamentos de portas');
        try { await closePorts(); } catch { console.warn('[Shutdown] Falha ao remover mapeamentos; continuando saída.'); }
        console.log('[Shutdown] Fechando servidor WSS local');
        try { await getServers()?.close(); } catch (error) { console.warn('[Shutdown] Servidores:', error.name); }
      })().catch(error => console.warn('[Shutdown] Falha inesperada:', error.name)).finally(finish);
    });
    return pending;
  };
}

module.exports = { createShutdown };

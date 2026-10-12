// Limpeza usada pelo IPC de saída. Cada recurso falha de forma independente;
// logs contêm apenas etapas e nomes de erro, sem senha/SDP/candidatos ICE.
export async function shutdownMedia({ media, loopback, stream, socket, nodeId, log = () => {} }) {
  async function attempt(stage, operation) {
    try { await operation(); }
    catch (error) { log(stage, error.name || 'Error'); }
  }
  async function step(stage, operation) { log(stage); await attempt(stage, operation); }
  const captures = new Set([stream, media?.stream].filter(Boolean));
  const receiver = media?.watching?.pc;
  await step('Parando transmissão', () => media?.stopStreaming({ reason: 'peer_shutdown' }));
  await step('Fechando conexões WebRTC', async () => {
    await attempt('Fechando conexões WebRTC', () => media?.stopWatching());
    if (receiver) await attempt('Fechando conexões WebRTC', () => receiver.close());
    // Fallback: limpa conexões restantes mesmo se stopStreaming falhou.
    for (const connection of [...(media?.outgoing.values() || [])]) {
      await attempt('Fechando conexões WebRTC', () => media.closeConnection(connection));
    }
    for (const pc of [loopback?.sender, loopback?.receiver].filter(Boolean)) {
      await attempt('Fechando conexões WebRTC', () => pc.close());
    }
    await attempt('Fechando conexões WebRTC', () => loopback?.stop());
  });
  await step('Parando tracks de captura', async () => {
    for (const capture of captures) {
      await attempt('Parando tracks de captura', async () => {
        for (const track of capture.getTracks()) await attempt('Parando tracks de captura', () => track.stop());
      });
    }
  });
  await step('Enviando goodbye', () => {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'goodbye', node_id: nodeId }));
  });
  await step('Fechando WebSocket', () => {
    if (!socket || socket.readyState === 3) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Timeout ao fechar WebSocket')), 1200);
      const closed = () => finish();
      function finish(error) {
        clearTimeout(timer); socket.removeEventListener('close', closed);
        if (error) reject(error); else resolve();
      }
      socket.addEventListener('close', closed, { once: true });
      // send() e close() mantêm a ordem dos frames: goodbye precede o close.
      try { socket.close(1000, 'Saindo'); } catch (error) { finish(error); }
    });
  });
}

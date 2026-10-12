// Uma entrada de sala tenta cada endereço uma vez; não é uma política de reconexão.
export function maskedEndpoint(url) {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) host = `${host.split('.').slice(0, 2).join('.')}.x.x`;
    else if (host.includes(':')) host = `[${host.split(':').slice(0, 2).filter(Boolean).join(':') || 'IPv6'}:…]`;
    else if (!/^[a-z0-9.-]{1,253}$/i.test(host)) host = 'host';
    return `${host}:${parsed.port || '443'}`;
  } catch { return 'endereço inválido'; }
}

function abortError() { const error = new Error('Entrada na sala cancelada.'); error.name = 'AbortError'; return error; }

export async function connectSignaling({ endpoints, makeSocket = url => new WebSocket(url), timeoutMs = 5000,
  signal, hello, sendHello, onAttemptStatus = () => {}, log = text => console.info(`[Sinalização] ${text}`) }) {
  const ordered = [...(endpoints || [])].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  for (const endpoint of ordered) {
    if (signal?.aborted) throw abortError();
    let url;
    try {
      url = new URL(endpoint.url);
      if (url.protocol !== 'wss:' || url.username || url.password) throw new Error();
    } catch { continue; }
    const type = /^[a-z0-9-]{1,32}$/i.test(endpoint.type || '') ? endpoint.type : 'desconhecido';
    const priority = Number.isFinite(endpoint.priority) ? endpoint.priority : 99;
    log(`Tentando endpoint ${priority} (${type}): ${maskedEndpoint(url.href)}`);
    onAttemptStatus(`Tentando endereço ${priority} (${type})…`);
    const started = Date.now();
    try {
      const connection = await new Promise((resolve, reject) => {
        let socket, settled = false, ready = false, timer;
        const pending = [];
        const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        const finish = error => {
          if (settled) return;
          settled = true; clean();
          if (socket) {
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            try { socket.close(1000, 'entry_cancelled'); } catch { /* Socket já encerrado. */ }
          }
          reject(error);
        };
        const cancel = () => finish(abortError());
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) { cancel(); return; }
        timer = setTimeout(() => finish(new Error('timeout de conexão')), timeoutMs);
        try { socket = makeSocket(url.href, endpoint); }
        catch { finish(new Error('falha ao abrir WSS')); return; }
        socket.onopen = () => {
          try { if (sendHello) sendHello(socket, endpoint); else socket.send(JSON.stringify(hello)); }
          catch { finish(new Error('falha no handshake')); }
        };
        socket.onmessage = event => {
          if (ready) { pending.push({ kind: 'message', event }); return; }
          let message;
          try { message = JSON.parse(event.data); } catch { finish(new Error('handshake inválido')); return; }
          if (message.type === 'error' || message.type === 'register_rejected') {
            // Uma senha rejeitada não deve circular por todos os endereços do mesmo peer.
            const error = new Error('Sala ou senha rejeitada pelo host.'); error.name = 'AuthenticationError'; finish(error); return;
          }
          if (message.type !== 'welcome') return;
          ready = true; settled = true; clean();
          resolve({ socket, welcome: message, endpoint,
            // Eventos após welcome ficam guardados até o dashboard instalar os handlers.
            bind({ onMessage, onClose, onError }) {
              socket.onmessage = onMessage; socket.onclose = onClose; socket.onerror = onError;
              for (const entry of pending.splice(0)) ({ message: onMessage, close: onClose, error: onError })[entry.kind]?.(entry.event);
            } });
        };
        socket.onerror = event => { if (ready) pending.push({ kind: 'error', event }); else finish(new Error('falha de transporte ou certificado')); };
        socket.onclose = event => {
          if (ready) { pending.push({ kind: 'close', event }); return; }
          const rejected = event.code === 1008 || event.code === 4001;
          const error = new Error(rejected ? 'Sala ou senha rejeitada pelo host.' : 'WSS encerrado durante o handshake');
          if (rejected) error.name = 'AuthenticationError';
          finish(error);
        };
      });
      log(`Endpoint ${type} OK — WSS conectado`);
      return connection;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      log(`Endpoint ${type} falhou em ${((Date.now() - started) / 1000).toFixed(1)}s: ${error.message}`);
      if (error.name === 'AuthenticationError') throw error;
    }
  }
  const error = new Error('Nenhum endereço da sala respondeu. Abra Como resolver em Conectividade para verificar a rede e o WSS.');
  error.name = 'ConnectivityError'; throw error;
}

// Fachada WebSocket para o transporte Node com pin TLS e cifragem fim a fim.
export function relaySocket(api, endpoint, onStatus = () => {}) {
  let started = false, chain = Promise.resolve();
  const socket = { readyState: 0, send(raw) {
    if (socket.readyState !== 1) throw new Error('Relay fechado');
    chain = chain.then(() => {
      if (!started) { started = true; return api.relayOpen(endpoint, JSON.parse(raw)); }
      return api.relaySend(raw);
    }).catch(() => socket.onclose?.({ code: 1006, reason: 'Falha ao abrir relay' }));
  }, close(code = 1000, reason = '') {
    if (socket.readyState === 3) return;
    socket.readyState = 3; unsubscribe();
    // Esperar open IPC evita um relay órfão após timeout de entrada.
    chain.then(() => api.relayClose()).catch(() => {});
    socket.onclose?.({ code, reason });
  } };
  const unsubscribe = api.onRelay(event => {
    if (socket.readyState === 3) return;
    if (event.kind === 'message') socket.onmessage?.({ data: event.value });
    if (event.kind === 'status') onStatus(event.value);
    if (event.kind === 'close') {
      const callback = socket.onclose;
      socket.readyState = 3; unsubscribe();
      api.relayClose().catch(() => {}); callback?.(event.value);
    }
  });
  queueMicrotask(() => { if (socket.readyState === 0) { socket.readyState = 1; socket.onopen?.(); } });
  return socket;
}

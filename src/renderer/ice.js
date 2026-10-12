// O preload devolve apenas credenciais efêmeras. O segredo permanece no main.
export async function buildIceServers(nodeId, api = globalThis.selfLive) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turn = await api?.generateTurnCredentials(nodeId);
  if (turn) servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  return servers;
}

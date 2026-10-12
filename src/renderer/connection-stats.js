const directTypes = new Set(['host', 'srflx', 'prflx']);
const candidateTypes = new Set([...directTypes, 'relay']);

function typeOf(candidate, fallback) {
  const type = candidate?.candidateType ?? fallback;
  return candidateTypes.has(type) ? type : null;
}

function familyOf(candidate) {
  const family = candidate?.family ?? candidate?.addressFamily;
  if (family === 6 || String(family).toLowerCase() === 'ipv6') return 'IPv6';
  if (family === 4 || String(family).toLowerCase() === 'ipv4') return 'IPv4';
  const address = candidate?.address ?? candidate?.ip;
  if (typeof address !== 'string') return null;
  if (address.includes(':')) return 'IPv6';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return 'IPv4';
  // mDNS pode ocultar o IP de candidatos host; não deduzimos sua família.
  return null;
}

/**
 * Resume um RTCStatsReport sem propagar endereços, URLs ou credenciais.
 * Chromium usa transport.selectedCandidatePairId; selected é legado.
 * Referência: https://www.w3.org/TR/webrtc-stats/#dom-rtctransportstats-selectedcandidatepairid
 */
export function getConnectionDiagnostics(stats) {
  const values = stats ? Array.from(stats.values()) : [];
  const byId = new Map(values.map(value => [value.id, value]));
  const pairs = values.filter(value => value.type === 'candidate-pair');
  const succeeded = pair => pair?.type === 'candidate-pair' && pair.state === 'succeeded';
  let pair;

  for (const transport of values) {
    if (transport.type !== 'transport') continue;
    const selected = byId.get(transport.selectedCandidatePairId);
    if (succeeded(selected)) { pair = selected; break; }
  }
  pair ??= pairs.find(value => succeeded(value) && value.selected === true);
  pair ??= pairs.find(value => succeeded(value) && value.nominated === true);

  const local = byId.get(pair?.localCandidateId);
  const remote = byId.get(pair?.remoteCandidateId);
  const localType = typeOf(local, pair?.localCandidateType);
  const remoteType = typeOf(remote, pair?.remoteCandidateType);
  const mode = localType === 'relay' || remoteType === 'relay' ? 'relay'
    : directTypes.has(localType) && directTypes.has(remoteType) ? 'direct' : 'unknown';
  const localFamily = familyOf(local), remoteFamily = familyOf(remote);
  const family = localFamily === 'IPv6' || remoteFamily === 'IPv6' ? 'IPv6'
    : localFamily === 'IPv4' || remoteFamily === 'IPv4' ? 'IPv4' : null;

  // Ausente/null não equivale a RTT zero. A especificação expressa RTT em segundos.
  const seconds = pair?.currentRoundTripTime;
  const rttMs = typeof seconds === 'number' && seconds >= 0 && Number.isFinite(seconds * 1000)
    ? seconds * 1000 : null;
  const quality = rttMs === null ? 'unknown' : rttMs < 100 ? 'good' : rttMs < 250 ? 'fair' : 'poor';
  const result = { mode, family, localType, remoteType, rttMs, quality };

  if (mode === 'relay') {
    const hasDirectSuccess = pairs.some(value => succeeded(value)
      && directTypes.has(typeOf(byId.get(value.localCandidateId), value.localCandidateType))
      && directTypes.has(typeOf(byId.get(value.remoteCandidateId), value.remoteCandidateType)));
    // Isto descreve somente o relatório observado; não atribui a causa a CGNAT/firewall.
    if (!hasDirectSuccess) result.relayReason = 'Nenhum par direto bem-sucedido observado nas estatísticas';
  }
  return result;
}

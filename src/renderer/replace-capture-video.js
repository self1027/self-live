// Reuse the MediaStream and RTP senders so viewers and isolated audio survive.
export async function replaceCaptureVideo({ stream, replacement, getSenders, isCurrent = () => true }) {
  const next = replacement.getVideoTracks()[0], previous = stream.getVideoTracks()[0], swaps = [];
  let committed = false;
  try {
    if (!next || !isCurrent()) throw new Error('Recuperação de captura cancelada.');
    for (let pass=0; pass<2; pass++) for (const sender of getSenders()) {
      if (swaps.some(swap=>swap.sender === sender)) continue;
      if (!isCurrent()) throw new Error('Recuperação de captura cancelada.');
      const old = sender.track; await sender.replaceTrack(next); swaps.push({sender,old});
    }
    if (!isCurrent()) throw new Error('Recuperação de captura cancelada.');
    if (previous) stream.removeTrack(previous); stream.addTrack(next); committed = true;
    previous?.stop();
    return next;
  } finally {
    replacement.getAudioTracks().forEach(track=>track.stop());
    if (!committed) {
      await Promise.allSettled(swaps.map(({sender,old})=>sender.replaceTrack(old)));
      replacement.getVideoTracks().forEach(track=>track.stop());
    }
  }
}

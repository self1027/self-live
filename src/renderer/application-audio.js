export async function attachApplicationAudio(stream, api) {
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  let unsubscribe, unsubscribeEnded, node, closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true; unsubscribe?.(); unsubscribeEnded?.(); node?.disconnect();
    context.close().catch(() => {}); api.applicationAudioStop().catch(() => {});
  };
  try {
    await context.audioWorklet.addModule('/audio-worklet.js');
    node = new AudioWorkletNode(context, 'application-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination(); node.connect(destination);
    unsubscribe = api.onApplicationAudio(bytes => {
      if (closed) return;
      const view = new DataView(new Uint8Array(bytes).buffer);
      const samples = new Float32Array(Math.floor(view.byteLength / 2));
      for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
      node.port.postMessage(samples, [samples.buffer]);
    });
    unsubscribeEnded = api.onApplicationAudioEnded(state => {
      stream.audioNote = state?.reason || 'Áudio encerrado.';
      stream.dispatchEvent(new Event('application-audio-change'));
      destination.stream.getTracks().forEach(track => track.stop()); cleanup();
    });
    const result = await api.applicationAudioStart();
    stream.audioNote = result.reason;
    if (!result.enabled) { cleanup(); return; }
    await context.resume();
    destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    stream.stopApplicationAudio = cleanup;
    stream.getVideoTracks()[0].addEventListener('ended', cleanup, { once: true });
  } catch (error) { cleanup(); throw error; }
}

class ApplicationAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(48000); // At most 500 ms of stereo audio.
    this.read = 0; this.write = 0; this.count = 0;
    this.port.onmessage = event => {
      const samples = event.data;
      if (!(samples instanceof Float32Array)) return;
      // Prefer fresh audio to a growing latency after renderer stalls.
      if (this.count + samples.length > 9600) { this.read = this.write; this.count = 0; }
      for (const sample of samples) {
        this.buffer[this.write] = sample;
        this.write = (this.write + 1) % this.buffer.length;
        this.count = Math.min(this.count + 1, this.buffer.length);
      }
    };
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    for (let frame = 0; frame < left.length; frame++) {
      if (this.count >= 2) {
        left[frame] = this.buffer[this.read]; this.read = (this.read + 1) % this.buffer.length;
        right[frame] = this.buffer[this.read]; this.read = (this.read + 1) % this.buffer.length;
        this.count -= 2;
      } else { left[frame] = 0; right[frame] = 0; }
    }
    return true;
  }
}
registerProcessor('application-audio', ApplicationAudioProcessor);

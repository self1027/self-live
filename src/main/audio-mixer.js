// Packet timestamps use the Windows shared QPC clock (100 ns units).
class AudioMixer {
  constructor(send) { this.send = send; this.sources = new Map(); this.cursor = null; }
  add(id) { this.sources.set(id, []); }
  remove(id) { this.sources.delete(id); }
  push(id, stamp, pcm) {
    const queue = this.sources.get(id); if (!queue || !Number.isFinite(stamp)) return;
    const start = Math.round(stamp * 48000 / 10000000);
    queue.push({ start, pcm });
    if (queue.length > 50) queue.splice(0, queue.length - 50);
    if (this.cursor === null) this.cursor = start;
  }
  tick() {
    if (this.cursor === null) return;
    const newest = Math.max(...[...this.sources.values()].flatMap(queue => queue.map(p => p.start + p.pcm.length / 4)), this.cursor);
    if (newest - this.cursor > 9600) this.cursor = newest - 2880;
    const output = Buffer.alloc(3840), sums = new Int32Array(1920);
    for (const queue of this.sources.values()) {
      for (const packet of queue) {
        const first = Math.max(this.cursor, packet.start), last = Math.min(this.cursor + 960, packet.start + packet.pcm.length / 4);
        for (let frame = first; frame < last; frame++) for (let channel = 0; channel < 2; channel++) {
          sums[(frame - this.cursor) * 2 + channel] += packet.pcm.readInt16LE((frame - packet.start) * 4 + channel * 2);
        }
      }
      while (queue.length && queue[0].start + queue[0].pcm.length / 4 <= this.cursor + 960) queue.shift();
    }
    for (let i = 0; i < sums.length; i++) output.writeInt16LE(Math.max(-32768, Math.min(32767, sums[i])), i * 2);
    this.cursor += 960; this.send(new Uint8Array(output));
  }
}
module.exports = { AudioMixer };

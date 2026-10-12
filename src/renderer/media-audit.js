// Only numerical media statistics and fixed enums cross the audit IPC.
export function createMediaAuditSampler() {
  let previous = new WeakMap(), numbers = new WeakMap(), next = 0;
  return {
    reset() { previous = new WeakMap(); numbers = new WeakMap(); next = 0; },
    sample(pc, report) {
      if (!numbers.has(pc)) numbers.set(pc, ++next);
      const before = previous.get(pc) || new Map(), after = new Map();
      const rows = [];
      for (const stat of report.values()) {
        if (!['outbound-rtp', 'inbound-rtp', 'media-source', 'remote-inbound-rtp'].includes(stat.type) ||
          (stat.kind || stat.mediaType) !== 'video') continue;
        const row = { type: stat.type };
        const old = before.get(stat.id), seconds = old ? (stat.timestamp - old.timestamp) / 1000 : 0;
        for (const key of ['frames','framesPerSecond','width','height','frameWidth','frameHeight','framesEncoded','framesSent','framesDecoded','framesDropped','freezeCount','totalFreezesDuration','packetsLost','fractionLost','jitter','roundTripTime','totalEncodeTime','totalDecodeTime','qpSum']) {
          if (Number.isFinite(stat[key]) && stat[key] >= 0) row[key] = stat[key];
        }
        const delta = key => old && Number.isFinite(stat[key]) && Number.isFinite(old[key]) && stat[key] >= old[key] ? stat[key] - old[key] : null;
        if (seconds > 0) {
          for (const [key, label, factor] of [['bytesSent','sendKbps',.008],['bytesReceived','receiveKbps',.008],['framesEncoded','encodedFps',1],['framesSent','sentFps',1],['framesDecoded','decodedFps',1]]) {
            const change = delta(key); if (change !== null) row[label] = change / seconds * factor;
          }
          for (const [time, frames, label] of [['totalEncodeTime','framesEncoded','encodeMs'],['totalDecodeTime','framesDecoded','decodeMs'],['totalPacketSendDelay','packetsSent','sendDelayMs']]) {
            const duration = delta(time), count = delta(frames);
            if (duration !== null && count > 0) row[label] = duration / count * 1000;
          }
        }
        if (['none','cpu','bandwidth','other'].includes(stat.qualityLimitationReason)) row.limitation = stat.qualityLimitationReason;
        for (const [key,label] of [['cpu','limitationCpuSeconds'],['bandwidth','limitationBandwidthSeconds']]) {
          if (Number.isFinite(stat.qualityLimitationDurations?.[key])) row[label] = stat.qualityLimitationDurations[key];
        }
        if (typeof stat.powerEfficientEncoder === 'boolean') row.hardwareEfficient = stat.powerEfficientEncoder;
        // Map implementation names to a fixed category, never store arbitrary strings.
        if (typeof stat.encoderImplementation === 'string') row.encoder = /openh264|libvpx|software/i.test(stat.encoderImplementation) ? 'software' :
          /hardware|external|mediafoundation|videotoolbox|nvenc|amf|quicksync/i.test(stat.encoderImplementation) ? 'hardware-or-external' : 'unknown';
        rows.push(row); after.set(stat.id, stat);
      }
      previous.set(pc, after);
      return { viewer: numbers.get(pc), rows };
    }
  };
}

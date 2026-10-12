export const resolutions = [144, 240, 360, 480, 720, 900, 1080];
export const captureRates = [15, 20, 30, 45, 60];
export const captureModes = ['auto', '1920x1080', '1280x720', '960x540', '854x480'];
export function captureSize(width, height, resolution = 'auto') {
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 1920, h = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : 1080;
  const explicit = /^(\d+)x(\d+)$/.exec(resolution);
  const targetWidth = explicit ? Math.min(1920, Number(explicit[1])) : 1920;
  const limit = explicit ? Math.min(1080, Number(explicit[2])) : resolution === 'auto' ? 1080 : Math.min(1080, Number(resolution) || 1080);
  const scale = Math.min(1, targetWidth / w, 1080 / h, limit / h);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}
export function assertFhd(track) {
  const settings = track.getSettings();
  if (!Number.isFinite(settings.width) || !Number.isFinite(settings.height) || settings.width < 1 || settings.height < 1 || settings.width > 1920 || settings.height > 1080) {
    throw new Error('Captura encerrada: resolução inválida ou acima do limite 1920x1080.');
  }
  return settings;
}
export async function constrainCapture(track, { resolution = 'auto', fps = 60, original } = {}) {
  if (!captureModes.includes(resolution) && !resolutions.includes(Number(resolution))) throw new Error('Qualidade de captura inválida.');
  const size = captureSize(original?.width || track.getSettings().width, original?.height || track.getSettings().height, resolution);
  if (!captureRates.includes(Number(fps))) throw new Error('FPS de captura inválido.');
  await track.applyConstraints({ width: { ideal: size.width, max: size.width }, height: { ideal: size.height, max: size.height },
    frameRate: { ideal: Number(fps), max: Number(fps) }, resizeMode: 'crop-and-scale' });
  return assertFhd(track);
}

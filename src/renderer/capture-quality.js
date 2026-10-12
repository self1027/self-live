export const resolutions = [144, 240, 360, 480, 720, 900, 1080];
export function captureSize(width, height, resolution = 'auto') {
  const w = Number(width) || 1920, h = Number(height) || 1080;
  const limit = resolution === 'auto' ? 1080 : Number(resolution);
  const scale = Math.min(1, 1920 / w, 1080 / h, limit / h);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

const fs = require('node:fs');
const path = require('node:path');
const defaults = { loggingEnabled: false, gpuPriorityEnabled: false, adaptiveQuality: true, previewHidden: false, resolution: 'auto', frameRate: 60 };
function validate(value) {
  const result = { ...defaults };
  for (const key of ['loggingEnabled', 'gpuPriorityEnabled', 'adaptiveQuality', 'previewHidden']) {
    if (value?.[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Configuração de diagnóstico inválida.');
    if (value?.[key] !== undefined) result[key] = value[key];
  }
  if (value?.resolution !== undefined) {
    // Preserve quality presets selected in the existing share modal.
    if (!['auto','1920x1080','1280x720','960x540','854x480','144','240','360','480','720','900','1080'].includes(value.resolution)) throw new Error('Resolução inválida.');
    result.resolution = value.resolution;
  }
  if (value?.frameRate !== undefined) {
    if (![15,20,30,45,60].includes(value.frameRate)) throw new Error('FPS inválido.');
    result.frameRate = value.frameRate;
  }
  return result;
}
function createDiagnosticSettings(directory) {
  const file = path.join(directory, 'config', 'local.json');
  let state;
  try { state = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { state = { ...defaults }; }
  return {
    load: () => ({ ...state }),
    save(value) {
      const next = validate({ ...state, ...value });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      state = next; return { ...state };
    }
  };
}
module.exports = { createDiagnosticSettings, validate };

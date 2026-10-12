const fs = require('node:fs');
const path = require('node:path');
const defaults = () => ({ audioMode: 'on', applications: ['Discord.exe'], manual: '', bitrate: '10000000', resolution: 'auto', fps: '60' });
function validate(value) {
  const resolution = value?.resolution ?? 'auto', fps = value?.fps ?? '60';
  if (!['auto', '144', '240', '360', '480', '720', '900', '1080'].includes(resolution) || !['15', '30', '60'].includes(fps)) throw new Error('Qualidade de captura inválida.');
  if (!value || !['on', 'window', 'include', 'exclude', 'none'].includes(value.audioMode) ||
      !['6000000', '10000000', '15000000'].includes(value.bitrate) ||
      !Array.isArray(value.applications) || value.applications.length > 16 ||
      value.applications.some(name => typeof name !== 'string' || !/^[^\\/\x00-\x1f]{1,120}\.exe$/i.test(name)) ||
      typeof value.manual !== 'string' || value.manual.length > 2048) throw new Error('Preferências de compartilhamento inválidas.');
  // Older inclusion lists are not exclusion lists. Preserve explicit exclusions only.
  const legacy = !['on', 'none'].includes(value.audioMode);
  const applications = legacy ? ['Discord.exe', ...(value.audioMode === 'exclude' ? value.applications : [])] : value.applications;
  return { audioMode: value.audioMode === 'none' ? 'none' : 'on', applications: [...new Set(applications)], manual: value.audioMode === 'include' || value.audioMode === 'window' ? '' : value.manual, bitrate: value.bitrate, resolution, fps };
}
function createSharePreferences(directory) {
  const file = path.join(directory, 'share-preferences.json');
  return {
    load() { try { return validate(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return defaults(); } },
    save(value) {
      const preferences = validate(value);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(preferences, null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      return preferences;
    }
  };
}
module.exports = { createSharePreferences, validate };

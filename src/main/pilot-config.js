const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const DEFAULTS = Object.freeze({ name: 'Meu PC', relayUrl: 'wss://relay.murilod.dev:8443', upnp: 'off' });
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuração inválida.');
  const result = {};
  for (const key of ['name', 'room', 'relayUrl', 'upnp']) {
    if (typeof value[key] !== 'string' || value[key].length > 256) throw new Error('Configuração inválida.');
    result[key] = value[key];
  }
  if (!result.name.trim() || !result.room.trim() || !['on', 'off', 'auto'].includes(result.upnp)) throw new Error('Nome, sala ou preferência de rede inválidos.');
  if (result.relayUrl) {
    const url = new URL(result.relayUrl);
    if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use uma URL WSS válida.');
  }
  return result;
}
function createPilotConfig(directory, storage) {
  const file = path.join(directory, 'pilot-config.json');
  const encrypt = password => {
    if (!storage.isEncryptionAvailable()) throw new Error('Proteção local de senha indisponível.');
    return storage.encryptString(password).toString('base64');
  };
  const write = value => {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  let state;
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = { ...validate(raw), nameChosen: raw.nameChosen === true || (raw.nameChosen === undefined && raw.name !== DEFAULTS.name), passwordEncrypted: raw.passwordEncrypted };
    if (typeof state.passwordEncrypted !== 'string' || !state.passwordEncrypted.length) throw new Error('Senha local inválida.');
  } else {
    state = { ...DEFAULTS, nameChosen: false, room: `piloto-${randomBytes(8).toString('hex')}`, passwordEncrypted: encrypt(randomBytes(24).toString('base64url')) };
    write(state);
  }
  const password = () => storage.decryptString(Buffer.from(state.passwordEncrypted, 'base64'));
  password(); // Falha explicitamente se o perfil Windows não puder decifrar a senha.
  return {
    snapshot: () => ({ ...validate(state), nameChosen: state.nameChosen, file }), password,
    saveName(name) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Informe um nome com 1 a 128 caracteres.');
      const updated = { ...state, name: name.trim(), nameChosen: true };
      write(updated); state = updated; return state.name;
    },
    save(value) {
      const next = validate(value);
      if (value.password !== undefined && (typeof value.password !== 'string' || value.password.length < 12 || value.password.length > 1024)) throw new Error('Use uma senha com 12 a 1024 caracteres.');
      const updated = { ...next, nameChosen: true, passwordEncrypted: value.password === undefined ? state.passwordEncrypted : encrypt(value.password) };
      write(updated); state = updated; return this.snapshot();
    }
  };
}
function applyPilotDefaults(env, settings, password) {
  const values = { SELF_LIVE_NAME: settings.name, SELF_LIVE_ROOM: settings.room, SELF_LIVE_PASSWORD: password,
    SELF_LIVE_RELAY_URL: settings.relayUrl, SELF_LIVE_UPNP: settings.upnp };
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
}
module.exports = { createPilotConfig, applyPilotDefaults };

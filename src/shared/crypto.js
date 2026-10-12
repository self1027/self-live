const { createHash, timingSafeEqual } = require('node:crypto');

// Compatível com o handshake definido para o MVP. Nunca registra a senha.
function passwordHash(password, room) {
  return createHash('sha256').update(password + room).digest('hex');
}
function equalHash(a, b) {
  if (typeof a !== 'string' || !/^[a-f0-9]{64}$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
module.exports = { passwordHash, equalHash };

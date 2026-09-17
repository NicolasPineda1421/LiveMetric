const crypto = require('crypto');

const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

if (!INTERNAL_SERVICE_TOKEN) {
  console.error('FATAL: INTERNAL_SERVICE_TOKEN no está definido en el entorno.');
  process.exit(1);
}

// Restringe /internal/certify a llamadas del worker "scheduler-service".
// No es JWT de usuario: es un secreto compartido servicio-a-servicio que
// nunca sale de la red interna "app-net" (el endpoint no debe publicarse
// jamás fuera de esa red). Se compara con timingSafeEqual para evitar
// filtrar el token por diferencias de tiempo de respuesta (timing attack).
function requireInternalToken(req, res, next) {
  const provided = req.headers['x-internal-token'] || '';
  const expected = INTERNAL_SERVICE_TOKEN;

  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(String(expected));

  const isValid =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!isValid) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  return next();
}

module.exports = { requireInternalToken };

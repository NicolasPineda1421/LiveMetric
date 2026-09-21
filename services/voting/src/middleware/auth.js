const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está definido en el entorno.');
  process.exit(1);
}

// Mismo contrato que el middleware de Analytics: exige Bearer token firmado
// por Auth, fuerza HS256 (evita "algorithm confusion") y exige que el rol
// esté entre los permitidos. Se usa aquí solo para las rutas de
// administración; la ruta pública de votación NUNCA pasa por este middleware.
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Token de autenticación requerido' });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (!allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'Permisos insuficientes' });
      }
      req.user = payload;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
  };
}

const requireAuth = requireRole('admin');

module.exports = { requireAuth, requireRole };

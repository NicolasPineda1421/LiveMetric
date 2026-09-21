const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está definido en el entorno.');
  process.exit(1);
}

// Verifica el JWT (mismo secreto compartido que Auth, algoritmo forzado a
// HS256 para evitar "algorithm confusion") y exige que el rol esté dentro
// de los permitidos. `admin` puede todo; `auditor` es de solo lectura y se
// usa únicamente en las rutas que explícitamente lo permiten.
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

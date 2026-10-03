const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está definido en el entorno.');
  process.exit(1);
}

// Exige un JWT válido de alguno de los roles indicados. Los tokens del
// segundo factor (ver /login/voter y /login/admin) no llevan rol, así que
// nunca pasan por aquí.
function requireRole(...roles) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Token de autenticación requerido' });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (!roles.includes(payload.role)) {
        return res.status(403).json({ error: 'Permisos insuficientes' });
      }
      req.user = payload;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
  };
}

// Protege las rutas de gestión de identidad (/admin/users, /admin/voters).
// Solo un admin ya autenticado puede crear otros usuarios o cargar el padrón.
const requireAdmin = requireRole('admin');

module.exports = { requireAdmin, requireRole };

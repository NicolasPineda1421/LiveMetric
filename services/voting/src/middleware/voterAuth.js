const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está definido en el entorno.');
  process.exit(1);
}

// Exige un JWT de VOTANTE (emitido por Auth tras validar la cédula contra
// el padrón). A diferencia del middleware de admin, aquí se exige
// explícitamente role === 'voter': un token de administrador no puede
// usarse para votar, ni viceversa.
//
// El token trae "voterIdHash" ya calculado por Auth (SHA-256 de la cédula +
// salt privado que Voting nunca conoce). Este servicio jamás ve la cédula
// en texto plano.
function requireVoter(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Debes iniciar sesión con tu cédula antes de votar' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.role !== 'voter' || !payload.voterIdHash) {
      return res.status(403).json({ error: 'Este token no es válido para votar' });
    }
    req.voter = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión de votación inválida o expirada, inicia sesión de nuevo' });
  }
}

module.exports = { requireVoter };

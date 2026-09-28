// Configuración de las pruebas: son autónomas, no leen ningún .env.
// - La base es un PostgreSQL desechable que levanta el globalSetup de Jest
//   (scripts/lib/jest-db-setup.js) y que deja su conexión en DB_*.
// - Los secretos de la aplicación se generan al azar para cada corrida: las
//   pruebas firman y verifican sus propios tokens, y la base empieza vacía,
//   así que ningún valor fijo hace falta (ni queda escrito en el código).
// Con "||=" se respeta lo que ya venga del entorno.
const crypto = require('crypto');

const aleatorio = (bytes) => crypto.randomBytes(bytes).toString('base64');

process.env.JWT_SECRET ||= aleatorio(48);
process.env.VOTER_ID_SALT ||= aleatorio(48);
process.env.INTERNAL_SERVICE_TOKEN ||= aleatorio(48);
// Clave AES-256 del padrón: exactamente 32 bytes.
process.env.VOTERS_ENCRYPTION_KEY ||= aleatorio(32);
process.env.JWT_EXPIRES_IN ||= '1h';
process.env.VOTER_JWT_EXPIRES_IN ||= '10m';

// Par de claves de la firma digital de las actas (Ed25519, 32 bytes cada
// una en base64): la privada firma en scrutiny-service y la pública
// verifica en analytics-service, así que se generan juntas.
if (!process.env.ACTA_SIGNING_KEY) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const crudo = (clave, campo) => Buffer.from(clave.export({ format: 'jwk' })[campo], 'base64url').toString('base64');
  process.env.ACTA_SIGNING_KEY = crudo(privateKey, 'd');
  process.env.ACTA_PUBLIC_KEY = crudo(publicKey, 'x');
}

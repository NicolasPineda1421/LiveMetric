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

// Los secretos propios de cada instalación: se generan al azar la primera vez
// y nunca se comparten entre PCs. Lo usan scripts/lib/generar-env.js (el .env
// de las instalaciones desde el repo) y scripts/generarEnv.js (el del compose
// de Docker Hub, que corre sin el repo): así los dos los generan igual.

const crypto = require('crypto');

// Los que se generan, en el orden en que van en el .env.
const SECRETOS = [
  'POSTGRES_PASSWORD',
  'JWT_SECRET',
  'VOTER_ID_SALT',
  'VOTERS_ENCRYPTION_KEY',
  'INTERNAL_SERVICE_TOKEN',
  'ACTA_SIGNING_KEY',
  'ACTA_PUBLIC_KEY',
];

// Firma de las actas (Ed25519): en el .env van los 32 bytes de cada clave
// en base64, igual que los lee services/scrutiny/src/actaSignature.js.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const crudo = (clave, campo) => Buffer.from(clave.export({ format: 'jwk' })[campo], 'base64url').toString('base64'); // eslint-disable-line security/detect-object-injection -- campo es 'd' o 'x', fijos en este archivo

function publicaDe(privadaB64) {
  const clave = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(privadaB64, 'base64')]),
    format: 'der',
    type: 'pkcs8',
  });
  return crudo(crypto.createPublicKey(clave), 'x');
}

// Devuelve generado(nombre): el valor nuevo de cada secreto. La pública de
// las actas se deriva de la privada (la que ya había, o una nueva), así que
// siempre quedan en pareja. La clave del padrón es AES-256: exactamente 32
// bytes en base64. La contraseña de Postgres va en hexadecimal, sin
// caracteres que alguna herramienta tenga que escapar.
function crearGenerador(privadaExistente) {
  const privada = privadaExistente || crudo(crypto.generateKeyPairSync('ed25519').privateKey, 'd');
  return function generado(nombre) {
    if (nombre === 'ACTA_SIGNING_KEY') return privada;
    if (nombre === 'ACTA_PUBLIC_KEY') return publicaDe(privada);
    if (nombre === 'VOTERS_ENCRYPTION_KEY') return crypto.randomBytes(32).toString('base64');
    if (nombre === 'POSTGRES_PASSWORD') return crypto.randomBytes(24).toString('hex');
    return crypto.randomBytes(48).toString('base64');
  };
}

module.exports = { SECRETOS, crearGenerador, publicaDe };

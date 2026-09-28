const crypto = require('crypto');
const { loadPrivateKey, loadPublicKey, keyIdOf } = require('./actaSignature');

// Claves de la firma digital de las actas (ver actaSignature.js). Sin la
// privada, scrutiny-service no podría firmar lo que certifica: no arranca.
function fatal(message) {
  console.error(`FATAL: ${message}.`);
  process.exit(1);
}

let privateKey;
let publicKey;
try {
  privateKey = loadPrivateKey(process.env.ACTA_SIGNING_KEY);
  publicKey = crypto.createPublicKey(privateKey);
} catch (err) {
  fatal(err.message);
}
const keyId = keyIdOf(publicKey);

// Si también viene la pública (la que usa analytics-service para verificar),
// tiene que ser la pareja de la privada: si no, analytics vería todas las
// actas nuevas como firmadas "con otra clave".
if (process.env.ACTA_PUBLIC_KEY) {
  let configured;
  try {
    configured = loadPublicKey(process.env.ACTA_PUBLIC_KEY);
  } catch (err) {
    fatal(err.message);
  }
  if (keyIdOf(configured) !== keyId) {
    fatal('ACTA_PUBLIC_KEY no corresponde a ACTA_SIGNING_KEY: van en pareja (ver scripts/lib/generar-env.js)');
  }
}

module.exports = { privateKey, publicKey, keyId };

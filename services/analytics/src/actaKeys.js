const { loadPublicKey, keyIdOf } = require('./actaSignature');

// Clave pública de la firma digital de las actas (ver actaSignature.js).
// analytics-service verifica las firmas por su cuenta, sin preguntarle a
// scrutiny-service, y nunca tiene la clave privada: con la pública se puede
// comprobar una firma, pero no fabricarla.
let publicKey;
try {
  publicKey = loadPublicKey(process.env.ACTA_PUBLIC_KEY);
} catch (err) {
  console.error(`FATAL: ${err.message}.`);
  process.exit(1);
}

module.exports = { publicKey, keyId: keyIdOf(publicKey) };

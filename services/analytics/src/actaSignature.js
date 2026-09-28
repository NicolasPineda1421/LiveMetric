const crypto = require('crypto');

// Firma digital de las actas de escrutinio (Ed25519).
//
// La cadena de hashes (hashChain.js) prueba que un acta no cambió respecto
// de las demás, pero no usa ningún secreto: quien pueda escribir en la base
// podría alterar un acta y recalcular todos los hashes siguientes, y la
// cadena seguiría "íntegra". La firma cierra ese hueco: scrutiny-service
// firma el record_hash de cada acta al certificarla con una clave privada
// que solo él conoce (ACTA_SIGNING_KEY), y cualquiera con la clave pública
// (ACTA_PUBLIC_KEY) puede comprobarla. Sin la privada no se puede fabricar
// una firma válida para un acta alterada.
//
// Las claves van en el .env como sus 32 bytes en base64 (las genera
// scripts/lib/generar-env.js). Aquí se envuelven en DER para que Node las
// acepte: los prefijos son la cabecera fija de PKCS#8 y SPKI para Ed25519
// (RFC 8410).
//
// Copia EXACTA en services/analytics/src/actaSignature.js: analytics
// verifica las firmas por su cuenta, sin preguntarle a scrutiny-service (lo
// comprueba la prueba "actaSignature de analytics coincide con el de
// scrutiny").

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

// Lo que se firma es el record_hash con un prefijo de contexto: así la firma
// de un acta no sirve como firma de ninguna otra cosa.
const CONTEXT = 'livemetric/acta/v1:';

function rawKey(base64, name) {
  const raw = Buffer.from(String(base64 || ''), 'base64');
  if (raw.length !== 32) {
    throw new Error(`${name} debe ser una clave Ed25519 de 32 bytes en base64`);
  }
  return raw;
}

function loadPrivateKey(base64) {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, rawKey(base64, 'ACTA_SIGNING_KEY')]),
    format: 'der',
    type: 'pkcs8',
  });
}

function loadPublicKey(base64) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519, rawKey(base64, 'ACTA_PUBLIC_KEY')]),
    format: 'der',
    type: 'spki',
  });
}

// Identificador corto de una clave pública: los primeros 16 caracteres del
// SHA-256 de sus 32 bytes. Se guarda con cada acta (con qué clave se firmó)
// y se imprime en el PDF.
function keyIdOf(publicKey) {
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function signRecordHash(privateKey, recordHash) {
  return crypto.sign(null, Buffer.from(CONTEXT + recordHash), privateKey).toString('base64');
}

// Estado de la firma de un acta (una fila de scrutiny_ledger) frente a la
// clave pública de esta instalación:
//   'valida'      firmada con esta clave, y la firma corresponde a su record_hash
//   'invalida'    la firma no corresponde: se cambió el hash o la firma
//   'otra_clave'  dice estar firmada con una clave que esta instalación no reconoce
//   'sin_firma'   no tiene firma (certificada antes de que existiera la firma digital)
function signatureStatus(row, publicKey, keyId = keyIdOf(publicKey)) {
  if (!row.signature) return 'sin_firma';
  if (row.signing_key_id !== keyId) return 'otra_clave';
  try {
    const ok = crypto.verify(null, Buffer.from(CONTEXT + row.record_hash), publicKey, Buffer.from(row.signature, 'base64'));
    return ok ? 'valida' : 'invalida';
  } catch {
    return 'invalida';
  }
}

module.exports = { loadPrivateKey, loadPublicKey, keyIdOf, signRecordHash, signatureStatus };

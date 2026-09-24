const crypto = require('crypto');

const KEY_B64 = process.env.VOTERS_ENCRYPTION_KEY;
const KEY = KEY_B64 ? Buffer.from(KEY_B64, 'base64') : null;

if (!KEY || KEY.length !== 32) {
  console.error('FATAL: VOTERS_ENCRYPTION_KEY debe ser una clave AES-256 (32 bytes) en base64.');
  process.exit(1);
}

// Cifrado en reposo de columnas de "voters" (cedula, polling_place,
// voting_table). AES-256-GCM con un nonce DETERMINÍSTICO: HMAC-SHA256(clave,
// texto plano) truncado a 12 bytes, en vez de un IV aleatorio. Es una
// decisión consciente, no un descuido: el mismo texto plano cifra siempre
// igual, así se puede seguir haciendo `WHERE cedula = $1` y mantener la
// restricción UNIQUE sin decodificar toda la tabla. El costo es que alguien
// con acceso directo a la base (pero sin esta clave) puede notar que dos
// filas comparten el mismo valor cifrado, aunque no puede leer cuál es. Con
// un IV aleatorio esa igualdad no se podría buscar en absoluto.
// La etiqueta de autenticacion de GCM se fija en 16 bytes al cifrar y al
// descifrar: sin authTagLength, createDecipheriv aceptaria etiquetas mas
// cortas (hasta 4 bytes), que un atacante puede adivinar por fuerza bruta
// para hacer pasar un texto cifrado alterado como valido.
const AUTH_TAG_LENGTH = 16;

function deterministicNonce(plaintext) {
  return crypto.createHmac('sha256', KEY).update(plaintext).digest().subarray(0, 12);
}

function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const text = String(plaintext);
  const iv = deterministicNonce(text);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptField(value) {
  if (value === null || value === undefined) return null;
  const raw = Buffer.from(value, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 12 + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(12 + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encryptField, decryptField };

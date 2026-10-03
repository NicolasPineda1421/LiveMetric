// TOTP (RFC 6238): el código de 6 dígitos que cambia cada 30 segundos en
// Microsoft Authenticator, Google Authenticator o Authy. Se usan los
// parámetros que todas esas apps entienden sin configurar nada: HMAC-SHA1,
// pasos de 30 s y 6 dígitos. Implementado sobre el crypto de Node, sin
// dependencias: son unas pocas líneas y se prueban contra los vectores del
// propio RFC (ver __tests__/totp.test.js).
const crypto = require('crypto');

const PASO_SEGUNDOS = 30;
const DIGITOS = 6;
const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Las apps reciben el secreto en base32 (RFC 4648, sin relleno), dentro del
// QR o para escribirlo a mano.
function base32Encode(buffer) {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of buffer) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32.charAt((valor >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO_BASE32.charAt((valor << (5 - bits)) & 31);
  return salida;
}

function base32Decode(texto) {
  const limpio = texto.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const caracter of limpio) {
    const indice = ALFABETO_BASE32.indexOf(caracter);
    if (indice === -1) throw new Error('Secreto TOTP inválido');
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160 bits al azar: el tamaño que recomienda el RFC 4226 para HMAC-SHA1.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / PASO_SEGUNDOS);
}

// HOTP (RFC 4226) sobre el número de paso: HMAC del contador de 8 bytes y
// "truncado dinámico" a 6 dígitos.
function codeAt(secret, step) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(contador).digest();
  const desplazamiento = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const numero = hmac.readUInt32BE(desplazamiento) & 0x7fffffff;
  return String(numero % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

// Devuelve el paso del código si es válido, o null. Acepta el paso actual y
// los vecinos (±30 s): cubre un reloj algo desfasado y a quien tarda en
// escribir el código. Nunca acepta un paso igual o anterior al último que
// ya se usó: un código visto o interceptado no sirve dos veces.
function verify(secret, code, { lastStep = null, now = Date.now() } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const ahora = currentStep(now);
  const ultimo = lastStep === null || lastStep === undefined ? null : Number(lastStep);
  for (const delta of [-1, 0, 1]) {
    const paso = ahora + delta;
    if (ultimo !== null && paso <= ultimo) continue;
    const esperado = codeAt(secret, paso);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(code))) return paso;
  }
  return null;
}

// Lo que codifica el QR. La etiqueta es lo que la persona ve en su app: el
// emisor y un nombre corto para reconocer la cuenta.
function otpauthUri({ secret, account, issuer = 'LiveMetric' }) {
  const etiqueta = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const parametros = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITOS), period: String(PASO_SEGUNDOS) });
  return `otpauth://totp/${etiqueta}?${parametros}`;
}

module.exports = { generateSecret, currentStep, codeAt, verify, otpauthUri, base32Encode, base32Decode };

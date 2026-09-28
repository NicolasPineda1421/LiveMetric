#!/usr/bin/env node
// LiveMetric - Genera el .env de esta instalación a partir de .env.example,
// con secretos aleatorios propios: cada instalación tiene su propia base y
// sus propias claves, así que no hay nada que compartir entre PCs (ni
// passphrase, ni gpg). Lo usan scripts/start.sh, start.bat y contenedor.sh
// la primera vez, y el pipeline para el entorno de staging.
//
// Nunca pisa un valor existente. Si el .env ya existe, solo agrega las
// variables de la plantilla que le falten (por ejemplo POSTGRES_PASSWORD en
// un .env de antes de la base local), con valor generado si son secretos, y
// genera las que todavía tengan un marcador de la plantilla en vez de un
// valor (un .env copiado a mano, o uno que quedó así en Windows, ver abajo).
//
// Uso: node scripts/lib/generar-env.js [ruta-del-env]   (por defecto, .env en la raíz del repo)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const destino = path.resolve(process.argv[2] || path.join(RAIZ, '.env'));
const MARCA = 'CAMBIA_ESTE_VALOR_LOCALMENTE';
const MARCA_DERIVADA = 'SE_DERIVA_DE_ACTA_SIGNING_KEY';
const LINEA_VARIABLE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

// Git para Windows baja los archivos de texto con fin de línea CRLF, y el
// "\r" que queda al final de cada línea haría que ninguna coincida con
// LINEA_VARIABLE (en JavaScript, "." no acepta "\r"). Se normaliza al leer.
const leer = (ruta) => fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const esMarcador = (valor) => valor.includes(MARCA) || valor.includes(MARCA_DERIVADA);

const plantilla = leer(path.join(RAIZ, '.env.example'));
const actual = fs.existsSync(destino) ? leer(destino) : null;

// Variables que ya tiene el .env (vacío si todavía no existe).
const existentes = new Map(
  (actual || '')
    .split('\n')
    .map((linea) => linea.trim().match(LINEA_VARIABLE))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const tieneValor = (nombre) => existentes.has(nombre) && !esMarcador(existentes.get(nombre));

// Firma de las actas (Ed25519): en el .env van los 32 bytes de cada clave
// en base64, igual que los lee services/scrutiny/src/actaSignature.js. La
// pública se deriva de la privada (la que ya había, o una nueva), así que
// siempre quedan en pareja.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const crudo = (clave, campo) => Buffer.from(clave.export({ format: 'jwk' })[campo], 'base64url').toString('base64');
const privada = tieneValor('ACTA_SIGNING_KEY')
  ? existentes.get('ACTA_SIGNING_KEY')
  : crudo(crypto.generateKeyPairSync('ed25519').privateKey, 'd');
function publicaDe(privadaB64) {
  const clave = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(privadaB64, 'base64')]),
    format: 'der',
    type: 'pkcs8',
  });
  return crudo(crypto.createPublicKey(clave), 'x');
}

// El valor generado para una variable secreta. La clave del padrón es
// AES-256: exactamente 32 bytes en base64. La contraseña de Postgres va en
// hexadecimal, sin caracteres que alguna herramienta tenga que escapar.
function generado(nombre) {
  if (nombre === 'ACTA_SIGNING_KEY') return privada;
  if (nombre === 'ACTA_PUBLIC_KEY') return publicaDe(privada);
  if (nombre === 'VOTERS_ENCRYPTION_KEY') return crypto.randomBytes(32).toString('base64');
  if (nombre === 'POSTGRES_PASSWORD') return crypto.randomBytes(24).toString('hex');
  return crypto.randomBytes(48).toString('base64');
}

// Cada línea de la plantilla, con los marcadores reemplazados.
const lineas = plantilla.split('\n').map((linea) => {
  const m = linea.match(LINEA_VARIABLE);
  if (!m) return { linea, nombre: null };
  const [, nombre, valor] = m;
  return { linea: esMarcador(valor) ? `${nombre}=${generado(nombre)}` : linea, nombre };
});

if (actual === null) {
  fs.writeFileSync(destino, lineas.map((l) => l.linea).join('\n'), { mode: 0o600 });
  console.log(`Se generó ${path.basename(destino)} con secretos aleatorios propios de esta instalación.`);
  process.exit(0);
}

// Una pública sin su privada no se puede completar: una privada nueva no
// sería la pareja de esa pública.
if (tieneValor('ACTA_PUBLIC_KEY') && !tieneValor('ACTA_SIGNING_KEY')) {
  console.error(
    `${path.basename(destino)} tiene ACTA_PUBLIC_KEY pero no ACTA_SIGNING_KEY: borra ACTA_PUBLIC_KEY ` +
      'y vuelve a correr este script para generar el par completo.',
  );
  process.exit(1);
}

// Las que todavía tienen un marcador en vez de un valor se generan en su
// lugar; las que faltan se agregan al final.
const reemplazadas = [];
const contenido = actual
  .split('\n')
  .map((linea) => {
    const m = linea.trim().match(LINEA_VARIABLE);
    if (!m || !esMarcador(m[2])) return linea;
    reemplazadas.push(m[1]);
    return `${m[1]}=${generado(m[1])}`;
  })
  .join('\n');
const faltantes = lineas.filter((l) => l.nombre && !existentes.has(l.nombre));

if (!reemplazadas.length && !faltantes.length) {
  console.log(`${path.basename(destino)} ya existe y está completo.`);
  process.exit(0);
}

fs.writeFileSync(
  destino,
  faltantes.length
    ? `${contenido.replace(/\n*$/, '\n')}\n# --- Agregadas por scripts/lib/generar-env.js: variables nuevas de .env.example ---\n` +
        `${faltantes.map((l) => l.linea).join('\n')}\n`
    : contenido,
);

const cambios = [];
if (reemplazadas.length) cambios.push(`se generaron ${reemplazadas.join(', ')}, que tenían el marcador de la plantilla`);
if (faltantes.length) cambios.push(`se agregaron ${faltantes.map((l) => l.nombre).join(', ')}`);
console.log(`${path.basename(destino)} ya existía: ${cambios.join('; ')}.`);
// La base se inicializa con la contraseña que tenga el .env la primera vez:
// si se creó con el marcador, ya no acepta la nueva.
if (reemplazadas.includes('POSTGRES_PASSWORD')) {
  console.log('Si la base ya se había creado con esos valores, créala de nuevo: docker compose down -v');
}

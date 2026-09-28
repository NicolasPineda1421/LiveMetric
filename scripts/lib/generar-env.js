#!/usr/bin/env node
// LiveMetric - Genera el .env de esta instalación a partir de .env.example,
// con secretos aleatorios propios: cada instalación tiene su propia base y
// sus propias claves, así que no hay nada que compartir entre PCs (ni
// passphrase, ni gpg). Lo usan scripts/start.sh, start.bat y contenedor.sh
// la primera vez, y el pipeline para el entorno de staging.
//
// Nunca pisa un valor existente. Si el .env ya existe, solo agrega las
// variables de la plantilla que le falten (por ejemplo POSTGRES_PASSWORD en
// un .env de antes de la base local), con valor generado si son secretos.
//
// Uso: node scripts/lib/generar-env.js [ruta-del-env]   (por defecto, .env en la raíz del repo)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const destino = path.resolve(process.argv[2] || path.join(RAIZ, '.env'));
const plantilla = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8');
const MARCA = 'CAMBIA_ESTE_VALOR_LOCALMENTE';
const MARCA_DERIVADA = 'SE_DERIVA_DE_ACTA_SIGNING_KEY';
const LINEA_VARIABLE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

// Variables que ya tiene el .env (vacío si todavía no existe).
const existentes = new Map(
  (fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : '')
    .split('\n')
    .map((linea) => linea.trim().match(LINEA_VARIABLE))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

// Firma de las actas (Ed25519): en el .env van los 32 bytes de cada clave
// en base64, igual que los lee services/scrutiny/src/actaSignature.js. La
// pública se deriva de la privada, así que siempre quedan en pareja.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const crudo = (clave, campo) => Buffer.from(clave.export({ format: 'jwk' })[campo], 'base64url').toString('base64');
const privadaNueva = crudo(crypto.generateKeyPairSync('ed25519').privateKey, 'd');
function publicaDe(privadaB64) {
  const privada = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(privadaB64, 'base64')]),
    format: 'der',
    type: 'pkcs8',
  });
  return crudo(crypto.createPublicKey(privada), 'x');
}

// La clave del padrón es AES-256: exactamente 32 bytes en base64. La
// contraseña de Postgres va en hexadecimal, sin caracteres que alguna
// herramienta tenga que escapar.
function secreto(nombre) {
  if (nombre === 'VOTERS_ENCRYPTION_KEY') return crypto.randomBytes(32).toString('base64');
  if (nombre === 'POSTGRES_PASSWORD') return crypto.randomBytes(24).toString('hex');
  if (nombre === 'ACTA_SIGNING_KEY') return privadaNueva;
  return crypto.randomBytes(48).toString('base64');
}

// Cada línea de la plantilla, con los marcadores reemplazados.
const lineas = plantilla.split('\n').map((linea) => {
  const m = linea.match(LINEA_VARIABLE);
  if (!m) return { linea, nombre: null };
  const [, nombre, valor] = m;
  if (valor.includes(MARCA)) return { linea: `${nombre}=${secreto(nombre)}`, nombre };
  if (valor.includes(MARCA_DERIVADA)) {
    return { linea: `${nombre}=${publicaDe(existentes.get('ACTA_SIGNING_KEY') || privadaNueva)}`, nombre };
  }
  return { linea, nombre };
});

if (!fs.existsSync(destino)) {
  fs.writeFileSync(destino, lineas.map((l) => l.linea).join('\n'), { mode: 0o600 });
  console.log(`Se generó ${path.basename(destino)} con secretos aleatorios propios de esta instalación.`);
  process.exit(0);
}

const faltantes = lineas.filter((l) => l.nombre && !existentes.has(l.nombre));
if (!faltantes.length) {
  console.log(`${path.basename(destino)} ya existe y está completo.`);
  process.exit(0);
}

// Una pública sin su privada no se puede completar: generar una privada
// nueva no daría la pareja de esa pública.
if (existentes.has('ACTA_PUBLIC_KEY') && !existentes.has('ACTA_SIGNING_KEY')) {
  console.error(
    `${path.basename(destino)} tiene ACTA_PUBLIC_KEY pero no ACTA_SIGNING_KEY: borra ACTA_PUBLIC_KEY ` +
      'y vuelve a correr este script para generar el par completo.',
  );
  process.exit(1);
}

fs.appendFileSync(
  destino,
  `\n# --- Agregadas por scripts/lib/generar-env.js: variables nuevas de .env.example ---\n` +
    `${faltantes.map((l) => l.linea).join('\n')}\n`,
);
console.log(`${path.basename(destino)} ya existía: se agregaron ${faltantes.map((l) => l.nombre).join(', ')}.`);

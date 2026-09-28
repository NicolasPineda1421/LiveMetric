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
const LINEA_VARIABLE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

// La clave del padrón es AES-256: exactamente 32 bytes en base64. La
// contraseña de Postgres va en hexadecimal, sin caracteres que alguna
// herramienta tenga que escapar.
function secreto(nombre) {
  if (nombre === 'VOTERS_ENCRYPTION_KEY') return crypto.randomBytes(32).toString('base64');
  if (nombre === 'POSTGRES_PASSWORD') return crypto.randomBytes(24).toString('hex');
  return crypto.randomBytes(48).toString('base64');
}

// Cada línea de la plantilla, con los marcadores reemplazados por secretos.
const lineas = plantilla.split('\n').map((linea) => {
  const m = linea.match(LINEA_VARIABLE);
  if (!m || !m[2].includes(MARCA)) return { linea, nombre: m && m[1] };
  return { linea: `${m[1]}=${secreto(m[1])}`, nombre: m[1] };
});

if (!fs.existsSync(destino)) {
  fs.writeFileSync(destino, lineas.map((l) => l.linea).join('\n'), { mode: 0o600 });
  console.log(`Se generó ${path.basename(destino)} con secretos aleatorios propios de esta instalación.`);
  process.exit(0);
}

const existentes = new Set(
  fs
    .readFileSync(destino, 'utf8')
    .split('\n')
    .map((linea) => (linea.trim().match(LINEA_VARIABLE) || [])[1])
    .filter(Boolean),
);
const faltantes = lineas.filter((l) => l.nombre && !existentes.has(l.nombre));
if (!faltantes.length) {
  console.log(`${path.basename(destino)} ya existe y está completo.`);
  process.exit(0);
}

fs.appendFileSync(
  destino,
  `\n# --- Agregadas por scripts/lib/generar-env.js: variables nuevas de .env.example ---\n` +
    `${faltantes.map((l) => l.linea).join('\n')}\n`,
);
console.log(`${path.basename(destino)} ya existía: se agregaron ${faltantes.map((l) => l.nombre).join(', ')}.`);

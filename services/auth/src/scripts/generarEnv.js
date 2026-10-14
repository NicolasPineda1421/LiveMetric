// El .env del compose de Docker Hub (docker-hub/docker-compose.yml), que
// corre LiveMetric sin el repositorio: este script viaja en la imagen de
// auth, así que basta con Docker.
//
//   docker compose run --rm configurar
//     Crea el .env de la carpeta con secretos aleatorios propios de esta
//     instalación. Si ya existe, solo agrega los que le falten (por ejemplo,
//     uno nuevo de una versión posterior): nunca cambia uno que ya está, porque
//     con otra clave el padrón cifrado quedaría ilegible.
//
//   node src/scripts/generarEnv.js --revisar
//     Lo corre el servicio "revisar-configuracion" en cada "docker compose up",
//     antes que la base: falla, diciendo qué hacer, si al .env le falta algún
//     secreto. Recibe solo si cada uno existe ("si" o vacío), nunca su valor.
//
// Corre como root para poder escribir en la carpeta del usuario (en Linux, de
// otro dueño), y deja el archivo a nombre del dueño de esa carpeta.

const fs = require('fs');
const path = require('path');
const { SECRETOS, crearGenerador } = require('../secretosInstalacion');

const LINEA_VARIABLE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;
const COMANDO = 'docker compose run --rm configurar';

const ENCABEZADO = `# LiveMetric - Configuración de esta instalación (compose de Docker Hub).
#
# Los secretos de abajo se generaron al azar para esta instalación. No los
# compartas ni los subas a ningún lado, y no los cambies: la base se creó con
# esa contraseña y el padrón se cifró con esa clave. Si se pierden, el padrón
# no se puede leer: guarda una copia de este archivo junto con el respaldo de
# la base.
`;

const OPCIONALES = `
# --- Opcionales: quita el "#" para cambiarlas ---
# Versión de las imágenes (por defecto, la última publicada: latest).
# LIVEMETRIC_VERSION=1.5.0
# Puerto de la aplicación en esta PC (por defecto, 3000).
# LIVEMETRIC_PUERTO=3000
# Horas que dura cada PIN de votante desde que se genera (de 1 a 2160).
# PIN_VIGENCIA_HORAS=24
`;

// Las variables con valor que ya tiene el texto de un .env.
function leerVariables(texto) {
  const variables = new Map();
  for (const linea of texto.replace(/\r\n/g, '\n').split('\n')) {
    const m = linea.trim().match(LINEA_VARIABLE);
    if (!m) continue;
    const valor = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    if (valor) variables.set(m[1], valor);
  }
  return variables;
}

/* eslint-disable security/detect-non-literal-fs-filename -- la ruta es la del .env que indica quien corre el script (en el compose, /salida/.env) */

// Crea el .env o le agrega los secretos que falten. Devuelve el mensaje para
// la persona; lanza un error si no se puede completar.
function prepararEnv(ruta) {
  if (fs.existsSync(ruta) && !fs.statSync(ruta).isFile()) {
    throw new Error(`${ruta} existe pero no es un archivo: bórralo y vuelve a correr ${COMANDO}.`);
  }
  const actual = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : null;
  const existentes = leerVariables(actual || '');

  // Una pública sin su privada no se puede completar: una privada nueva no
  // sería la pareja de esa pública.
  if (existentes.has('ACTA_PUBLIC_KEY') && !existentes.has('ACTA_SIGNING_KEY')) {
    throw new Error('El .env tiene ACTA_PUBLIC_KEY pero no ACTA_SIGNING_KEY: borra ACTA_PUBLIC_KEY y vuelve a correr ' +
      `${COMANDO} para generar el par completo.`);
  }

  const generado = crearGenerador(existentes.get('ACTA_SIGNING_KEY'));
  const faltantes = SECRETOS.filter((nombre) => !existentes.has(nombre));
  const lineas = faltantes.map((nombre) => `${nombre}=${generado(nombre)}`);

  if (actual === null) {
    fs.writeFileSync(ruta, `${ENCABEZADO}\n${lineas.join('\n')}\n${OPCIONALES}`, { mode: 0o600 });
    darAlDuenoDeLaCarpeta(ruta);
    return 'Se creó el .env con los secretos de esta instalación. Ahora: docker compose up -d';
  }
  if (!faltantes.length) {
    return 'El .env ya existe y está completo: no se cambió nada.';
  }
  const base = actual.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  fs.writeFileSync(ruta, `${base}\n# --- Agregados por "${COMANDO}" ---\n${lineas.join('\n')}\n`);
  return `Al .env le faltaban ${faltantes.join(', ')}: se agregaron, sin tocar los demás.`;
}

// En Linux el contenedor escribe como root en una carpeta del usuario: el
// archivo queda a nombre del dueño de la carpeta, que así lo puede leer (y
// "docker compose" también). En Docker Desktop no hace falta, y puede fallar.
function darAlDuenoDeLaCarpeta(ruta) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const { uid, gid } = fs.statSync(path.dirname(ruta));
  try {
    fs.chownSync(ruta, uid, gid);
  } catch {
    // Sin permiso para cambiar el dueño: el archivo igual quedó escrito.
  }
}

/* eslint-enable security/detect-non-literal-fs-filename */

// Los secretos que no llegaron (vacíos) en el entorno.
function secretosFaltantes(entorno) {
  return SECRETOS.filter((nombre) => !entorno[nombre]); // eslint-disable-line security/detect-object-injection -- nombre sale de la lista fija SECRETOS
}

function main(args) {
  if (args[0] === '--revisar') {
    const faltan = secretosFaltantes(process.env);
    if (!faltan.length) {
      console.log('Configuración completa.');
      return 0;
    }
    console.error(faltan.length === SECRETOS.length
      ? 'No hay .env en esta carpeta (o está vacío).'
      : `Al .env le faltan: ${faltan.join(', ')}.`);
    console.error(`Créalo o complétalo con:  ${COMANDO}`);
    console.error('y vuelve a correr:        docker compose up -d');
    return 1;
  }
  if (!args[0]) {
    console.error('Uso: node src/scripts/generarEnv.js <ruta-del-env> | --revisar');
    return 1;
  }
  try {
    console.log(prepararEnv(path.resolve(args[0])));
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { prepararEnv, leerVariables, secretosFaltantes, main };

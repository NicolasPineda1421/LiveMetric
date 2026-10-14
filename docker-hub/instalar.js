// La imagen de instalación (nicolaspineda1421/livemetric, docker-hub/Dockerfile):
//
//   docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric
//
// deja en la carpeta montada el docker-compose.yml de esta versión y el .env
// con secretos aleatorios propios de la instalación. Después basta con
// "docker compose up -d". Correrla de nuevo actualiza el compose y agrega los
// secretos que falten, sin cambiar los que ya están: así también se actualiza.
//
// No pisa nada ajeno: si la carpeta ya tiene un docker-compose.yml o un .env
// que no son de LiveMetric, se detiene. Corre como root para poder escribir
// en la carpeta del usuario (en Linux, de otro dueño), y deja los archivos a
// nombre del dueño de la carpeta.

const fs = require('fs');
const path = require('path');
const { SECRETOS } = require('../services/auth/src/secretosInstalacion');
const { prepararEnv, leerVariables, darAlDuenoDeLaCarpeta } = require('../services/auth/src/scripts/generarEnv');

const COMPOSE = path.join(__dirname, 'docker-compose.yml');
// La línea que distingue al compose de LiveMetric de cualquier otro.
const MARCA_COMPOSE = /^name: livemetric-dockerhub$/m;
const COMANDO = 'docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric';

/* eslint-disable security/detect-non-literal-fs-filename -- la carpeta es la que monta quien corre la imagen (/salida) */

// Sin "-v", /salida es una carpeta del contenedor, que se borra al terminar:
// los archivos se perderían. Se mira la tabla de montajes del contenedor.
function estaMontada(carpeta, mountinfo = '/proc/self/mountinfo') {
  let tabla;
  try {
    tabla = fs.readFileSync(mountinfo, 'utf8');
  } catch {
    return true; // Fuera de Linux no hay tabla: no se puede saber, se sigue.
  }
  return tabla.split('\n').some((linea) => linea.split(' ')[4] === carpeta);
}

function instalar(carpeta, { mountinfo } = {}) {
  if (!fs.existsSync(carpeta) || !fs.statSync(carpeta).isDirectory() || !estaMontada(carpeta, mountinfo)) {
    throw new Error(`Falta montar tu carpeta: corre la imagen con -v "\${PWD}:${carpeta}", así:\n  ${COMANDO}`);
  }
  const compose = path.join(carpeta, 'docker-compose.yml');
  const env = path.join(carpeta, '.env');

  const composeAnterior = fs.existsSync(compose) ? fs.readFileSync(compose, 'utf8') : null;
  if (composeAnterior !== null && !MARCA_COMPOSE.test(composeAnterior)) {
    throw new Error('Esta carpeta ya tiene un docker-compose.yml que no es de LiveMetric: usa una carpeta vacía (por ejemplo, mkdir livemetric && cd livemetric).');
  }
  if (fs.existsSync(env) && fs.statSync(env).isFile()) {
    const variables = leerVariables(fs.readFileSync(env, 'utf8'));
    if (variables.size && !SECRETOS.some((nombre) => variables.has(nombre))) {
      throw new Error('Esta carpeta ya tiene un .env que no es de LiveMetric: usa una carpeta vacía (por ejemplo, mkdir livemetric && cd livemetric).');
    }
  }

  const nuevo = fs.readFileSync(COMPOSE, 'utf8');
  fs.writeFileSync(compose, nuevo, { mode: 0o644 });
  darAlDuenoDeLaCarpeta(compose);
  const estadoCompose = composeAnterior === null ? 'creado' : composeAnterior === nuevo ? 'ya estaba al día' : 'actualizado';
  const estadoEnv = prepararEnv(env);
  return { estadoCompose, estadoEnv };
}

/* eslint-enable security/detect-non-literal-fs-filename */

function main(args) {
  const carpeta = args[0] || '/salida';
  try {
    const { estadoCompose, estadoEnv } = instalar(carpeta);
    console.log(`docker-compose.yml: ${estadoCompose}.`);
    console.log(`.env: ${estadoEnv.replace(/ Ahora: docker compose up -d$/, '')}`);
    console.log('');
    console.log('Guarda el .env: tiene la clave con que se cifra el padrón, y sin él no se puede leer.');
    console.log('');
    console.log('Ahora, en esta carpeta:');
    console.log('  docker compose up -d --pull always');
    console.log('y, la primera vez, crea el administrador:');
    console.log('  docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay');
    console.log('La aplicación queda en http://localhost:3000');
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { instalar, estaMontada, main };

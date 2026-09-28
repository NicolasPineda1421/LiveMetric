// LiveMetric - Base de datos desechable para las pruebas: es el globalSetup
// de Jest de los 5 servicios de backend (ver "jest" en cada package.json).
//
// Levanta un PostgreSQL 16 en un contenedor propio, solo para esta corrida
// de "npm test", le carga el esquema de db/init.sql y deja la conexión en
// DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD. Al final, jest-db-teardown.js
// lo borra. Así las pruebas no dependen de ninguna base externa, no dejan
// datos en otra (ni las actas append-only de scrutiny) y corren igual en
// una PC, en el contenedor global y en GitHub Actions: solo necesitan Docker.
//
// Si DB_HOST ya viene definido, se usa esa base y no se levanta nada.

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const IMAGEN = 'postgres:16-alpine';
const ESPERA_MAXIMA_MS = 120 * 1000;

// Un puerto libre de 127.0.0.1 para publicar la base: fijo chocaría si dos
// servicios corren sus pruebas a la vez, o con otro Postgres de la PC.
function puertoLibre() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.unref();
    servidor.on('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address();
      servidor.close(() => resolve(port));
    });
  });
}

module.exports = async function iniciarBaseDePruebas(_globalConfig, projectConfig) {
  if (process.env.DB_HOST) return;

  // "pg" se resuelve desde el servicio que corre las pruebas: este archivo
  // vive fuera de su node_modules.
  const { Client } = require(require.resolve('pg', { paths: [projectConfig.rootDir] }));
  const nombre = `livemetric-pruebas-${path.basename(projectConfig.rootDir)}-${crypto.randomBytes(3).toString('hex')}`;
  const conexion = {
    host: '127.0.0.1',
    port: await puertoLibre(),
    database: 'livemetric_pruebas',
    user: 'livemetric',
    password: crypto.randomBytes(18).toString('hex'),
  };

  try {
    execFileSync(
      'docker',
      [
        'run', '-d', '--rm', '--name', nombre,
        '-e', `POSTGRES_DB=${conexion.database}`,
        '-e', `POSTGRES_USER=${conexion.user}`,
        '-e', `POSTGRES_PASSWORD=${conexion.password}`,
        '-p', `127.0.0.1:${conexion.port}:5432`,
        IMAGEN,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (err) {
    throw new Error(
      'Las pruebas necesitan Docker para levantar su base desechable (o definir DB_HOST para usar otra): ' +
        String(err.stderr || err.message).trim(),
    );
  }
  process.env.LIVEMETRIC_DB_PRUEBAS = nombre;

  // El esquema se carga por la conexión (y no montando init.sql en el
  // contenedor): así no depende de rutas del host, que cambian en Windows o
  // cuando las pruebas corren dentro de otro contenedor.
  const esquema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'init.sql'), 'utf8');
  const limite = Date.now() + ESPERA_MAXIMA_MS;
  for (;;) {
    const cliente = new Client(conexion);
    try {
      await cliente.connect();
      await cliente.query(esquema);
      // init.sql siembra el padrón de demostración en texto plano (auth-service
      // lo cifra al arrancar, con la clave de cada instalación). Las pruebas
      // crean sus propios votantes, y esas filas sin cifrar harían fallar a
      // cualquier endpoint que descifre el padrón completo.
      await cliente.query('DELETE FROM voters');
      await cliente.end();
      break;
    } catch (err) {
      await cliente.end().catch(() => {});
      if (Date.now() > limite) {
        throw new Error(`La base de pruebas (${nombre}) no quedó lista: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  Object.assign(process.env, {
    DB_HOST: conexion.host,
    DB_PORT: String(conexion.port),
    DB_NAME: conexion.database,
    DB_USER: conexion.user,
    DB_PASSWORD: conexion.password,
  });
};

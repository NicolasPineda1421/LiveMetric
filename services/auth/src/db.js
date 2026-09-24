const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { Pool } = require('pg');

// TLS hacia Supabase con verificacion real del certificado (antes era
// rejectUnauthorized: false, que acepta cualquier certificado y deja la
// conexion expuesta a un man-in-the-middle). certs/supabase-root-2021.crt es
// la CA raiz que publica Supabase (vence el 26/04/2031):
// https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
//
// Dentro de docker-compose la conexion pasa por el proxy "postgres" (socat),
// cuyo nombre no figura en el certificado: DB_SSL_HOST trae el host real de
// Supabase contra el que se verifica. Se hace con checkServerIdentity y no
// con "servername" porque pg pisa servername con el host de la conexion. Sin
// DB_SSL_HOST (npm test, que se conecta directo) se verifica el host normal.
function sslOptions() {
  if (process.env.DB_SSL !== 'true') return false;
  const hostEsperado = process.env.DB_SSL_HOST;
  return {
    ca: fs.readFileSync(path.join(__dirname, 'certs', 'supabase-root-2021.crt'), 'utf8'),
    ...(hostEsperado && {
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostEsperado, cert),
    }),
  };
}

// Pool de conexiones parametrizado por variables de entorno.
// Nunca se concatenan strings SQL: todas las queries usan placeholders ($1, $2, ...).
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: sslOptions(),
});

module.exports = pool;

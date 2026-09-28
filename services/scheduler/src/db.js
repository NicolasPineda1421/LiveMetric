const { Pool } = require('pg');

// Pool de conexiones parametrizado por variables de entorno.
// Nunca se concatenan strings SQL: todas las queries usan placeholders ($1, $2, ...).
//
// Sin TLS a propósito: la base es el contenedor "postgres" de la misma
// instalación, alcanzable solo por la red interna "db-net" (ver
// docker-compose.yml), así que la conexión nunca sale de la máquina.
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
});

module.exports = pool;

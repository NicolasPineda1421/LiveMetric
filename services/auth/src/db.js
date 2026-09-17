const { Pool } = require('pg');

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
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

module.exports = pool;

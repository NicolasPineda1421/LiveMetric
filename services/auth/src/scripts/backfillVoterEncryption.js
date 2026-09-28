// Cifra a mano el padrón que esté en texto plano (ver ../voterBackfill.js).
// Normalmente no hace falta: auth-service lo hace solo al arrancar. Queda
// para migrar datos cargados por fuera de la aplicación, o para verlo fila
// por fila. Es seguro correrlo más de una vez.
//
// Uso: docker compose run --rm auth-service node src/scripts/backfillVoterEncryption.js
require('dotenv').config();
const pool = require('../db');
const { encryptPlaintextVoters } = require('../voterBackfill');

(async () => {
  const changed = await encryptPlaintextVoters(pool, console.log);
  console.log(`Listo. ${changed} fila(s) cifradas (el resto ya estaba cifrado, o no tenía valor).`);
  await pool.end();
})().catch((err) => {
  console.error('Falló el script:', err.message);
  process.exit(1);
});

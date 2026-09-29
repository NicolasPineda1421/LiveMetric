const { encryptField, decryptField } = require('./voterCrypto');

// Cifra en el sitio los valores de "voters.cedula/polling_place/voting_table"
// que todavía estén en texto plano (ver voterCrypto.js). Hace falta porque
// db/init.sql siembra el padrón de demostración sin cifrar: ese SQL no conoce
// VOTERS_ENCRYPTION_KEY, que se genera por instalación.
//
// Lo corre auth-service al arrancar (index.js) y también se puede correr a
// mano (scripts/backfillVoterEncryption.js). Es seguro repetirlo, incluso
// desde dos réplicas a la vez: antes de cifrar un valor intenta descifrarlo
// con la clave actual (si puede, ya estaba cifrado y no se toca), y el
// cifrado es determinístico, así que dos procesos que cifran la misma fila
// escriben exactamente el mismo valor.
const COLUMNS = ['cedula', 'polling_place', 'voting_table'];

function isAlreadyEncrypted(value) {
  try {
    decryptField(value);
    return true;
  } catch {
    return false;
  }
}

// Devuelve cuántas filas cifró. Solo abre una transacción para las filas
// que tienen algo sin cifrar: con el padrón ya migrado, es una sola lectura.
async function encryptPlaintextVoters(pool, log = () => {}) {
  const { rows } = await pool.query('SELECT id, cedula, polling_place, voting_table FROM voters ORDER BY id');
  let changed = 0;
  for (const row of rows) {
    // eslint-disable-next-line security/detect-object-injection -- column sale de COLUMNS, la lista fija de arriba
    const pending = COLUMNS.filter((column) => row[column] && !isAlreadyEncrypted(row[column]));
    if (!pending.length) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const column of pending) {
        // eslint-disable-next-line security/detect-object-injection -- column sale de COLUMNS, la lista fija de arriba
        await client.query(`UPDATE voters SET ${column} = $1 WHERE id = $2`, [encryptField(row[column]), row.id]);
      }
      await client.query('COMMIT');
      changed += 1;
      log(`  id=${row.id}: cifrado`);
    } catch (err) {
      await client.query('ROLLBACK');
      log(`  id=${row.id}: ERROR — ${err.message}`);
    } finally {
      client.release();
    }
  }
  return changed;
}

module.exports = { encryptPlaintextVoters };

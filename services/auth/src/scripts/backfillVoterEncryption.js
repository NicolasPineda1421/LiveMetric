// Migración de datos (se corre UNA sola vez, a mano): re-escribe
// "voters.cedula/polling_place/voting_table" de texto plano a cifrado (ver
// ../voterCrypto.js). Requiere que las columnas ya estén ensanchadas a TEXT
// (db/migrations/004_encrypt_voter_pii.sql) y que VOTERS_ENCRYPTION_KEY ya
// esté configurada en el entorno.
//
// Es seguro correrlo más de una vez: antes de cifrar cada valor intenta
// descifrarlo con la clave actual; si eso funciona, ya estaba migrado y se
// deja tal cual (evita cifrar dos veces por accidente, lo cual dejaría el
// valor irrecuperable).
require('dotenv').config();
const pool = require('../db');
const { encryptField, decryptField } = require('../voterCrypto');

function isAlreadyEncrypted(value) {
  try {
    decryptField(value);
    return true;
  } catch {
    return false;
  }
}

async function migrateColumn(client, id, column, plainValue) {
  if (plainValue === null || plainValue === '') return false;
  if (isAlreadyEncrypted(plainValue)) return false;
  await client.query(`UPDATE voters SET ${column} = $1 WHERE id = $2`, [encryptField(plainValue), id]);
  return true;
}

(async () => {
  const { rows } = await pool.query('SELECT id, cedula, polling_place, voting_table FROM voters ORDER BY id');
  console.log(`Migrando ${rows.length} votante(s)...`);

  let changed = 0;
  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const a = await migrateColumn(client, row.id, 'cedula', row.cedula);
      const b = await migrateColumn(client, row.id, 'polling_place', row.polling_place);
      const c = await migrateColumn(client, row.id, 'voting_table', row.voting_table);
      await client.query('COMMIT');
      if (a || b || c) {
        changed += 1;
        console.log(`  id=${row.id}: migrado`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  id=${row.id}: ERROR — ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`Listo. ${changed} fila(s) cifradas (el resto ya estaba cifrado, o no tenía valor).`);
  await pool.end();
})().catch((err) => {
  console.error('Fallo el script de migración:', err);
  process.exit(1);
});

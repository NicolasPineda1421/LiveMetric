// LiveMetric — DEMOSTRACIÓN del ataque de la amenaza 15 del modelo STRIDE:
// alguien con acceso total a la base altera un acta certificada y rehace
// toda la cadena de hashes para que "cuadre". Sirve para mostrar, en vivo,
// que el sistema lo detecta igual: la firma Ed25519 no se puede rehacer sin
// la clave privada, y el reconteo no coincide con los votos guardados.
//
// ⚠ SOLO en una instalación de demostración. El cambio es PERMANENTE: la
// tabla de actas es append-only, y ni este script ni el sistema pueden
// deshacerlo. Para volver a empezar: docker compose down -v (borra la base).
//
// Corre dentro del contenedor de Analytics a propósito: tiene acceso a la
// base y el mismo cálculo de hashes que Scrutiny, pero solo la clave
// PÚBLICA. Es el atacante del modelo: tiene la base y el código, no la
// clave privada, que vive solo en el contenedor de Scrutiny.
//
// Uso, desde la raíz del repo y con el stack levantado:
//   docker compose exec -T analytics-service node - <id-de-la-eleccion> < scripts/demo/alterar-acta.js
'use strict';

const pool = require('/app/src/db');
const { GENESIS_HASH, computeRecordHash } = require('/app/src/hashChain');

const electionId = Number(process.argv[2]);

async function main() {
  if (!Number.isInteger(electionId) || electionId < 1) {
    throw new Error('Falta el id de la elección: node - <id> < scripts/demo/alterar-acta.js');
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM scrutiny_ledger WHERE election_id = $1', [electionId]);
    if (!rows.length) throw new Error(`La elección ${electionId} todavía no tiene acta certificada.`);
    const acta = rows[0];

    // 1. El camino directo: la base lo rechaza.
    try {
      await client.query('UPDATE scrutiny_ledger SET total_votes = total_votes WHERE id = $1', [acta.id]);
      console.log('1. UPDATE directo: ¡aceptado! (el trigger append-only no está activo)');
    } catch (err) {
      console.log(`1. UPDATE directo sobre el acta: rechazado por la base ("${err.message}").`);
    }

    // 2. Con permisos de dueño de la tabla, el atacante apaga el trigger.
    const opciones = [...acta.results.overall].sort((a, b) => b.votes - a.votes);
    if (opciones.length < 2 || opciones[0].votes === 0) {
      throw new Error('El acta necesita al menos dos opciones y algún voto para dar vuelta el resultado.');
    }
    const [primera, segunda] = opciones;
    const movidos = Math.min(primera.votes, Math.floor((primera.votes - segunda.votes) / 2) + 1);

    await client.query('BEGIN');
    await client.query('ALTER TABLE scrutiny_ledger DISABLE TRIGGER trg_scrutiny_no_update');
    console.log('2. Con permisos de dueño de la tabla: trigger append-only desactivado.');

    // 3. Da vuelta el resultado: mueve votos de la primera a la segunda.
    const results = structuredClone(acta.results);
    const buscar = (id) => results.overall.find((o) => o.optionId === id);
    buscar(primera.optionId).votes -= movidos;
    buscar(segunda.optionId).votes += movidos;
    const ganadora = buscar(segunda.optionId);
    results.winner = {
      optionId: ganadora.optionId,
      candidateNumber: ganadora.candidateNumber,
      label: ganadora.label,
      votes: ganadora.votes,
      tie: false,
      tiedWith: [],
    };
    console.log(`3. ${movidos} voto(s) pasan de "${primera.label}" a "${segunda.label}": ahora gana "${ganadora.label}".`);

    // 4. Rehace el hash de esta acta y de todas las siguientes, para que la
    //    cadena vuelva a cuadrar. La firma no la puede rehacer: no tiene la
    //    clave privada, así que deja la que estaba.
    const cadena = await client.query('SELECT * FROM scrutiny_ledger WHERE id >= $1 ORDER BY id', [acta.id]);
    const anterior = await client.query('SELECT record_hash FROM scrutiny_ledger WHERE id < $1 ORDER BY id DESC LIMIT 1', [acta.id]);
    let previousHash = anterior.rows[0]?.record_hash || GENESIS_HASH;
    for (const fila of cadena.rows) {
      const suyos = fila.id === acta.id ? results : fila.results;
      const recordHash = computeRecordHash({
        previousHash,
        electionId: fila.election_id,
        totalVotes: fila.total_votes,
        results: suyos,
      });
      await client.query('UPDATE scrutiny_ledger SET results = $1, previous_hash = $2, record_hash = $3 WHERE id = $4', [
        suyos,
        previousHash,
        recordHash,
        fila.id,
      ]);
      previousHash = recordHash;
    }
    console.log(`4. Hashes recalculados: el acta y ${cadena.rows.length - 1} acta(s) siguientes. La cadena vuelve a cuadrar.`);

    await client.query('ALTER TABLE scrutiny_ledger ENABLE TRIGGER trg_scrutiny_no_update');
    await client.query('COMMIT');
    console.log('5. Trigger reactivado, sin rastro en la tabla. Ahora consulta la elección en Resultados o en Escrutinio.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`No se alteró nada: ${err.message}`);
  process.exit(1);
});

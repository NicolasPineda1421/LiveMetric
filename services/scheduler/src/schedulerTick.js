const nodeFetch = require('node-fetch');
const pool = require('./db');

// Extraído de index.js para poder testear la lógica del tick sin arrancar el
// servidor Express, el cron real, ni requerir un scrutiny-service real
// corriendo (el test mockea "fetch" y le pasa un pool/fetch inyectados).
//
//   1) Activa elecciones cuya scheduled_start ya llegó ("scheduled" -> "active")
//   2) Cierra elecciones cuya scheduled_end ya pasó ("active" -> "closed")
//   3) Recoge también cualquier elección ya "closed" que aún no tenga acta
//      (por ejemplo, una detenida manualmente por un admin vía
//      POST /admin/elections/:id/stop en Voting, que cierra la elección fuera
//      de este worker) — así la certificación queda centralizada en un solo
//      lugar sin importar CÓMO se cerró la elección.
//   4) Por cada elección pendiente de certificar, solicita al servicio de
//      Escrutinio que la certifique (recuento independiente + hash).
async function runSchedulerTick({
  dbPool = pool,
  fetchImpl = nodeFetch,
  scrutinyUrl = process.env.SCRUTINY_INTERNAL_URL,
  internalToken = process.env.INTERNAL_SERVICE_TOKEN,
} = {}) {
  const summary = { activated: 0, closed: 0, pendingCertification: 0, certifyErrors: 0 };
  const client = await dbPool.connect();

  try {
    const activated = await client.query(
      `UPDATE elections
          SET status = 'active'
        WHERE status = 'scheduled'
          AND now() >= scheduled_start
          AND now() < scheduled_end
        RETURNING id`
    );
    summary.activated = activated.rowCount;

    const closed = await client.query(
      `UPDATE elections
          SET status = 'closed'
        WHERE status IN ('scheduled', 'active')
          AND now() >= scheduled_end
        RETURNING id`
    );
    summary.closed = closed.rowCount;

    const uncertified = await client.query(
      `SELECT id FROM elections
        WHERE status = 'closed'
          AND id NOT IN (SELECT election_id FROM scrutiny_ledger)`
    );
    summary.pendingCertification = uncertified.rowCount;

    for (const row of uncertified.rows) {
      const electionId = row.id;
      try {
        const resp = await fetchImpl(`${scrutinyUrl}/internal/certify/${electionId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': internalToken,
          },
        });
        if (!resp.ok) {
          throw new Error(`scrutiny-service respondió ${resp.status}`);
        }
        console.log(`[scheduler-worker] Elección ${electionId} certificada correctamente.`);
      } catch (err) {
        summary.certifyErrors += 1;
        console.error(`[scheduler-worker] Error certificando elección ${electionId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler-worker] Error en el tick del scheduler:', err.message);
  } finally {
    client.release();
  }

  return summary;
}

module.exports = { runSchedulerTick };

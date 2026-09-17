require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const pool = require('./db');

const PORT = process.env.PORT || 3005;
const SCRUTINY_URL = process.env.SCRUTINY_INTERNAL_URL; // ej. http://scrutiny-service:3004
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const CRON_EXPRESSION = process.env.SCHEDULER_CRON || '* * * * *'; // cada minuto por defecto

if (!SCRUTINY_URL || !INTERNAL_SERVICE_TOKEN) {
  console.error('FATAL: SCRUTINY_INTERNAL_URL y INTERNAL_SERVICE_TOKEN son obligatorios.');
  process.exit(1);
}

// -----------------------------------------------------------------------
// Este proceso NO expone lógica de negocio por HTTP hacia el público; el
// pequeño servidor Express de abajo solo sirve para exponer /health, algo
// que Docker y Kubernetes necesitan para verificar que el worker sigue vivo.
// -----------------------------------------------------------------------
const app = express();
let lastRunAt = null;
let lastRunSummary = null;

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'scheduler', lastRunAt, lastRunSummary })
);

app.listen(PORT, () => console.log(`[scheduler-worker] healthcheck escuchando en puerto ${PORT}`));

// -----------------------------------------------------------------------
// Job principal: se ejecuta según CRON_EXPRESSION.
//   1) Activa elecciones cuya scheduled_start ya llegó ("scheduled" -> "active")
//   2) Cierra elecciones cuya scheduled_end ya pasó ("active" -> "closed")
//   3) Recoge también cualquier elección ya "closed" que aún no tenga acta
//      (por ejemplo, una detenida manualmente por un admin vía
//      POST /admin/elections/:id/stop en Voting, que cierra la elección fuera
//      de este worker) — así la certificación queda centralizada en un solo
//      lugar sin importar CÓMO se cerró la elección.
//   4) Por cada elección pendiente de certificar, solicita al servicio de
//      Escrutinio que la certifique (recuento independiente + hash).
// -----------------------------------------------------------------------
async function runSchedulerTick() {
  const summary = { activated: 0, closed: 0, pendingCertification: 0, certifyErrors: 0 };
  const client = await pool.connect();

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

    // Elecciones "closed" (por tiempo en este mismo tick, o detenidas
    // manualmente en cualquier momento) que todavía no tienen acta.
    const uncertified = await client.query(
      `SELECT id FROM elections
        WHERE status = 'closed'
          AND id NOT IN (SELECT election_id FROM scrutiny_ledger)`
    );
    summary.pendingCertification = uncertified.rowCount;

    for (const row of uncertified.rows) {
      const electionId = row.id;
      try {
        const resp = await fetch(`${SCRUTINY_URL}/internal/certify/${electionId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': INTERNAL_SERVICE_TOKEN,
          },
        });
        if (!resp.ok) {
          throw new Error(`scrutiny-service respondió ${resp.status}`);
        }
        console.log(`[scheduler-worker] Elección ${electionId} certificada correctamente.`);
      } catch (err) {
        summary.certifyErrors += 1;
        // No relanzamos: un fallo de certificación de una elección no debe
        // bloquear el cierre/certificación de las demás en este tick. Si
        // sigue sin acta, el siguiente tick (máx. ~1 minuto) lo reintentará.
        console.error(`[scheduler-worker] Error certificando elección ${electionId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler-worker] Error en el tick del scheduler:', err.message);
  } finally {
    client.release();
    lastRunAt = new Date().toISOString();
    lastRunSummary = summary;
    console.log(`[scheduler-worker] Tick completado:`, summary);
  }
}

cron.schedule(CRON_EXPRESSION, runSchedulerTick);
console.log(`[scheduler-worker] Programado con expresión cron "${CRON_EXPRESSION}"`);

// Ejecuta un primer tick inmediatamente al arrancar, sin esperar al próximo minuto.
runSchedulerTick();

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { param, validationResult } = require('express-validator');
const pool = require('./db');
const { requireAuth } = require('./middleware/auth');
const { requireInternalToken } = require('./middleware/internalAuth');
const { GENESIS_HASH, computeRecordHash } = require('./hashChain');
const { streamActaPdf } = require('./actaPdf');

const app = express();
const PORT = process.env.PORT || 3004;

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '10kb' }));

const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const internalLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'scrutiny' }));

/* ============================================================
 * ENDPOINT INTERNO — solo accesible desde scheduler-service
 * ============================================================ */

// Certifica el resultado final de una elección ya cerrada. Es idempotente:
// si ya existe un acta para esa elección, no la vuelve a crear (evita
// duplicados si el worker reintenta el mismo tick).
app.post(
  '/internal/certify/:electionId',
  requireInternalToken,
  internalLimiter,
  [param('electionId').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'electionId inválido' });
    }

    const { electionId } = req.params;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Bloqueo a nivel de fila para evitar que dos certificaciones
      // concurrentes del mismo election (ej. reintento del worker) generen
      // dos actas distintas con distinto previous_hash.
      await client.query('LOCK TABLE scrutiny_ledger IN SHARE ROW EXCLUSIVE MODE');

      const already = await client.query(
        'SELECT id FROM scrutiny_ledger WHERE election_id = $1',
        [electionId]
      );
      if (already.rows.length > 0) {
        await client.query('COMMIT');
        return res.status(200).json({ message: 'La elección ya estaba certificada', electionId });
      }

      const electionCheck = await client.query(
        `SELECT id, status FROM elections WHERE id = $1`,
        [electionId]
      );
      if (electionCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Elección no encontrada' });
      }
      if (electionCheck.rows[0].status !== 'closed') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Solo se certifican elecciones ya cerradas' });
      }

      // Recuento INDEPENDIENTE directamente desde los votos crudos. No
      // reutiliza ninguna consulta ni caché de Analytics: si Analytics
      // tuviera un error o alguien manipulara esa capa, este recuento
      // paralelo seguiría reflejando la verdad de la tabla "votes".
      //
      // 1) Conteo GLOBAL por candidato/opción (lo de siempre).
      const overallTally = await client.query(
        `SELECT po.id AS option_id, po.label, po.candidate_number, po.logo,
                COUNT(v.id)::int AS votes
           FROM election_options po
           LEFT JOIN votes v ON v.option_id = po.id
          WHERE po.election_id = $1
          GROUP BY po.id, po.label, po.candidate_number, po.logo
          ORDER BY po.id ASC`,
        [electionId]
      );

      const overall = overallTally.rows.map((r) => ({
        optionId: r.option_id,
        candidateNumber: r.candidate_number,
        label: r.label,
        logo: r.logo,
        votes: r.votes,
      }));
      const totalVotes = overall.reduce((sum, r) => sum + r.votes, 0);

      // 2) Conteo por MESA de votación: consolida cuántos votos sacó cada
      //    candidato en cada mesa, y cuántos votos tuvo esa mesa en total.
      //    Se arma en dos pasadas: (a) una fila por (mesa, opción) desde SQL,
      //    (b) se agrupa aquí en JS por mesa, para producir el acta anidada.
      const byTableRows = await client.query(
        `SELECT v.polling_place, v.voting_table,
                po.id AS option_id, po.label, po.candidate_number,
                COUNT(v.id)::int AS votes
           FROM votes v
           JOIN election_options po ON po.id = v.option_id
          WHERE v.election_id = $1
          GROUP BY v.polling_place, v.voting_table, po.id, po.label, po.candidate_number
          ORDER BY v.polling_place ASC, v.voting_table ASC, po.id ASC`,
        [electionId]
      );

      const tableMap = new Map(); // key: `${pollingPlace}|${votingTable}`
      for (const row of byTableRows.rows) {
        const key = `${row.polling_place}|${row.voting_table}`;
        if (!tableMap.has(key)) {
          tableMap.set(key, {
            pollingPlace: row.polling_place,
            votingTable: row.voting_table,
            totalVotes: 0,
            results: [],
          });
        }
        const entry = tableMap.get(key);
        entry.results.push({
          optionId: row.option_id,
          candidateNumber: row.candidate_number,
          label: row.label,
          votes: row.votes,
        });
        entry.totalVotes += row.votes;
      }
      const byTable = Array.from(tableMap.values());

      // 3) Determinar el candidato/opción ganador por mayoría simple sobre
      //    el conteo GLOBAL (no por mesa). Si dos o más quedan empatados en
      //    el máximo, se reportan todos como empatados en vez de elegir uno
      //    arbitrariamente.
      let winner = null;
      if (totalVotes > 0) {
        const maxVotes = Math.max(...overall.map((r) => r.votes));
        const leaders = overall.filter((r) => r.votes === maxVotes);
        const isTie = leaders.length > 1;
        winner = {
          optionId: leaders[0].optionId,
          candidateNumber: leaders[0].candidateNumber,
          label: leaders[0].label,
          votes: leaders[0].votes,
          tie: isTie,
          tiedWith: isTie ? leaders.slice(1).map((l) => ({ optionId: l.optionId, label: l.label })) : [],
        };
      }

      const results = { overall, byTable, winner };

      const lastRecord = await client.query(
        'SELECT record_hash FROM scrutiny_ledger ORDER BY id DESC LIMIT 1'
      );
      const previousHash = lastRecord.rows[0]?.record_hash || GENESIS_HASH;

      const recordHash = computeRecordHash({ previousHash, electionId, totalVotes, results });

      await client.query(
        `INSERT INTO scrutiny_ledger (election_id, total_votes, results, previous_hash, record_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [electionId, totalVotes, JSON.stringify(results), previousHash, recordHash]
      );

      await client.query('COMMIT');
      console.log(`[scrutiny-service] Elección ${electionId} certificada. hash=${recordHash}`);
      return res.status(201).json({ electionId, totalVotes, recordHash, previousHash, winner });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error en /internal/certify:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }
  }
);

/* ============================================================
 * ENDPOINTS DE CONSULTA — requieren JWT de administrador
 * ============================================================ */

app.get(
  '/certifications/:electionId',
  requireAuth,
  readLimiter,
  [param('electionId').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'electionId inválido' });
    }
    try {
      const record = await pool.query(
        `SELECT election_id, total_votes, results, previous_hash, record_hash, certified_at
           FROM scrutiny_ledger WHERE election_id = $1`,
        [req.params.electionId]
      );
      if (record.rows.length === 0) {
        return res.status(404).json({ error: 'Esta elección aún no tiene acta de escrutinio' });
      }
      return res.status(200).json(record.rows[0]);
    } catch (err) {
      console.error('Error en /certifications/:electionId:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Genera el ACTA DE ESCRUTINIO en PDF: el mismo dato certificado en
// scrutiny_ledger, con formato de documento electoral oficial (resultados
// consolidados, ganador, desglose por mesa, hash de verificación y espacio
// de firmas). No recalcula nada: solo da forma imprimible al acta ya
// certificada, protegida por la misma cadena de hashes.
app.get(
  '/certifications/:electionId/acta.pdf',
  requireAuth,
  readLimiter,
  [param('electionId').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'electionId inválido' });
    }
    try {
      const certification = await pool.query(
        `SELECT election_id, total_votes, results, previous_hash, record_hash, certified_at
           FROM scrutiny_ledger WHERE election_id = $1`,
        [req.params.electionId]
      );
      if (certification.rows.length === 0) {
        return res.status(404).json({ error: 'Esta elección aún no tiene acta de escrutinio' });
      }

      const election = await pool.query('SELECT id, title FROM elections WHERE id = $1', [
        req.params.electionId,
      ]);
      if (election.rows.length === 0) {
        return res.status(404).json({ error: 'Elección no encontrada' });
      }

      streamActaPdf(res, { election: election.rows[0], certification: certification.rows[0] });
    } catch (err) {
      console.error('Error en /certifications/:electionId/acta.pdf:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Verifica la integridad de TODA la cadena de actas: recalcula cada
// record_hash desde cero (en el mismo orden en que se certificaron) y
// confirma que coincide con lo almacenado y que el encadenamiento
// previous_hash -> record_hash es consistente de principio a fin.
// Si alguien alteró una fila directamente en la base de datos (bypaseando
// el trigger de append-only, por ejemplo con un rol distinto), esta
// verificación lo detecta porque la cadena se rompe a partir de ese punto.
app.get('/verify', requireAuth, readLimiter, async (_req, res) => {
  try {
    const records = await pool.query(
      `SELECT election_id, total_votes, results, previous_hash, record_hash, certified_at
         FROM scrutiny_ledger ORDER BY id ASC`
    );

    let expectedPrevious = GENESIS_HASH;
    const brokenAt = [];

    for (const row of records.rows) {
      const recomputed = computeRecordHash({
        previousHash: row.previous_hash,
        electionId: row.election_id,
        totalVotes: row.total_votes,
        results: row.results,
      });

      const chainOk = row.previous_hash === expectedPrevious;
      const hashOk = recomputed === row.record_hash;

      if (!chainOk || !hashOk) {
        brokenAt.push({ electionId: row.election_id, chainOk, hashOk });
      }
      expectedPrevious = row.record_hash;
    }

    const isValid = brokenAt.length === 0;
    return res.status(200).json({
      valid: isValid,
      totalRecords: records.rows.length,
      brokenAt: isValid ? [] : brokenAt,
    });
  } catch (err) {
    console.error('Error en /verify:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.listen(PORT, () => console.log(`[scrutiny-service] escuchando en puerto ${PORT}`));

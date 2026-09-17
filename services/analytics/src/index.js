require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { param, validationResult } = require('express-validator');
const pool = require('./db');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3003;

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '5kb' }));

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'analytics' }));

// Todas las rutas de datos requieren JWT válido de un administrador.
app.use('/api', requireAuth, readLimiter);

app.get('/api/elections/:id/results', [param('id').isInt({ min: 1 }).toInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'id de elección inválido' });
  }

  try {
    const pollInfo = await pool.query(
      `SELECT status, scheduled_start, scheduled_end FROM elections WHERE id = $1`,
      [req.params.id]
    );
    if (pollInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Elección no encontrada' });
    }
    const { status, scheduled_start, scheduled_end } = pollInfo.rows[0];

    if (status === 'closed') {
      // Elección cerrada: se sirve el acta CERTIFICADA por scrutiny-service
      // (recuento independiente + hash), no un recálculo en vivo. Así el
      // dashboard nunca muestra un número distinto al oficialmente certificado.
      const certification = await pool.query(
        `SELECT total_votes, results, record_hash, previous_hash, certified_at
           FROM scrutiny_ledger WHERE election_id = $1`,
        [req.params.id]
      );
      if (certification.rows.length === 0) {
        return res.status(202).json({
          electionId: req.params.id,
          status,
          message: 'La elección cerró pero aún no ha sido certificada por el módulo de escrutinio',
        });
      }
      const cert = certification.rows[0];
      // "results" en scrutiny_ledger es un objeto enriquecido
      // {overall, byTable, winner} (ver scrutiny-service). Se desempaqueta
      // aquí para que el frontend reciba cada pieza ya lista de usar.
      return res.status(200).json({
        electionId: req.params.id,
        status,
        certified: true,
        totalVotes: cert.total_votes,
        results: cert.results.overall,
        byTable: cert.results.byTable,
        winner: cert.results.winner,
        recordHash: cert.record_hash,
        previousHash: cert.previous_hash,
        certifiedAt: cert.certified_at,
      });
    }

    // Elección "scheduled" o "active": resultados en vivo, recalculados en
    // cada consulta. Query parametrizada con JOIN + agregación; nunca se
    // interpola el id del usuario.
    const result = await pool.query(
      `SELECT po.id AS option_id, po.label, po.candidate_number, po.logo,
              COUNT(v.id)::int AS votes
       FROM election_options po
       LEFT JOIN votes v ON v.option_id = po.id
       WHERE po.election_id = $1
       GROUP BY po.id, po.label, po.candidate_number, po.logo
       ORDER BY votes DESC`,
      [req.params.id]
    );
    return res.status(200).json({
      electionId: req.params.id,
      status,
      certified: false,
      scheduledStart: scheduled_start,
      scheduledEnd: scheduled_end,
      results: result.rows.map((r) => ({
        optionId: r.option_id,
        candidateNumber: r.candidate_number,
        label: r.label,
        logo: r.logo,
        votes: r.votes,
      })),
    });
  } catch (err) {
    console.error('Error en /api/elections/:id/results:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/dashboard/summary', async (_req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
          (SELECT COUNT(*) FROM elections WHERE status = 'active') AS active_polls,
          (SELECT COUNT(*) FROM votes) AS total_votes`
    );
    return res.status(200).json(totals.rows[0]);
  } catch (err) {
    console.error('Error en /api/dashboard/summary:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.listen(PORT, () => console.log(`[analytics-service] escuchando en puerto ${PORT}`));

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env') });
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { param, query, body, validationResult } = require('express-validator');
const pool = require('./db');
const { requireRole } = require('./middleware/auth');
const { decryptField } = require('./voterCrypto');

const app = express();

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

// Todas las rutas de datos requieren JWT válido de admin o auditor (solo
// lectura). Las rutas de escritura (crear/editar/borrar tableros) exigen
// además `requireAdminOnly` puntualmente.
const requireReader = requireRole('admin', 'auditor');
const requireAdminOnly = requireRole('admin');
app.use('/api', requireReader, readLimiter);

// Cada ruta repetia el mismo try/catch (log con la ruta + 500 generico) y
// el mismo chequeo de validationResult (400 con un mensaje puntual). Estos
// dos helpers no cambian el comportamiento de ninguna ruta, solo evitan
// repetir ese boilerplate en cada una.
function asyncRoute(label, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`Error en ${label}:`, err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  };
}

function validateOr400(req, res, message) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: message });
    return false;
  }
  return true;
}

app.get('/api/elections/:id/results', [param('id').isInt({ min: 1 }).toInt()], asyncRoute('/api/elections/:id/results', async (req, res) => {
  if (!validateOr400(req, res, 'id de elección inválido')) return;

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
}));

/* ============================================================
 * MÉTRICAS — fuentes de datos para los widgets del builder de reportes
 * ============================================================ */

// Evolución de votos en el tiempo (para gráficos de línea).
app.get(
  '/api/elections/:id/metrics/timeseries',
  [
    param('id').isInt({ min: 1 }).toInt(),
    query('interval').optional().isIn(['hour', 'day']),
  ],
  asyncRoute('/api/elections/:id/metrics/timeseries', async (req, res) => {
    if (!validateOr400(req, res, 'Parámetros inválidos')) return;
    const interval = req.query.interval || 'hour';

    const result = await pool.query(
      `SELECT date_trunc($2, created_at) AS bucket, COUNT(*)::int AS votes
         FROM votes
        WHERE election_id = $1
        GROUP BY bucket
        ORDER BY bucket ASC`,
      [req.params.id, interval]
    );
    return res.status(200).json({
      electionId: req.params.id,
      interval,
      points: result.rows.map((r) => ({ bucket: r.bucket, votes: r.votes })),
    });
  })
);

// Participación por puesto de votación o por mesa: votos emitidos en esta
// elección vs. total de votantes activos del padrón en ese grupo.
app.get(
  '/api/elections/:id/metrics/participation',
  [
    param('id').isInt({ min: 1 }).toInt(),
    query('groupBy').optional().isIn(['polling_place', 'voting_table']),
  ],
  asyncRoute('/api/elections/:id/metrics/participation', async (req, res) => {
    if (!validateOr400(req, res, 'Parámetros inválidos')) return;
    // Whitelist explícito: el nombre de columna nunca viaja tal cual desde
    // el request hacia el SQL, solo el valor ya validado por el whitelist.
    const column = req.query.groupBy === 'voting_table' ? 'voting_table' : 'polling_place';

    // "voters.<column>" está cifrado (ver voterCrypto.js) pero
    // "votes.<column>" no (es un snapshot propio tomado al votar, fuera
    // del alcance del cifrado del padrón) — por eso ya no se puede hacer
    // el cruce en una sola consulta SQL comparando cifrado con texto
    // plano. Se agrupa cada lado por separado y se combina acá, tras
    // descifrar las etiquetas de "voters_grp".
    const [votersGrp, votesGrp] = await Promise.all([
      pool.query(
        `SELECT ${column} AS grp, COUNT(*)::int AS registered
           FROM voters
          WHERE is_active = true
          GROUP BY ${column}`
      ),
      pool.query(
        `SELECT ${column} AS grp, COUNT(*)::int AS votes_cast
           FROM votes
          WHERE election_id = $1
          GROUP BY ${column}`,
        [req.params.id]
      ),
    ]);

    const registeredByGroup = new Map();
    for (const row of votersGrp.rows) {
      const label = decryptField(row.grp);
      registeredByGroup.set(label, (registeredByGroup.get(label) || 0) + row.registered);
    }
    const votesCastByGroup = new Map(votesGrp.rows.map((r) => [r.grp, r.votes_cast]));

    const allLabels = new Set([...registeredByGroup.keys(), ...votesCastByGroup.keys()]);
    const groups = [...allLabels].sort().map((label) => ({
      group: label,
      registered: registeredByGroup.get(label) || 0,
      votesCast: votesCastByGroup.get(label) || 0,
    }));

    return res.status(200).json({ electionId: req.params.id, groupBy: column, groups });
  })
);

// Métricas operativas: ritmo de votación, progreso de la ventana de la
// elección y cobertura de mesas (cuántas ya registraron al menos un voto).
app.get(
  '/api/elections/:id/metrics/operational',
  [param('id').isInt({ min: 1 }).toInt()],
  asyncRoute('/api/elections/:id/metrics/operational', async (req, res) => {
    if (!validateOr400(req, res, 'id de elección inválido')) return;

    const pollInfo = await pool.query(
      `SELECT status, scheduled_start, scheduled_end FROM elections WHERE id = $1`,
      [req.params.id]
    );
    if (pollInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Elección no encontrada' });
    }
    const { status, scheduled_start, scheduled_end } = pollInfo.rows[0];

    const metrics = await pool.query(
      `SELECT
          (SELECT COUNT(*) FROM votes WHERE election_id = $1)::int AS total_votes,
          (SELECT COUNT(DISTINCT voting_table) FROM votes WHERE election_id = $1)::int AS tables_with_votes,
          (SELECT COUNT(DISTINCT voting_table) FROM voters WHERE is_active = true)::int AS total_tables,
          GREATEST(
            EXTRACT(EPOCH FROM (LEAST(now(), $3::timestamptz) - $2::timestamptz)) / 60.0,
            1
          ) AS elapsed_minutes`,
      [req.params.id, scheduled_start, scheduled_end]
    );
    const m = metrics.rows[0];

    return res.status(200).json({
      electionId: req.params.id,
      status,
      scheduledStart: scheduled_start,
      scheduledEnd: scheduled_end,
      totalVotes: m.total_votes,
      votesPerMinute: Number((m.total_votes / m.elapsed_minutes).toFixed(2)),
      tablesWithVotes: m.tables_with_votes,
      totalTables: m.total_tables,
    });
  })
);

// Eventos de auditoría asociados a esta elección (ver convención
// metadata->>'electionId' usada por voting-service al detener una elección).
app.get(
  '/api/elections/:id/metrics/audit',
  [param('id').isInt({ min: 1 }).toInt()],
  asyncRoute('/api/elections/:id/metrics/audit', async (req, res) => {
    if (!validateOr400(req, res, 'id de elección inválido')) return;

    const result = await pool.query(
      `SELECT id, event_type, actor_type, actor_ref, metadata, created_at
         FROM audit_log
        WHERE metadata ->> 'electionId' = $1
        ORDER BY id DESC
        LIMIT 200`,
      [String(req.params.id)]
    );
    return res.status(200).json({ electionId: req.params.id, events: result.rows });
  })
);

/* ============================================================
 * TABLEROS DE REPORTES — CRUD (builder tipo Power BI)
 * ============================================================ */

app.get(
  '/api/elections/:id/dashboards',
  [param('id').isInt({ min: 1 }).toInt()],
  asyncRoute('GET /api/elections/:id/dashboards', async (req, res) => {
    if (!validateOr400(req, res, 'id de elección inválido')) return;
    const result = await pool.query(
      `SELECT id, election_id AS "electionId", name, layout, created_by AS "createdBy",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM report_dashboards
        WHERE election_id = $1
        ORDER BY id DESC`,
      [req.params.id]
    );
    return res.status(200).json({ dashboards: result.rows });
  })
);

app.post(
  '/api/elections/:id/dashboards',
  requireAdminOnly,
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('name').trim().isLength({ min: 1, max: 120 }),
    body('layout').optional().isObject(),
  ],
  async (req, res) => {
    if (!validateOr400(req, res, 'Datos de tablero inválidos')) return;
    const layout = req.body.layout || { widgets: [] };

    try {
      const created = await pool.query(
        `INSERT INTO report_dashboards (election_id, name, layout, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, election_id AS "electionId", name, layout, created_by AS "createdBy",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [req.params.id, req.body.name, JSON.stringify(layout), req.user.sub]
      );
      return res.status(201).json(created.rows[0]);
    } catch (err) {
      if (err.code === '23503') {
        return res.status(404).json({ error: 'Elección no encontrada' });
      }
      console.error('Error en POST /api/elections/:id/dashboards:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

app.get(
  '/api/dashboards/:dashboardId',
  [param('dashboardId').isInt({ min: 1 }).toInt()],
  asyncRoute('GET /api/dashboards/:dashboardId', async (req, res) => {
    if (!validateOr400(req, res, 'id de tablero inválido')) return;
    const result = await pool.query(
      `SELECT id, election_id AS "electionId", name, layout, created_by AS "createdBy",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM report_dashboards
        WHERE id = $1`,
      [req.params.dashboardId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tablero no encontrado' });
    }
    return res.status(200).json(result.rows[0]);
  })
);

app.put(
  '/api/dashboards/:dashboardId',
  requireAdminOnly,
  [
    param('dashboardId').isInt({ min: 1 }).toInt(),
    body('name').trim().isLength({ min: 1, max: 120 }),
    body('layout').optional().isObject(),
  ],
  asyncRoute('PUT /api/dashboards/:dashboardId', async (req, res) => {
    if (!validateOr400(req, res, 'Datos de tablero inválidos')) return;
    const layout = req.body.layout || { widgets: [] };

    const updated = await pool.query(
      `UPDATE report_dashboards
          SET name = $1, layout = $2, updated_at = now()
        WHERE id = $3
        RETURNING id, election_id AS "electionId", name, layout, created_by AS "createdBy",
                  created_at AS "createdAt", updated_at AS "updatedAt"`,
      [req.body.name, JSON.stringify(layout), req.params.dashboardId]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Tablero no encontrado' });
    }
    return res.status(200).json(updated.rows[0]);
  })
);

app.delete(
  '/api/dashboards/:dashboardId',
  requireAdminOnly,
  [param('dashboardId').isInt({ min: 1 }).toInt()],
  asyncRoute('DELETE /api/dashboards/:dashboardId', async (req, res) => {
    if (!validateOr400(req, res, 'id de tablero inválido')) return;
    const deleted = await pool.query('DELETE FROM report_dashboards WHERE id = $1 RETURNING id', [
      req.params.dashboardId,
    ]);
    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'Tablero no encontrado' });
    }
    return res.status(204).send();
  })
);

app.get('/api/dashboard/summary', asyncRoute('/api/dashboard/summary', async (_req, res) => {
  const totals = await pool.query(
    `SELECT
        (SELECT COUNT(*) FROM elections WHERE status = 'active') AS active_polls,
        (SELECT COUNT(*) FROM votes) AS total_votes`
  );
  return res.status(200).json(totals.rows[0]);
}));

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

module.exports = app;

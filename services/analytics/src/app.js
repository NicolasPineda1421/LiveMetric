require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env') });
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { param, query, body, validationResult } = require('express-validator');
const pool = require('./db');
const { requireRole } = require('./middleware/auth');
const { decryptField } = require('./voterCrypto');
const { projectTurnout, leadTimeline, buildIntegrityReport, detectSuspiciousAccess } = require('./advancedStats');

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

/* ============================================================
 * ESTADÍSTICA — funciones puras reutilizadas por varios endpoints. Cada
 * una recibe solo los números que necesita (nunca datos identificables
 * de un votante) y no toca la base de datos.
 * ============================================================ */

// Índice de concentración de Herfindahl-Hirschman (escala 0-10000, igual
// que en su uso estándar en análisis de mercado): qué tan repartidos o
// concentrados quedan los votos entre las opciones. Umbrales adaptados de
// los mismos que usa la literatura de concentración de mercado.
function computeConcentration(results) {
  const total = results.reduce((sum, r) => sum + (r.votes || 0), 0);
  if (total === 0) return { hhi: 0, level: 'sin datos' };
  const hhi = results.reduce((sum, r) => {
    const share = (r.votes / total) * 100;
    return sum + share * share;
  }, 0);
  const rounded = Math.round(hhi);
  const level = rounded >= 2500 ? 'alta' : rounded >= 1500 ? 'moderada' : 'baja';
  return { hhi: rounded, level };
}

// Intervalo de confianza de Wilson al 95% para una proporción (más robusto
// que la aproximación normal simple para tamaños de muestra moderados o
// proporciones cercanas a 0%/100%, que es exactamente el caso de una
// elección con pocos votantes). Devuelve porcentajes (0-100).
function wilsonCi95(successes, n) {
  if (n <= 0) return { low: 0, high: 0 };
  const z = 1.96;
  // "p" debe quedar en [0, 1] para que la fórmula tenga sentido. En una
  // elección real nunca hay más votos que votantes registrados, pero se
  // acota igual por si esa invariante llegara a romperse (evita NaN por
  // una raíz cuadrada negativa si "successes" superara a "n").
  const p = Math.min(1, Math.max(0, successes / n));
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Number((Math.max(0, (center - margin) / denom) * 100).toFixed(1)),
    high: Number((Math.min(1, (center + margin) / denom) * 100).toFixed(1)),
  };
}

// Marca como "anómalo" un punto de la serie temporal cuyo puntaje Z
// (desviaciones estándar respecto al promedio de la propia serie) supera
// 2. Con menos de 4 puntos un desvío estándar no es confiable, así que no
// se marca nada — mejor no decir nada que decir algo estadísticamente
// vacío. Una marca aquí es una señal para revisar, no una acusación de
// fraude: un pico legítimo (ej. apertura de la elección) también puede
// superar el umbral.
function detectAnomalies(points) {
  if (points.length < 4) return [];
  const values = points.map((p) => p.votes);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return [];
  return points
    .map((p, i) => ({ bucket: p.bucket, votes: p.votes, zScore: Number(((values[i] - mean) / stdDev).toFixed(2)) }))
    .filter((p) => Math.abs(p.zScore) > 2);
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
      concentration: computeConcentration(cert.results.overall),
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
    concentration: computeConcentration(result.rows),
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
    const points = result.rows.map((r) => ({ bucket: r.bucket, votes: r.votes }));
    return res.status(200).json({
      electionId: req.params.id,
      interval,
      points,
      anomalies: detectAnomalies(points),
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
          (SELECT COUNT(*) FROM voters WHERE is_active = true)::int AS total_registered,
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
      // Acotado a 100%: una tasa por encima de eso solo puede significar
      // que hay más votos que votantes activos registrados (una
      // inconsistencia de datos, no un valor real de participación que
      // tenga sentido mostrar tal cual).
      participationRate: m.total_registered
        ? Number((Math.min(1, m.total_votes / m.total_registered) * 100).toFixed(1))
        : 0,
      participationCi95: wilsonCi95(m.total_votes, m.total_registered),
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
 * ESTADÍSTICA AVANZADA — la lógica vive en advancedStats.js (funciones
 * puras); estas rutas solo leen los datos ya agregados y se los pasan.
 * ============================================================ */

async function findElectionOr404(res, id) {
  const election = await pool.query(
    `SELECT status, scheduled_start, scheduled_end FROM elections WHERE id = $1`,
    [id]
  );
  if (election.rows.length === 0) {
    res.status(404).json({ error: 'Elección no encontrada' });
    return null;
  }
  return election.rows[0];
}

// Proyección de la participación final de una elección en curso, a partir
// de cómo se repartieron los votos en elecciones anteriores comparables (o
// del ritmo actual, si no hay historial). Ver projectTurnout.
app.get(
  '/api/elections/:id/metrics/turnout-projection',
  [param('id').isInt({ min: 1 }).toInt()],
  asyncRoute('/api/elections/:id/metrics/turnout-projection', async (req, res) => {
    if (!validateOr400(req, res, 'id de elección inválido')) return;
    const election = await findElectionOr404(res, req.params.id);
    if (!election) return;

    // Referencias: hasta 20 elecciones cerradas con al menos 20 votos. Las
    // detenidas a mano quedan afuera: su ventana real fue más corta que la
    // programada, así que su curva no es comparable.
    const [registered, current, history] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM voters WHERE is_active = true`),
      pool.query(
        `SELECT date_trunc('minute', created_at) AS minute, COUNT(*)::int AS votes
           FROM votes WHERE election_id = $1
          GROUP BY 1 ORDER BY 1`,
        [req.params.id]
      ),
      pool.query(
        `WITH comparable AS (
           SELECT e.id, e.scheduled_start, e.scheduled_end
             FROM elections e
            WHERE e.status = 'closed' AND NOT e.stopped_manually AND e.id <> $1
              AND (SELECT COUNT(*) FROM votes v WHERE v.election_id = e.id) >= 20
            ORDER BY e.scheduled_end DESC
            LIMIT 20
         )
         SELECT c.id, c.scheduled_start, c.scheduled_end,
                date_trunc('minute', v.created_at) AS minute, COUNT(*)::int AS votes
           FROM comparable c JOIN votes v ON v.election_id = c.id
          GROUP BY c.id, c.scheduled_start, c.scheduled_end, 4
          ORDER BY c.id, 4`,
        [req.params.id]
      ),
    ]);

    const byElection = new Map();
    for (const row of history.rows) {
      if (!byElection.has(row.id)) {
        byElection.set(row.id, { start: row.scheduled_start, end: row.scheduled_end, minuteCounts: [] });
      }
      byElection.get(row.id).minuteCounts.push({ minute: row.minute, votes: row.votes });
    }

    return res.status(200).json({
      electionId: req.params.id,
      status: election.status,
      scheduledStart: election.scheduled_start,
      scheduledEnd: election.scheduled_end,
      ...projectTurnout({
        status: election.status,
        start: election.scheduled_start,
        end: election.scheduled_end,
        now: new Date(),
        registered: registered.rows[0].n,
        minuteCounts: current.rows,
        history: [...byElection.values()],
      }),
    });
  })
);

// Momento de definición: cuántas veces cambió el primer lugar y desde
// cuándo lidera el que va primero. Ver leadTimeline.
app.get(
  '/api/elections/:id/metrics/lead-timeline',
  [param('id').isInt({ min: 1 }).toInt()],
  asyncRoute('/api/elections/:id/metrics/lead-timeline', async (req, res) => {
    if (!validateOr400(req, res, 'id de elección inválido')) return;
    const election = await findElectionOr404(res, req.params.id);
    if (!election) return;

    const [options, counts] = await Promise.all([
      pool.query(
        `SELECT id AS "optionId", label FROM election_options WHERE election_id = $1 ORDER BY id`,
        [req.params.id]
      ),
      pool.query(
        `SELECT date_trunc('minute', created_at) AS minute, option_id AS "optionId", COUNT(*)::int AS votes
           FROM votes WHERE election_id = $1
          GROUP BY 1, 2 ORDER BY 1`,
        [req.params.id]
      ),
    ]);

    return res.status(200).json({
      electionId: req.params.id,
      status: election.status,
      ...leadTimeline({
        options: options.rows,
        minuteCounts: counts.rows,
        start: election.scheduled_start,
        end: election.scheduled_end,
      }),
    });
  })
);

// Integridad del acta: recalcula la cadena de hashes del libro de
// escrutinio (independiente de scrutiny-service) y vuelve a contar los
// votos guardados contra lo que el acta certificó. Ver buildIntegrityReport.
app.get(
  '/api/elections/:id/metrics/integrity',
  [param('id').isInt({ min: 1 }).toInt()],
  asyncRoute('/api/elections/:id/metrics/integrity', async (req, res) => {
    if (!validateOr400(req, res, 'id de elección inválido')) return;
    const election = await findElectionOr404(res, req.params.id);
    if (!election) return;

    const [ledger, stored] = await Promise.all([
      pool.query(
        `SELECT election_id, total_votes, results, previous_hash, record_hash, certified_at
           FROM scrutiny_ledger ORDER BY id ASC`
      ),
      pool.query(
        `SELECT option_id, polling_place, voting_table, COUNT(*)::int AS votes
           FROM votes WHERE election_id = $1
          GROUP BY 1, 2, 3`,
        [req.params.id]
      ),
    ]);

    const byOption = new Map();
    const byTable = new Map();
    let totalVotes = 0;
    for (const row of stored.rows) {
      byOption.set(row.option_id, (byOption.get(row.option_id) || 0) + row.votes);
      const key = `${row.polling_place}|${row.voting_table}`;
      byTable.set(key, (byTable.get(key) || 0) + row.votes);
      totalVotes += row.votes;
    }

    return res.status(200).json({
      electionId: req.params.id,
      status: election.status,
      ...buildIntegrityReport({
        electionId: req.params.id,
        ledgerRows: ledger.rows,
        stored: { totalVotes, byOption, byTable },
      }),
    });
  })
);

// Accesos sospechosos durante la ventana de la elección: patrones de
// intentos de login fallidos que sugieren adivinar PINs o cédulas. Ver
// detectSuspiciousAccess (reglas y umbrales).
app.get(
  '/api/elections/:id/metrics/suspicious-access',
  [param('id').isInt({ min: 1 }).toInt()],
  asyncRoute('/api/elections/:id/metrics/suspicious-access', async (req, res) => {
    if (!validateOr400(req, res, 'id de elección inválido')) return;
    const election = await findElectionOr404(res, req.params.id);
    if (!election) return;

    const from = new Date(election.scheduled_start);
    const to = new Date(Math.min(Date.now(), new Date(election.scheduled_end).getTime()));
    const events = await pool.query(
      `SELECT event_type AS "eventType", actor_ref AS "actorRef", ip_address AS ip,
              metadata ->> 'reason' AS reason, created_at AS at
         FROM audit_log
        WHERE event_type IN ('LOGIN_SUCCESS_VOTER', 'LOGIN_FAILURE_VOTER', 'LOGIN_SUCCESS_ADMIN', 'LOGIN_FAILURE_ADMIN')
          AND created_at BETWEEN $1 AND $2
        ORDER BY created_at ASC
        LIMIT 50000`,
      [from, to]
    );

    return res.status(200).json({
      electionId: req.params.id,
      status: election.status,
      window: { from: from.toISOString(), to: to.toISOString() },
      ...detectSuspiciousAccess(from < to ? events.rows : []),
    });
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

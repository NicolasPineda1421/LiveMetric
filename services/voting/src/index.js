require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { param, body, validationResult } = require('express-validator');
const pool = require('./db');
const { requireAuth } = require('./middleware/auth');
const { requireVoter } = require('./middleware/voterAuth');

const app = express();
const PORT = process.env.PORT || 3002;

app.disable('x-powered-by');
app.set('trust proxy', 1); // necesario para req.ip correcto detrás de proxy/compose
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000' }));

// Las plantillas presidenciales llevan el logo de cada candidato como una
// imagen data-URI base64 embebida en el JSON, así que esa ruta necesita un
// límite de payload mucho mayor que el resto. Montar un parser específico
// para esa ruta ANTES del parser genérico hace que ese único endpoint use
// el límite alto; el resto de rutas (en especial /vote, que debe seguir
// siendo un payload minúsculo) usa el límite estricto de siempre.
app.use('/admin/templates', express.json({ limit: '3mb' }));
app.use(express.json({ limit: '5kb' })); // límite estricto por defecto: un voto es un payload pequeño

// Rate limiting para mitigar ataques de "ballot stuffing" / DoS por volumen
const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
});

// Rate limiting más laxo para operaciones de administración (autenticadas)
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'voting' }));

/* ============================================================
 * RUTAS PÚBLICAS / DE VOTANTE
 * ============================================================ */

app.post(
  '/vote',
  requireVoter,
  voteLimiter,
  [
    // Validación estricta de tipos: solo enteros positivos, previene inyección
    // y payloads malformados antes de que lleguen a la capa de base de datos.
    body('electionId').isInt({ min: 1 }).toInt(),
    body('optionId').isInt({ min: 1 }).toInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'electionId y optionId deben ser enteros válidos' });
    }

    const { electionId, optionId } = req.body;
    // Todo viene del JWT verificado, nunca de un campo del body: el votante
    // no puede declarar por sí mismo en qué mesa "dice" estar votando.
    const { voterIdHash, pollingPlace, votingTable } = req.voter;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) La elección debe existir, estar marcada "active" Y estar dentro de
      //    su ventana de tiempo real (now() BETWEEN scheduled_start AND
      //    scheduled_end). Se validan ambas cosas -status y timestamps- como
      //    defensa en profundidad: si el worker scheduler se retrasara en
      //    marcar el cierre, la comparación de tiempos igual bloquea el voto.
      const election = await client.query(
        `SELECT id, scheduled_start, scheduled_end
           FROM elections
          WHERE id = $1
            AND status = 'active'
            AND now() >= scheduled_start
            AND now() <= scheduled_end`,
        [electionId]
      );
      if (election.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'La elección no existe, aún no abre, ya cerró, ya fue detenida, o no está activa',
        });
      }

      // 2) La opción debe pertenecer a esa elección (evita votar por opciones de otra elección)
      const option = await client.query(
        'SELECT id FROM election_options WHERE id = $1 AND election_id = $2',
        [optionId, electionId]
      );
      if (option.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Opción inválida para esta elección' });
      }

      // 3) Inserción del voto. La restricción UNIQUE(election_id, voter_id_hash)
      //    en la base de datos es la barrera final contra el doble voto,
      //    anclada a la identidad real del votante. "polling_place" y
      //    "voting_table" quedan grabados en el voto para que el escrutinio
      //    pueda consolidar por mesa sin volver a tocar el padrón.
      await client.query(
        `INSERT INTO votes (election_id, option_id, voter_id_hash, polling_place, voting_table)
         VALUES ($1, $2, $3, $4, $5)`,
        [electionId, optionId, voterIdHash, pollingPlace, votingTable]
      );

      await client.query('COMMIT');
      return res.status(201).json({ message: 'Voto registrado correctamente' });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        // unique_violation -> ya votó en esta elección
        return res.status(409).json({ error: 'Ya se registró un voto para esta elección' });
      }
      console.error('Error en /vote:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }
  }
);

app.get(
  '/elections/:id/options',
  [param('id').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'id de elección inválido' });
    }
    try {
      const options = await pool.query(
        `SELECT po.id, po.label, po.candidate_number, po.logo,
                p.status, p.scheduled_start, p.scheduled_end
           FROM election_options po
           JOIN elections p ON p.id = po.election_id
          WHERE po.election_id = $1
          ORDER BY po.id ASC`,
        [req.params.id]
      );
      return res.status(200).json(options.rows);
    } catch (err) {
      console.error('Error en /elections/:id/options:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Descubrimiento público de elecciones votables en este momento. No requiere
// autenticación (no expone nada sensible: solo título, candidatos/opciones y
// ventana de tiempo), pero votar sí exige el JWT de votante.
app.get('/elections/active', async (_req, res) => {
  try {
    const elections = await pool.query(
      `SELECT id, title, scheduled_start, scheduled_end
         FROM elections
        WHERE status = 'active' AND now() BETWEEN scheduled_start AND scheduled_end
        ORDER BY scheduled_end ASC`
    );

    const results = [];
    for (const election of elections.rows) {
      const options = await pool.query(
        'SELECT id, label, candidate_number, logo FROM election_options WHERE election_id = $1 ORDER BY id ASC',
        [election.id]
      );
      results.push({ ...election, options: options.rows });
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error('Error en /elections/active:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ============================================================
 * RUTAS DE ADMINISTRACIÓN — requieren JWT de admin
 * ============================================================ */

// Crear una plantilla reutilizable. Dos formatos:
//  - "generic":       options es un arreglo de strings (pregunta libre).
//  - "presidential":  options es un arreglo de candidatos
//                     {candidateNumber, name, logo?} (formato de elección
//                     presidencial: número, nombre y logo/foto).
app.post(
  '/admin/templates',
  requireAuth,
  adminLimiter,
  [
    body('name').trim().isLength({ min: 3, max: 200 }).escape(),
    body('description').optional().trim().isLength({ max: 1000 }).escape(),
    body('templateType').optional().isIn(['generic', 'presidential']),
    body('options').isArray({ min: 2, max: 30 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos de plantilla inválidos', details: errors.array() });
    }

    const { name, description } = req.body;
    const templateType = req.body.templateType === 'presidential' ? 'presidential' : 'generic';
    const rawOptions = req.body.options;

    // Normaliza y valida cada opción según el tipo de plantilla, sin depender
    // de un esquema dinámico de express-validator (más simple de leer aquí).
    const normalizedOptions = [];
    for (const raw of rawOptions) {
      if (templateType === 'presidential') {
        if (typeof raw !== 'object' || raw === null) {
          return res.status(400).json({ error: 'Cada candidato debe ser un objeto {candidateNumber, name, logo?}' });
        }
        const candidateNumber = String(raw.candidateNumber ?? '').trim();
        const candidateName = String(raw.name ?? '').trim();
        const logo = raw.logo ? String(raw.logo) : null;

        if (!candidateNumber || candidateNumber.length > 10) {
          return res.status(400).json({ error: 'Número de candidato inválido' });
        }
        if (candidateName.length < 1 || candidateName.length > 150) {
          return res.status(400).json({ error: 'Nombre de candidato inválido' });
        }
        // ~1.4MB de base64 equivalen a ~1MB de imagen real; suficiente para
        // un logo/foto de candidato sin permitir archivos desproporcionados.
        if (logo && logo.length > 1_400_000) {
          return res.status(400).json({ error: `El logo del candidato "${candidateName}" es demasiado grande` });
        }
        normalizedOptions.push({ label: candidateName, candidateNumber, logo });
      } else {
        const label = String(raw ?? '').trim();
        if (!label || label.length > 150) {
          return res.status(400).json({ error: 'Cada opción debe ser un texto de hasta 150 caracteres' });
        }
        normalizedOptions.push({ label, candidateNumber: null, logo: null });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const template = await client.query(
        'INSERT INTO election_templates (name, description, template_type, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, description || null, templateType, req.user.sub]
      );
      const templateId = template.rows[0].id;

      for (const opt of normalizedOptions) {
        await client.query(
          'INSERT INTO template_options (template_id, label, candidate_number, logo) VALUES ($1, $2, $3, $4)',
          [templateId, opt.label, opt.candidateNumber, opt.logo]
        );
      }

      await client.query('COMMIT');
      return res.status(201).json({ templateId, name, templateType, optionsCount: normalizedOptions.length });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error en /admin/templates:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }
  }
);

app.get('/admin/templates', requireAuth, adminLimiter, async (_req, res) => {
  try {
    const templates = await pool.query(
      `SELECT t.id, t.name, t.description, t.template_type, t.created_at,
              json_agg(
                json_build_object(
                  'id', o.id,
                  'label', o.label,
                  'candidateNumber', o.candidate_number,
                  'logo', o.logo
                ) ORDER BY o.id
              ) AS options
         FROM election_templates t
         LEFT JOIN template_options o ON o.template_id = t.id
        GROUP BY t.id
        ORDER BY t.created_at DESC`
    );
    return res.status(200).json(templates.rows);
  } catch (err) {
    console.error('Error en GET /admin/templates:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Instanciar una elección a partir de una plantilla, con ventana de tiempo obligatoria.
// El estado inicial siempre es "scheduled": el worker "scheduler-service" es el
// único responsable de moverla a "active" y luego a "closed" según el reloj
// (o un admin puede detenerla manualmente antes, ver /admin/elections/:id/stop).
app.post(
  '/admin/elections',
  requireAuth,
  adminLimiter,
  [
    body('templateId').isInt({ min: 1 }).toInt(),
    body('title').trim().isLength({ min: 3, max: 200 }).escape(),
    body('scheduledStart').isISO8601().toDate(),
    body('scheduledEnd').isISO8601().toDate(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos de elección inválidos', details: errors.array() });
    }

    const { templateId, title, scheduledStart, scheduledEnd } = req.body;

    if (new Date(scheduledEnd) <= new Date(scheduledStart)) {
      return res.status(400).json({ error: 'scheduledEnd debe ser posterior a scheduledStart' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Snapshot de la plantilla en este momento: si luego se edita la
      // plantilla, esta elección ya instanciada no cambia retroactivamente.
      const templateOptions = await client.query(
        'SELECT id, label, candidate_number, logo FROM template_options WHERE template_id = $1',
        [templateId]
      );
      if (templateOptions.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Plantilla no encontrada o sin opciones' });
      }

      const election = await client.query(
        `INSERT INTO elections (title, template_id, status, scheduled_start, scheduled_end, created_by)
         VALUES ($1, $2, 'scheduled', $3, $4, $5)
         RETURNING id`,
        [title, templateId, scheduledStart, scheduledEnd, req.user.sub]
      );
      const electionId = election.rows[0].id;

      for (const opt of templateOptions.rows) {
        await client.query(
          'INSERT INTO election_options (election_id, label, candidate_number, logo) VALUES ($1, $2, $3, $4)',
          [electionId, opt.label, opt.candidate_number, opt.logo]
        );
      }

      await client.query('COMMIT');
      return res.status(201).json({
        electionId,
        title,
        status: 'scheduled',
        scheduledStart,
        scheduledEnd,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error en /admin/elections:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }
  }
);

// Lista TODAS las elecciones (cualquier estado), para el panel de administración.
app.get('/admin/elections', requireAuth, adminLimiter, async (_req, res) => {
  try {
    const elections = await pool.query(
      `SELECT p.id, p.title, p.status, p.scheduled_start, p.scheduled_end, p.stopped_manually,
              p.template_id, t.name AS template_name, t.template_type,
              (SELECT COUNT(*) FROM votes v
                 JOIN election_options po ON po.id = v.option_id
                WHERE po.election_id = p.id) AS vote_count
         FROM elections p
         LEFT JOIN election_templates t ON t.id = p.template_id
        ORDER BY p.created_at DESC`
    );
    return res.status(200).json(elections.rows);
  } catch (err) {
    console.error('Error en GET /admin/elections:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Detener una elección antes de su hora de cierre programada. Deja la
// elección en "closed" de inmediato (nadie más puede votar a partir de este
// instante) y ajusta scheduled_end al momento real de cierre, para que el
// acta de escrutinio refleje cuándo terminó de verdad la votación. La
// certificación no se dispara aquí directamente: scheduler-worker detecta,
// en su siguiente tick (máx. ~1 minuto), cualquier elección "closed" sin
// acta todavía y la certifica — el mismo mecanismo que usa para los cierres
// automáticos, sin duplicar la lógica de certificación en dos servicios.
app.post(
  '/admin/elections/:id/stop',
  requireAuth,
  adminLimiter,
  [param('id').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'id de elección inválido' });
    }

    try {
      const result = await pool.query(
        `UPDATE elections
            SET status = 'closed',
                stopped_manually = true,
                scheduled_end = LEAST(scheduled_end, now())
          WHERE id = $1
            AND status IN ('scheduled', 'active')
          RETURNING id, status, scheduled_end`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(409).json({ error: 'La elección no existe o ya estaba cerrada' });
      }

      await pool.query(
        `INSERT INTO audit_log (event_type, actor_type, actor_ref, ip_address, user_agent, metadata)
         VALUES ('POLL_STOPPED_MANUALLY', 'admin', $1, $2, $3, $4)`,
        [req.user.username, req.ip, req.headers['user-agent'] || null, JSON.stringify({ electionId: req.params.id })]
      );

      return res.status(200).json({
        message: 'Elección detenida. Se certificará automáticamente en menos de un minuto.',
        election: result.rows[0],
      });
    } catch (err) {
      console.error('Error en /admin/elections/:id/stop:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.listen(PORT, () => console.log(`[voting-service] escuchando en puerto ${PORT}`));

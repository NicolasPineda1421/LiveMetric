require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const pool = require('./db');
const { recordAuditEvent } = require('./audit');
const { requireAdmin } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const VOTER_JWT_EXPIRES_IN = process.env.VOTER_JWT_EXPIRES_IN || '10m';
const VOTER_ID_SALT = process.env.VOTER_ID_SALT;

if (!JWT_SECRET || !VOTER_ID_SALT) {
  // Falla rápido: nunca arrancar el servicio con un secreto ausente o vacío.
  console.error('FATAL: JWT_SECRET y VOTER_ID_SALT son obligatorios en el entorno.');
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
// CORS restringido explícitamente al origen del frontend (nunca "*"): el
// navegador del usuario corre en un puerto distinto (frontend :3000) al de
// esta API, así que el preflight CORS debe permitir ese origen puntual.
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '10kb' }));

// El login de votantes usa cédula como usuario Y contraseña (ver Manual de
// Seguridad): no hay secreto real que proteger con fuerza bruta, por lo que
// el rate limiting aquí es la principal barrera técnica contra el intento
// masivo de "adivinar" cédulas válidas. Se limita agresivamente por IP.
const voterLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo más tarde.' },
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Intenta de nuevo más tarde.' },
});

const adminOpsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// SHA-256(cedula + salt privado). Se calcula UNA vez aquí, al emitir el JWT
// de votante, y viaja dentro del token. Voting nunca ve la cédula ni conoce
// este salt: solo lee el hash ya calculado desde el token verificado.
function buildVoterIdHash(cedula) {
  return crypto.createHash('sha256').update(`${cedula}|${VOTER_ID_SALT}`).digest('hex');
}

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'auth' }));

/* ============================================================
 * LOGIN — ADMINISTRADOR (usuario + contraseña)
 * ============================================================ */

app.post(
  '/login/admin',
  adminLoginLimiter,
  [
    body('username').trim().isLength({ min: 3, max: 50 }).escape(),
    body('password').isLength({ min: 8, max: 128 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos de entrada inválidos' });
    }

    const { username, password } = req.body;
    const genericError = { error: 'Credenciales inválidas' };

    try {
      const result = await pool.query(
        'SELECT id, username, password_hash FROM admins WHERE username = $1',
        [username]
      );

      if (result.rows.length === 0) {
        await recordAuditEvent({
          eventType: 'LOGIN_FAILURE_ADMIN',
          actorType: 'admin',
          actorRef: username,
          req,
          metadata: { reason: 'usuario_no_encontrado' },
        });
        return res.status(401).json(genericError);
      }

      const admin = result.rows[0];
      const passwordMatches = await bcrypt.compare(password, admin.password_hash);

      if (!passwordMatches) {
        await recordAuditEvent({
          eventType: 'LOGIN_FAILURE_ADMIN',
          actorType: 'admin',
          actorRef: username,
          req,
          metadata: { reason: 'password_incorrecto' },
        });
        return res.status(401).json(genericError);
      }

      const token = jwt.sign(
        { sub: admin.id, username: admin.username, role: 'admin' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
      );

      await recordAuditEvent({
        eventType: 'LOGIN_SUCCESS_ADMIN',
        actorType: 'admin',
        actorRef: username,
        req,
      });

      return res.status(200).json({ token, expiresIn: JWT_EXPIRES_IN, role: 'admin' });
    } catch (err) {
      console.error('Error en /login/admin:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

/* ============================================================
 * LOGIN — VOTANTE (cédula como usuario Y contraseña)
 * ============================================================ */

app.post(
  '/login/voter',
  voterLoginLimiter,
  [
    body('cedula').trim().isLength({ min: 5, max: 20 }).matches(/^[0-9A-Za-z-]+$/),
    body('password').trim().isLength({ min: 5, max: 20 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Cédula inválida' });
    }

    const { cedula, password } = req.body;
    const voterIdHash = buildVoterIdHash(cedula);
    const genericError = { error: 'Cédula no encontrada en el padrón electoral o credenciales inválidas' };

    // Verificación explícita del requisito funcional: usuario y contraseña
    // deben ser exactamente el mismo valor (la cédula). No es un secreto:
    // es una confirmación de que el votante efectivamente conoce su propio
    // número de documento en ambos campos del formulario.
    if (cedula !== password) {
      await recordAuditEvent({
        eventType: 'LOGIN_FAILURE_VOTER',
        actorType: 'voter',
        actorRef: voterIdHash,
        req,
        metadata: { reason: 'usuario_y_password_no_coinciden' },
      });
      return res.status(401).json(genericError);
    }

    try {
      const result = await pool.query(
        'SELECT id, cedula, is_active, polling_place, voting_table FROM voters WHERE cedula = $1',
        [cedula]
      );

      if (result.rows.length === 0 || !result.rows[0].is_active) {
        await recordAuditEvent({
          eventType: 'LOGIN_FAILURE_VOTER',
          actorType: 'voter',
          actorRef: voterIdHash,
          req,
          metadata: { reason: 'no_encontrado_o_inactivo' },
        });
        return res.status(401).json(genericError);
      }

      const voter = result.rows[0];

      // El JWT lleva el puesto y mesa asignados (no son secretos: identifican
      // un lugar físico, no a la persona) para que Voting los copie a cada
      // voto emitido y el escrutinio pueda consolidar por mesa sin volver a
      // tocar la tabla "voters" ni la cédula.
      //
      // Token de vida MUY corta (por defecto 10 minutos): alcanza para
      // completar un voto, pero limita la ventana de uso indebido si el
      // token fuera interceptado o reutilizado.
      const token = jwt.sign(
        {
          sub: voter.id,
          role: 'voter',
          voterIdHash,
          pollingPlace: voter.polling_place,
          votingTable: voter.voting_table,
        },
        JWT_SECRET,
        { expiresIn: VOTER_JWT_EXPIRES_IN, algorithm: 'HS256' }
      );

      await recordAuditEvent({
        eventType: 'LOGIN_SUCCESS_VOTER',
        actorType: 'voter',
        actorRef: voterIdHash,
        req,
      });

      return res.status(200).json({
        token,
        expiresIn: VOTER_JWT_EXPIRES_IN,
        role: 'voter',
        pollingPlace: voter.polling_place,
        votingTable: voter.voting_table,
      });
    } catch (err) {
      console.error('Error en /login/voter:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

/* ============================================================
 * ADMINISTRACIÓN DE IDENTIDAD — requiere JWT de administrador
 * ============================================================ */

// Crear un nuevo usuario administrador.
app.post(
  '/admin/users',
  requireAdmin,
  adminOpsLimiter,
  [
    body('username').trim().isLength({ min: 3, max: 50 }).escape(),
    body('password').isLength({ min: 10, max: 128 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos inválidos (la contraseña debe tener al menos 10 caracteres)' });
    }

    const { username, password } = req.body;

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const created = await pool.query(
        'INSERT INTO admins (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
        [username, passwordHash]
      );

      await recordAuditEvent({
        eventType: 'ADMIN_USER_CREATED',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { newAdminUsername: username },
      });

      return res.status(201).json(created.rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
      }
      console.error('Error en /admin/users:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Carga masiva del padrón electoral. Se acepta un arreglo JSON de
// {cedula, fullName, pollingPlace, votingTable}; usa UPSERT (ON CONFLICT)
// para poder reintentar cargas parciales sin duplicar votantes ya existentes.
app.post(
  '/admin/voters/bulk',
  requireAdmin,
  adminOpsLimiter,
  [
    body('voters').isArray({ min: 1, max: 5000 }),
    body('voters.*.cedula').trim().isLength({ min: 5, max: 20 }).matches(/^[0-9A-Za-z-]+$/),
    body('voters.*.fullName').trim().isLength({ min: 3, max: 200 }).escape(),
    body('voters.*.pollingPlace').trim().isLength({ min: 2, max: 150 }).escape(),
    body('voters.*.votingTable').trim().isLength({ min: 1, max: 50 }).escape(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Formato de padrón inválido (falta puesto o mesa de votación)', details: errors.array() });
    }

    const { voters } = req.body;
    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;

    try {
      await client.query('BEGIN');

      for (const v of voters) {
        const result = await client.query(
          `INSERT INTO voters (cedula, full_name, polling_place, voting_table, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (cedula) DO UPDATE SET
             full_name = EXCLUDED.full_name,
             polling_place = EXCLUDED.polling_place,
             voting_table = EXCLUDED.voting_table
           RETURNING (xmax = 0) AS inserted`,
          [v.cedula, v.fullName, v.pollingPlace, v.votingTable, req.user.sub]
        );
        if (result.rows[0].inserted) inserted += 1;
        else updated += 1;
      }

      await client.query('COMMIT');

      await recordAuditEvent({
        eventType: 'VOTERS_BULK_UPLOADED',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { totalReceived: voters.length, inserted, updated },
      });

      return res.status(201).json({ totalReceived: voters.length, inserted, updated });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error en /admin/voters/bulk:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }
  }
);

// Consulta del padrón (paginada) — solo para verificación administrativa;
// nunca se expone al público ni a los propios votantes.
app.get('/admin/voters', requireAdmin, adminOpsLimiter, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const result = await pool.query(
      `SELECT id, cedula, full_name, polling_place, voting_table, is_active, created_at
         FROM voters
        ORDER BY id ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.status(200).json({ limit, offset, voters: result.rows });
  } catch (err) {
    console.error('Error en GET /admin/voters:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Módulo de auditoría: consulta del registro inmutable de eventos de login
// y de gestión de identidad. Nunca expone cédulas ni contraseñas en texto
// plano (ver audit.js y el schema de audit_log).
app.get('/admin/audit-log', requireAdmin, adminOpsLimiter, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const eventType = req.query.eventType || null;

  try {
    const result = await pool.query(
      `SELECT id, event_type, actor_type, actor_ref, ip_address, metadata, created_at
         FROM audit_log
        WHERE ($1::text IS NULL OR event_type = $1)
        ORDER BY id DESC
        LIMIT $2 OFFSET $3`,
      [eventType, limit, offset]
    );
    return res.status(200).json({ limit, offset, events: result.rows });
  } catch (err) {
    console.error('Error en GET /admin/audit-log:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.listen(PORT, () => console.log(`[auth-service] escuchando en puerto ${PORT}`));

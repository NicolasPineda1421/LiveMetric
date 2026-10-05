require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env') });
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('./db');
const { recordAuditEvent } = require('./audit');
const { requireAdmin, requireRole } = require('./middleware/auth');
const { encryptField, decryptField } = require('./voterCrypto');
const totp = require('./totp');
const { evaluarContrasena, mensajeContrasenaDebil, MINIMO_CONTRASENA, MAXIMO_CONTRASENA } = require('./politicaContrasena');
const { leerHorasDeVigencia, vencimientoDelPin, VIGENCIA_MAXIMA_HORAS } = require('./vigenciaPin');
const { juradoCubre, lugaresDelPadron, ubicarEnPadron, lugarCanonico, normalizarPuesto, mismoPuesto, mismaMesa } = require('./lugares');

const app = express();
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
// El cuerpo de casi todas las rutas es chico: 10 kB. Las que agregan
// votantes reciben hasta 200 por vez (la carga desde un archivo los manda
// en lotes), así que leen el suyo con otro límite, y DESPUÉS de comprobar
// que quien llama es un administrador: sin sesión, nadie consigue que el
// servicio lea un cuerpo grande.
const jsonChico = express.json({ limit: '10kb' });
const jsonVotantes = express.json({ limit: '256kb' });
const RUTAS_DE_VOTANTES = new Set(['/admin/voters', '/admin/voters/bulk']);
app.use((req, res, next) => (req.method === 'POST' && RUTAS_DE_VOTANTES.has(req.path) ? next() : jsonChico(req, res, next)));

// Login de votantes (cédula + PIN de 6 dígitos, y después el código del
// autenticador o la autorización del jurado): el límite frena a quien
// intenta adivinar PINs, cédulas o códigos, y es el mismo para todos esos
// pasos. Solo cuentan los intentos FALLIDOS: en un
// puesto de votación todos los votantes entran desde el mismo equipo (la
// misma IP), y si contaran también los correctos, el noveno votante en 15
// minutos quedaría bloqueado. Después de 8 fallos, la IP queda bloqueada
// hasta que pase la ventana, también para el PIN correcto.
const voterLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  skipSuccessfulRequests: true,
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

// Operaciones de administración que cambian algo (crear, cargar, regenerar,
// eliminar): 20 por minuto. Las consultas tienen su propio límite, más
// amplio (los filtros del padrón hacen un pedido por cambio): si compartieran
// el contador, filtrar el listado dejaba sin cupo para eliminar o regenerar.
const adminOpsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const adminReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// SHA-256(cedula + salt privado). Se calcula UNA vez aquí, al emitir el JWT
// de votante, y viaja dentro del token. Voting nunca ve la cédula ni conoce
// este salt: solo lee el hash ya calculado desde el token verificado.
function buildVoterIdHash(cedula) {
  return crypto.createHash('sha256').update(`${cedula}|${VOTER_ID_SALT}`).digest('hex');
}

// PIN numérico de 6 dígitos (con ceros a la izquierda si hace falta),
// generado con el CSPRNG de Node — es el secreto real del votante, ya no la
// cédula. Se genera al cargar el padrón o al regenerarlo desde "Padrón".
function generateAccessCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

/* ============================================================
 * VIGENCIA DEL PIN (migraciones 007 y 008)
 * ============================================================
 *
 * El PIN que entrega el administrador vence PIN_VIGENCIA_HORAS después de
 * generarlo (24, si el .env no dice otra cosa; ver vigenciaPin.js): el
 * tiempo corre desde que se genera, sin importar cuándo es la elección.
 * Hasta entonces sirve haya o no una votación abierta: el votante puede,
 * por ejemplo, registrar su autenticador antes de votar. Votar sí se puede
 * solo dentro del horario de la elección (eso lo controla voting-service).
 * Así un PIN viejo no sirve en elecciones futuras. Se comprueba en el
 * primer paso del ingreso y otra vez en el segundo.
 */
const PIN_VIGENCIA_HORAS = leerHorasDeVigencia(process.env.PIN_VIGENCIA_HORAS);
if (PIN_VIGENCIA_HORAS === null) {
  console.error(`FATAL: PIN_VIGENCIA_HORAS debe ser un número entero de horas, de 1 a ${VIGENCIA_MAXIMA_HORAS} (90 días).`);
  process.exit(1);
}
const vencimientoDeUnPinNuevo = () => vencimientoDelPin(PIN_VIGENCIA_HORAS);

const PIN_EXPIRED = { error: 'Tu PIN venció. Pide uno nuevo al encargado de tu puesto de votación.' };

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'auth' }));

/* ============================================================
 * SEGUNDO FACTOR — TOTP (Microsoft Authenticator, Google Authenticator)
 * ============================================================
 *
 * El ingreso del votante y el del jurado tienen dos pasos. El primero
 * comprueba lo que la persona sabe (PIN o contraseña) y, si es correcto,
 * todavía NO abre la sesión: devuelve un desafío, un token de 5 minutos que
 * solo sirve para el segundo paso, y qué falta:
 *   - next: 'codigo'   -> ya tiene autenticador: el código de 6 dígitos.
 *   - next: 'registro' -> primer ingreso: escanear el QR y confirmar con un código.
 *   - next: 'jurado'   -> votante asistido: lo autoriza el jurado de su mesa.
 * El desafío no lleva rol, así que ningún servicio lo acepta como sesión.
 */
const CHALLENGE_EXPIRES_IN = '5m';
const CHALLENGE_AUDIENCE = 'livemetric-segundo-factor';
const CHALLENGE_EXPIRED = { error: 'La verificación venció: vuelve a ingresar desde el principio.' };
const WRONG_CODE = { error: 'Código incorrecto o vencido: escribe el que muestra ahora la app.' };

function signChallenge(purpose, claims) {
  return jwt.sign({ purpose, ...claims }, JWT_SECRET, {
    expiresIn: CHALLENGE_EXPIRES_IN,
    algorithm: 'HS256',
    audience: CHALLENGE_AUDIENCE,
  });
}

// El desafío del primer paso, o null si venció, fue alterado o es de otro paso.
function readChallenge(token, purpose) {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: CHALLENGE_AUDIENCE });
    return payload.purpose === purpose ? payload : null;
  } catch {
    return null;
  }
}

// Primer ingreso: el secreto va al navegador (es lo que lleva el QR) y,
// cifrado, dentro del desafío. Se guarda recién cuando la persona demuestra
// que lo cargó en su app, escribiendo un código válido.
function enrollmentChallenge(purpose, claims, account) {
  const secret = totp.generateSecret();
  return {
    next: 'registro',
    challenge: signChallenge(purpose, { ...claims, s: encryptField(secret) }),
    secret,
    otpauthUri: totp.otpauthUri({ secret, account }),
  };
}

// Consumen el paso del código: el UPDATE solo pasa si es posterior al último
// usado, así que un código no sirve dos veces, ni con dos pedidos a la vez.
async function consumeVoterStep(voterId, step) {
  const result = await pool.query(
    `UPDATE voters SET totp_last_step = $1
      WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1) RETURNING id`,
    [step, voterId]
  );
  return result.rows.length === 1;
}

async function consumeJuradoStep(juradoId, step) {
  const result = await pool.query(
    `UPDATE admins SET totp_last_step = $1
      WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1) RETURNING id`,
    [step, juradoId]
  );
  return result.rows.length === 1;
}

const challengeRule = body('challenge').isString().isLength({ max: 2048 }).isJWT();
const codeRules = [challengeRule, body('code').trim().matches(/^\d{6}$/)];
const CODE_FORMAT = { error: 'Escribe los 6 dígitos que muestra la app.' };

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
        'SELECT id, username, password_hash, role, totp_secret FROM admins WHERE username = $1',
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

      // El jurado autoriza votos asistidos con su autenticador, así que su
      // ingreso también tiene segundo factor (ver SEGUNDO FACTOR).
      if (admin.role === 'jurado') {
        const claims = { sub: admin.id };
        if (!admin.totp_secret) {
          return res.status(200).json(enrollmentChallenge('jurado-registro', claims, `Jurado ${admin.username}`));
        }
        return res.status(200).json({ next: 'codigo', challenge: signChallenge('jurado-codigo', claims) });
      }

      const token = jwt.sign(
        { sub: admin.id, username: admin.username, role: admin.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
      );

      await recordAuditEvent({
        eventType: 'LOGIN_SUCCESS_ADMIN',
        actorType: 'admin',
        actorRef: username,
        req,
      });

      return res.status(200).json({ token, expiresIn: JWT_EXPIRES_IN, role: admin.role });
    } catch (err) {
      console.error('Error en /login/admin:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

async function juradoFromChallenge(payload) {
  const result = await pool.query(
    `SELECT id, username, totp_secret, totp_last_step FROM admins WHERE id = $1 AND role = 'jurado'`,
    [payload.sub]
  );
  return result.rows[0] || null;
}

async function rejectJurado(req, res, jurado, reason, status, payload) {
  await recordAuditEvent({
    eventType: 'LOGIN_FAILURE_ADMIN',
    actorType: 'jurado',
    actorRef: jurado.username,
    req,
    metadata: { reason },
  });
  return res.status(status).json(payload);
}

async function openJuradoSession(req, res, jurado, metadata = {}) {
  const token = jwt.sign(
    { sub: jurado.id, username: jurado.username, role: 'jurado' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
  await recordAuditEvent({ eventType: 'LOGIN_SUCCESS_ADMIN', actorType: 'jurado', actorRef: jurado.username, req, metadata });
  return res.status(200).json({ token, expiresIn: JWT_EXPIRES_IN, role: 'jurado' });
}

// Segundo paso del jurado: el código de su autenticador.
app.post('/login/admin/codigo', adminLoginLimiter, codeRules, async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json(CODE_FORMAT);
  const payload = readChallenge(req.body.challenge, 'jurado-codigo');
  if (!payload) return res.status(401).json(CHALLENGE_EXPIRED);

  try {
    const jurado = await juradoFromChallenge(payload);
    if (!jurado || !jurado.totp_secret) return res.status(401).json(CHALLENGE_EXPIRED);
    const step = totp.verify(decryptField(jurado.totp_secret), req.body.code, { lastStep: jurado.totp_last_step });
    if (step === null || !(await consumeJuradoStep(jurado.id, step))) {
      return rejectJurado(req, res, jurado, 'codigo_incorrecto', 401, WRONG_CODE);
    }
    return openJuradoSession(req, res, jurado);
  } catch (err) {
    console.error('Error en /login/admin/codigo:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Primer ingreso del jurado: registra su autenticador.
app.post('/login/admin/registro', adminLoginLimiter, codeRules, async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json(CODE_FORMAT);
  const payload = readChallenge(req.body.challenge, 'jurado-registro');
  if (!payload) return res.status(401).json(CHALLENGE_EXPIRED);

  try {
    const jurado = await juradoFromChallenge(payload);
    if (!jurado) return res.status(401).json(CHALLENGE_EXPIRED);
    const secret = decryptField(payload.s);
    const step = totp.verify(secret, req.body.code);
    if (step === null) return rejectJurado(req, res, jurado, 'codigo_registro_incorrecto', 401, WRONG_CODE);

    const saved = await pool.query(
      `UPDATE admins SET totp_secret = $1, totp_last_step = $2
        WHERE id = $3 AND role = 'jurado' AND totp_secret IS NULL RETURNING id`,
      [encryptField(secret), step, jurado.id]
    );
    if (saved.rows.length === 0) {
      return rejectJurado(req, res, jurado, 'autenticador_ya_registrado', 409, {
        error: 'Este usuario ya tiene un autenticador registrado. Si no fuiste tú, avisa al administrador.',
      });
    }
    await recordAuditEvent({ eventType: 'USER_TOTP_ENROLLED', actorType: 'jurado', actorRef: jurado.username, req });
    return openJuradoSession(req, res, jurado, { primerRegistro: true });
  } catch (err) {
    console.error('Error en /login/admin/registro:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ============================================================
 * LOGIN — VOTANTE (cédula + PIN de acceso asignado por el admin, y el
 * segundo factor: su autenticador, o el jurado de su mesa si vota asistido)
 * ============================================================ */

app.post(
  '/login/voter',
  voterLoginLimiter,
  [
    body('cedula').trim().isLength({ min: 5, max: 20 }).matches(/^[0-9A-Za-z-]+$/),
    body('pin').trim().isLength({ min: 4, max: 10 }).matches(/^[0-9]+$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Cédula o PIN inválido' });
    }

    const { cedula, pin } = req.body;
    const voterIdHash = buildVoterIdHash(cedula);
    const genericError = { error: 'Cédula o PIN incorrectos' };

    try {
      const result = await pool.query(
        `SELECT id, is_active, assisted, totp_secret, access_code_hash,
                (access_code_expires_at IS NOT NULL AND access_code_expires_at <= now()) AS pin_expired
           FROM voters WHERE cedula = $1`,
        [encryptField(cedula)]
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

      // Votante cargado antes de que existiera el PIN de acceso, o al que
      // nunca se le generó uno: falla cerrado (nunca se vuelve a aceptar la
      // cédula como contraseña). El admin debe generarle uno en "Padrón".
      if (!voter.access_code_hash) {
        await recordAuditEvent({
          eventType: 'LOGIN_FAILURE_VOTER',
          actorType: 'voter',
          actorRef: voterIdHash,
          req,
          metadata: { reason: 'sin_pin_asignado' },
        });
        return res.status(401).json(genericError);
      }

      const pinMatches = await bcrypt.compare(pin, voter.access_code_hash);
      if (!pinMatches) {
        await recordAuditEvent({
          eventType: 'LOGIN_FAILURE_VOTER',
          actorType: 'voter',
          actorRef: voterIdHash,
          req,
          metadata: { reason: 'pin_incorrecto' },
        });
        return res.status(401).json(genericError);
      }

      // Recién con el PIN correcto se dice que venció: a quien no lo conoce,
      // el mensaje no le revela nada.
      if (voter.pin_expired) {
        return rejectVoter(req, res, voterIdHash, 'pin_vencido', 403, PIN_EXPIRED);
      }

      // El PIN es correcto, pero la sesión se abre recién con el segundo
      // factor (ver SEGUNDO FACTOR más arriba).
      const claims = { sub: voter.id, vh: voterIdHash };
      if (voter.assisted) {
        return res.status(200).json({ next: 'jurado', challenge: signChallenge('votante-asistido', claims) });
      }
      if (!voter.totp_secret) {
        // En su app la cuenta se ve como "Votante ···1234": la reconoce, sin
        // mostrar la cédula completa a quien mire el celular.
        return res.status(200).json(enrollmentChallenge('votante-registro', claims, `Votante ···${cedula.slice(-4)}`));
      }
      return res.status(200).json({ next: 'codigo', challenge: signChallenge('votante-codigo', claims) });
    } catch (err) {
      console.error('Error en /login/voter:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// El votante del desafío, si sigue habilitado.
async function voterFromChallenge(payload) {
  const result = await pool.query(
    `SELECT id, is_active, assisted, polling_place, voting_table, totp_secret, totp_last_step,
            (access_code_expires_at IS NOT NULL AND access_code_expires_at <= now()) AS pin_expired
       FROM voters WHERE id = $1`,
    [payload.sub]
  );
  const voter = result.rows[0];
  return voter && voter.is_active ? voter : null;
}

// El desafío dura 5 minutos: en el segundo paso se vuelve a comprobar que el
// PIN no haya vencido en el medio. Devuelve la respuesta de rechazo, o null
// si puede seguir.
async function rejectIfPinExpired(req, res, voter, voterIdHash) {
  if (voter.pin_expired) return rejectVoter(req, res, voterIdHash, 'pin_vencido', 403, PIN_EXPIRED);
  return null;
}

async function rejectVoter(req, res, voterIdHash, reason, status, payload) {
  await recordAuditEvent({
    eventType: 'LOGIN_FAILURE_VOTER',
    actorType: 'voter',
    actorRef: voterIdHash,
    req,
    metadata: { reason },
  });
  return res.status(status).json(payload);
}

// La sesión del votante, ya con los dos factores.
//
// El JWT lleva el puesto y mesa asignados (no son secretos: identifican un
// lugar físico, no a la persona) para que Voting los copie a cada voto
// emitido y el escrutinio pueda consolidar por mesa sin volver a tocar la
// tabla "voters" ni la cédula.
//
// Token de vida MUY corta (por defecto 10 minutos): alcanza para completar
// un voto, pero limita la ventana de uso indebido si el token fuera
// interceptado o reutilizado.
async function openVoterSession(req, res, voter, voterIdHash, metadata) {
  const pollingPlace = decryptField(voter.polling_place);
  const votingTable = decryptField(voter.voting_table);
  const token = jwt.sign(
    { sub: voter.id, role: 'voter', voterIdHash, pollingPlace, votingTable },
    JWT_SECRET,
    { expiresIn: VOTER_JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
  await recordAuditEvent({ eventType: 'LOGIN_SUCCESS_VOTER', actorType: 'voter', actorRef: voterIdHash, req, metadata });
  return res.status(200).json({ token, expiresIn: VOTER_JWT_EXPIRES_IN, role: 'voter', pollingPlace, votingTable });
}

// Segundo paso: el código de 6 dígitos de su autenticador.
app.post('/login/voter/codigo', voterLoginLimiter, codeRules, async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json(CODE_FORMAT);
  const payload = readChallenge(req.body.challenge, 'votante-codigo');
  if (!payload) return res.status(401).json(CHALLENGE_EXPIRED);

  try {
    const voter = await voterFromChallenge(payload);
    if (!voter || voter.assisted || !voter.totp_secret) return res.status(401).json(CHALLENGE_EXPIRED);
    const blocked = await rejectIfPinExpired(req, res, voter, payload.vh);
    if (blocked) return blocked;
    const step = totp.verify(decryptField(voter.totp_secret), req.body.code, { lastStep: voter.totp_last_step });
    if (step === null || !(await consumeVoterStep(voter.id, step))) {
      return rejectVoter(req, res, payload.vh, 'codigo_incorrecto', 401, WRONG_CODE);
    }
    return openVoterSession(req, res, voter, payload.vh, { segundoFactor: 'autenticador' });
  } catch (err) {
    console.error('Error en /login/voter/codigo:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Primer ingreso: registra su autenticador y, con eso, entra. Si dos
// personas intentan registrar la misma cédula, gana la primera; la otra ve
// que ya hay uno registrado (si no fue ella, avisa y el admin lo restablece).
app.post('/login/voter/registro', voterLoginLimiter, codeRules, async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json(CODE_FORMAT);
  const payload = readChallenge(req.body.challenge, 'votante-registro');
  if (!payload) return res.status(401).json(CHALLENGE_EXPIRED);

  try {
    const voter = await voterFromChallenge(payload);
    if (!voter || voter.assisted) return res.status(401).json(CHALLENGE_EXPIRED);
    const blocked = await rejectIfPinExpired(req, res, voter, payload.vh);
    if (blocked) return blocked;
    const secret = decryptField(payload.s);
    const step = totp.verify(secret, req.body.code);
    if (step === null) return rejectVoter(req, res, payload.vh, 'codigo_registro_incorrecto', 401, WRONG_CODE);

    const saved = await pool.query(
      `UPDATE voters SET totp_secret = $1, totp_last_step = $2
        WHERE id = $3 AND totp_secret IS NULL AND NOT assisted RETURNING id`,
      [encryptField(secret), step, voter.id]
    );
    if (saved.rows.length === 0) {
      return rejectVoter(req, res, payload.vh, 'autenticador_ya_registrado', 409, {
        error: 'Esta cédula ya tiene un autenticador registrado. Si no fuiste tú, avisa al encargado del puesto.',
      });
    }
    await recordAuditEvent({ eventType: 'VOTER_TOTP_ENROLLED', actorType: 'voter', actorRef: payload.vh, req });
    return openVoterSession(req, res, voter, payload.vh, { segundoFactor: 'autenticador', primerRegistro: true });
  } catch (err) {
    console.error('Error en /login/voter/registro:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Voto asistido: el jurado de la mesa del votante verificó su cédula en
// persona y autoriza el ingreso con el código de SU autenticador. Es el
// segundo factor de quien no puede usar una app: sigue haciendo falta el
// PIN del votante y, además, alguien autorizado y presente en la mesa.
app.post(
  '/login/voter/asistido',
  voterLoginLimiter,
  [
    challengeRule,
    body('juradoUsername').trim().isLength({ min: 3, max: 50 }).escape(),
    body('juradoCode').trim().matches(/^\d{6}$/),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Faltan el usuario del jurado o los 6 dígitos de su código.' });
    }
    const payload = readChallenge(req.body.challenge, 'votante-asistido');
    if (!payload) return res.status(401).json(CHALLENGE_EXPIRED);

    try {
      const voter = await voterFromChallenge(payload);
      if (!voter || !voter.assisted) return res.status(401).json(CHALLENGE_EXPIRED);
      const blocked = await rejectIfPinExpired(req, res, voter, payload.vh);
      if (blocked) return blocked;

      const result = await pool.query(
        `SELECT id, username, polling_place, voting_table, totp_secret, totp_last_step
           FROM admins WHERE username = $1 AND role = 'jurado'`,
        [req.body.juradoUsername]
      );
      const jurado = result.rows[0];
      const step = jurado && jurado.totp_secret
        ? totp.verify(decryptField(jurado.totp_secret), req.body.juradoCode, { lastStep: jurado.totp_last_step })
        : null;
      const juradoInvalid = { error: 'Usuario o código del jurado incorrectos.' };
      if (step === null) return rejectVoter(req, res, payload.vh, 'jurado_no_valido', 401, juradoInvalid);

      // Solo el jurado de la mesa del votante, o el de todo su puesto (sin
      // mesa). Se comparan descifrados y sin depender de cómo se escribieron
      // ("Mesa 1" y "1", mayúsculas, tildes: ver lugares.js).
      const pollingPlace = decryptField(voter.polling_place);
      const votingTable = decryptField(voter.voting_table);
      const lugarJurado = {
        pollingPlace: decryptField(jurado.polling_place),
        votingTable: jurado.voting_table ? decryptField(jurado.voting_table) : null,
      };
      if (!juradoCubre(lugarJurado, { pollingPlace, votingTable })) {
        return rejectVoter(req, res, payload.vh, 'jurado_de_otra_mesa', 403, {
          error: 'Ese jurado no es de la mesa ni del puesto de este votante.',
        });
      }
      if (!(await consumeJuradoStep(jurado.id, step))) {
        return rejectVoter(req, res, payload.vh, 'jurado_no_valido', 401, juradoInvalid);
      }

      await recordAuditEvent({
        eventType: 'ASSISTED_LOGIN_AUTHORIZED',
        actorType: 'jurado',
        actorRef: jurado.username,
        req,
        metadata: { voterIdHash: payload.vh, pollingPlace, votingTable },
      });
      return openVoterSession(req, res, voter, payload.vh, { segundoFactor: 'jurado', jurado: jurado.username });
    } catch (err) {
      console.error('Error en /login/voter/asistido:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

/* ============================================================
 * ADMINISTRACIÓN DE IDENTIDAD — requiere JWT de administrador
 * ============================================================ */

// El puesto y la mesa de un jurado se eligen del padrón: así coinciden
// siempre con los de sus votantes. Sin mesa, el jurado es de todo el puesto.
const LUGAR_JURADO_ERRORES = {
  padron_vacio: 'Carga el padrón antes de crear jurados: el puesto y la mesa se eligen de él.',
  puesto: 'Ese puesto no está en el padrón.',
  mesa: 'Esa mesa no está en ese puesto del padrón.',
};

async function lugarDelJurado(pollingPlace, votingTable) {
  const lugar = ubicarEnPadron(await lugaresDelPadron(pool), pollingPlace, votingTable);
  return lugar.error ? { error: LUGAR_JURADO_ERRORES[lugar.error] } : lugar;
}

const lugarJuradoRules = [
  body('pollingPlace').if(body('role').equals('jurado')).trim().isLength({ min: 2, max: 150 }),
  body('votingTable').optional({ values: 'falsy' }).trim().isLength({ min: 1, max: 50 }),
];

// Crear un usuario: administrador, auditor (solo lectura) o jurado. El
// jurado necesita su puesto, y su mesa o ninguna (todo el puesto): solo
// puede autorizar a los votantes asistidos de ahí. Se guardan cifrados
// igual que en el padrón.
app.post(
  '/admin/users',
  requireAdmin,
  adminOpsLimiter,
  [
    body('username').trim().isLength({ min: 3, max: 50 }).escape(),
    body('password').isString().isLength({ max: MAXIMO_CONTRASENA }),
    body('role').optional().isIn(['admin', 'auditor', 'jurado']),
    ...lugarJuradoRules,
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: `Datos inválidos: el usuario necesita de 3 a 50 caracteres, la contraseña de ${MINIMO_CONTRASENA} a ${MAXIMO_CONTRASENA}, y un jurado, su puesto`,
      });
    }

    const { username, password } = req.body;
    const role = req.body.role || 'admin';
    const jurado = role === 'jurado';
    // Misma política que el primer administrador (scripts/crearAdmin.js).
    const problemas = evaluarContrasena(password, { username });
    if (problemas.length > 0) return res.status(400).json({ error: mensajeContrasenaDebil(problemas) });

    try {
      const lugar = jurado ? await lugarDelJurado(req.body.pollingPlace, req.body.votingTable) : null;
      if (lugar?.error) return res.status(400).json({ error: lugar.error });
      const passwordHash = await bcrypt.hash(password, 12);
      const created = await pool.query(
        `INSERT INTO admins (username, password_hash, role, polling_place, voting_table)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role, created_at`,
        [
          username,
          passwordHash,
          role,
          jurado ? encryptField(lugar.pollingPlace) : null,
          lugar?.votingTable ? encryptField(lugar.votingTable) : null,
        ]
      );

      await recordAuditEvent({
        eventType: 'ADMIN_USER_CREATED',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: {
          newAdminUsername: username,
          role,
          ...(jurado ? { pollingPlace: lugar.pollingPlace, votingTable: lugar.votingTable } : {}),
        },
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

// Usuarios del panel, con la mesa de cada jurado y si ya registró su
// autenticador (nunca el secreto).
app.get('/admin/users', requireAdmin, adminReadLimiter, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, role, polling_place, voting_table, (totp_secret IS NOT NULL) AS has_totp, created_at
         FROM admins ORDER BY id ASC`
    );
    const users = result.rows.map((u) => ({
      ...u,
      polling_place: u.polling_place ? decryptField(u.polling_place) : null,
      voting_table: u.voting_table ? decryptField(u.voting_table) : null,
    }));
    return res.status(200).json({ users });
  } catch (err) {
    console.error('Error en GET /admin/users:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Los puestos del padrón con sus mesas: de ahí se elige el lugar de cada jurado.
app.get('/admin/padron/lugares', requireAdmin, adminReadLimiter, async (_req, res) => {
  try {
    return res.status(200).json({ places: await lugaresDelPadron(pool) });
  } catch (err) {
    console.error('Error en GET /admin/padron/lugares:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Cambia el puesto y la mesa de un jurado (sin mesa: todo el puesto).
app.put(
  '/admin/users/:id/mesa',
  requireAdmin,
  adminOpsLimiter,
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('pollingPlace').trim().isLength({ min: 2, max: 150 }),
    body('votingTable').optional({ values: 'falsy' }).trim().isLength({ min: 1, max: 50 }),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Indica el puesto (y la mesa, si es de una sola)' });
    try {
      const lugar = await lugarDelJurado(req.body.pollingPlace, req.body.votingTable);
      if (lugar.error) return res.status(400).json({ error: lugar.error });
      const updated = await pool.query(
        `UPDATE admins SET polling_place = $1, voting_table = $2
          WHERE id = $3 AND role = 'jurado' RETURNING username`,
        [encryptField(lugar.pollingPlace), lugar.votingTable ? encryptField(lugar.votingTable) : null, req.params.id]
      );
      if (updated.rows.length === 0) return res.status(404).json({ error: 'Jurado no encontrado' });
      await recordAuditEvent({
        eventType: 'JURADO_MESA_CHANGED',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { targetUsername: updated.rows[0].username, ...lugar },
      });
      return res.status(200).json({ id: req.params.id, ...lugar });
    } catch (err) {
      console.error('Error en PUT /admin/users/:id/mesa:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Un jurado perdió o cambió el celular: se borra su autenticador y lo vuelve
// a registrar en su próximo ingreso.
app.post(
  '/admin/users/:id/reset-totp',
  requireAdmin,
  adminOpsLimiter,
  [param('id').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'id de usuario inválido' });
    try {
      const updated = await pool.query(
        `UPDATE admins SET totp_secret = NULL, totp_last_step = NULL
          WHERE id = $1 AND role = 'jurado' RETURNING username`,
        [req.params.id]
      );
      if (updated.rows.length === 0) return res.status(404).json({ error: 'Jurado no encontrado' });
      await recordAuditEvent({
        eventType: 'USER_TOTP_RESET',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { targetUsername: updated.rows[0].username },
      });
      return res.status(200).json({ id: req.params.id, hasTotp: false });
    } catch (err) {
      console.error('Error en POST /admin/users/:id/reset-totp:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Carga masiva del padrón electoral. Se acepta un arreglo JSON de
// {cedula, fullName, pollingPlace, votingTable}; usa UPSERT (ON CONFLICT)
// para poder reintentar cargas parciales sin duplicar votantes ya existentes.
// A cada votante NUEVO se le genera un PIN de acceso (nunca a uno que ya
// existía: no se le pisa el PIN por corregirle, p.ej., el nombre). Los PIN
// generados se devuelven en texto plano UNA sola vez en la respuesta —no
// quedan en ningún otro lado salvo su hash— para que el admin los imprima y
// reparta en el puesto de votación.
app.post(
  '/admin/voters/bulk',
  requireAdmin,
  adminOpsLimiter,
  jsonVotantes,
  [
    // Como POST /admin/voters: hasta 200 por pedido. Más no entra en el
    // límite del cuerpo, y generar sus PIN (bcrypt) tardaría más de lo que
    // nginx espera una respuesta.
    body('voters').isArray({ min: 1, max: 200 }),
    body('voters.*.cedula').trim().isLength({ min: 5, max: 20 }).matches(/^[0-9A-Za-z-]+$/),
    // Sin .escape(): convertía "O'Neil" o "Sede A / B" en entidades HTML
    // (O&#x27;Neil) que después salían así en el panel y en el acta. Aquí
    // nada se arma como HTML; React escapa al mostrar y el PDF es texto.
    body('voters.*.fullName').trim().isLength({ min: 3, max: 200 }),
    body('voters.*.pollingPlace').trim().isLength({ min: 2, max: 150 }),
    body('voters.*.votingTable').trim().isLength({ min: 1, max: 50 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Formato de padrón inválido: cada votante necesita cédula (5 a 20 letras, números o guiones), nombre (3 o más caracteres), puesto y mesa',
        details: errors.array(),
      });
    }

    const { voters } = req.body;

    // Hashing de bcrypt es intensivo en CPU: se hace en paralelo ANTES de la
    // transacción (no dentro del loop secuencial), para que cargar cientos
    // de votantes no se vuelva lento innecesariamente.
    // El tiempo del PIN corre desde que se genera (ver VIGENCIA DEL PIN).
    const pins = voters.map(() => generateAccessCode());
    const pinExpiresAt = vencimientoDeUnPinNuevo();
    const pinHashes = await Promise.all(pins.map((pin) => bcrypt.hash(pin, 10)));

    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;
    const accessCodes = [];

    try {
      await client.query('BEGIN');

      /* eslint-disable security/detect-object-injection -- i es el índice numérico de voters, pins y pinHashes, arreglos paralelos del mismo largo armados arriba */
      for (let i = 0; i < voters.length; i += 1) {
        const v = voters[i];
        // cedula/polling_place/voting_table van cifrados (ver voterCrypto.js);
        // full_name se guarda tal cual, en texto plano.
        const result = await client.query(
          `INSERT INTO voters (cedula, full_name, polling_place, voting_table, access_code_hash, access_code_expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (cedula) DO UPDATE SET
             full_name = EXCLUDED.full_name,
             polling_place = EXCLUDED.polling_place,
             voting_table = EXCLUDED.voting_table
           RETURNING (xmax = 0) AS inserted`,
          [
            encryptField(v.cedula),
            v.fullName,
            encryptField(v.pollingPlace),
            encryptField(v.votingTable),
            pinHashes[i],
            pinExpiresAt,
            req.user.sub,
          ]
        );
        if (result.rows[0].inserted) {
          inserted += 1;
          accessCodes.push({ cedula: v.cedula, pin: pins[i] });
        } else {
          updated += 1;
        }
      }
      /* eslint-enable security/detect-object-injection */

      await client.query('COMMIT');

      await recordAuditEvent({
        eventType: 'VOTERS_BULK_UPLOADED',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { totalReceived: voters.length, inserted, updated, pinExpiresAt },
      });

      return res.status(201).json({ totalReceived: voters.length, inserted, updated, accessCodes, pinExpiresAt });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error en /admin/voters/bulk:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }
  }
);

// Genera (o regenera) el PIN de acceso de un votante puntual: cubre tanto
// "nunca tuvo uno" (padrón cargado antes de este cambio) como "perdió o
// filtró su PIN". El PIN anterior queda inválido de inmediato (se
// sobrescribe el hash) y el nuevo se devuelve en texto plano UNA sola vez.
// El PIN nuevo vence PIN_VIGENCIA_HORAS después de generarlo.
app.post(
  '/admin/voters/:id/reset-pin',
  requireAdmin,
  adminOpsLimiter,
  [param('id').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'id de votante inválido' });
    }

    try {
      const pin = generateAccessCode();
      const pinExpiresAt = vencimientoDeUnPinNuevo();
      const pinHash = await bcrypt.hash(pin, 10);
      const updated = await pool.query(
        'UPDATE voters SET access_code_hash = $1, access_code_expires_at = $2 WHERE id = $3 RETURNING id, cedula',
        [pinHash, pinExpiresAt, req.params.id]
      );
      if (updated.rows.length === 0) {
        return res.status(404).json({ error: 'Votante no encontrado' });
      }

      await recordAuditEvent({
        eventType: 'VOTER_PIN_RESET',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { voterId: req.params.id, pinExpiresAt },
      });

      return res.status(200).json({ id: updated.rows[0].id, cedula: decryptField(updated.rows[0].cedula), pin, pinExpiresAt });
    } catch (err) {
      console.error('Error en POST /admin/voters/:id/reset-pin:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Consulta del padrón, con filtros y paginada — solo para verificación
// administrativa; nunca se expone al público ni a los propios votantes.
// Cédula, puesto y mesa están cifrados, así que los filtros se aplican
// después de descifrar (un padrón de miles de filas se descifra en
// milisegundos). Filtros, todos opcionales:
//   q          parte de la cédula o del nombre (sin mayúsculas ni tildes)
//   pollingPlace / votingTable   como en lugares.js ("1" = "Mesa 1")
//   pin        sin_asignar | vigente | vencido | sin_vencimiento
//   totp       registrado | pendiente
//   assisted   true | false
const VOTER_FILTERS = {
  pin: ['sin_asignar', 'vigente', 'vencido', 'sin_vencimiento'],
  totp: ['registrado', 'pendiente'],
  assisted: ['true', 'false'],
};

function pinState(v) {
  if (!v.has_pin) return 'sin_asignar';
  if (!v.pin_expires_at) return 'sin_vencimiento';
  return v.pin_expired ? 'vencido' : 'vigente';
}

app.get(
  '/admin/voters',
  requireAdmin,
  adminReadLimiter,
  [
    query('q').optional().isString().isLength({ max: 50 }),
    query('pollingPlace').optional().isString().isLength({ max: 150 }),
    query('votingTable').optional().isString().isLength({ max: 50 }),
    query('pin').optional({ values: 'falsy' }).isIn(VOTER_FILTERS.pin),
    query('totp').optional({ values: 'falsy' }).isIn(VOTER_FILTERS.totp),
    query('assisted').optional({ values: 'falsy' }).isIn(VOTER_FILTERS.assisted),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Filtro del padrón inválido' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { q, pollingPlace, votingTable, pin, totp: totpFilter, assisted } = req.query;
    const texto = q ? normalizarPuesto(q) : '';

    try {
      const result = await pool.query(
        `SELECT id, cedula, full_name, polling_place, voting_table, is_active,
                (access_code_hash IS NOT NULL) AS has_pin, access_code_expires_at AS pin_expires_at,
                (access_code_expires_at IS NOT NULL AND access_code_expires_at <= now()) AS pin_expired,
                (totp_secret IS NOT NULL) AS has_totp,
                assisted, created_at
           FROM voters
          ORDER BY id ASC`
      );
      const filtered = result.rows
        .map((v) => ({
          ...v,
          cedula: decryptField(v.cedula),
          polling_place: decryptField(v.polling_place),
          voting_table: decryptField(v.voting_table),
          pin_state: pinState(v),
        }))
        .filter((v) => !texto || v.cedula.toLowerCase().includes(texto) || normalizarPuesto(v.full_name).includes(texto))
        .filter((v) => !pollingPlace || mismoPuesto(v.polling_place, pollingPlace))
        .filter((v) => !votingTable || mismaMesa(v.voting_table, votingTable))
        .filter((v) => !pin || v.pin_state === pin)
        .filter((v) => !totpFilter || v.has_totp === (totpFilter === 'registrado'))
        .filter((v) => !assisted || v.assisted === (assisted === 'true'));
      const voters = filtered.slice(offset, offset + limit).map(({ pin_expired: _vencido, ...v }) => v);
      return res.status(200).json({
        limit,
        offset,
        total: filtered.length,
        registered: result.rows.length,
        voters,
        // Para que el panel diga cuánto vale cada PIN que se genere.
        pinVigenciaHoras: PIN_VIGENCIA_HORAS,
      });
    } catch (err) {
      console.error('Error en GET /admin/voters:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Sugerencias para el buscador del padrón (autocompletar, mientras se
// escribe): hasta 8 votantes. Primero los que tienen una cédula que empieza
// con lo escrito, después los que la contienen y después los que coinciden
// por nombre (sin mayúsculas ni tildes). Liviana a propósito: solo lo que
// muestra la lista, sin el estado del PIN ni el vencimiento sugerido.
const SUGERENCIAS_MAXIMO = 8;

app.get(
  '/admin/voters/sugerencias',
  requireAdmin,
  adminReadLimiter,
  [query('q').isString().trim().isLength({ min: 2, max: 50 })],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Escribe al menos 2 caracteres' });
    const texto = normalizarPuesto(req.query.q);
    try {
      const result = await pool.query('SELECT id, cedula, full_name, polling_place, voting_table FROM voters');
      const conPuntaje = [];
      for (const v of result.rows) {
        const cedula = decryptField(v.cedula);
        const nombre = normalizarPuesto(v.full_name);
        const enCedula = cedula.toLowerCase().indexOf(texto);
        let puntaje = null;
        if (enCedula === 0) puntaje = 0;
        else if (enCedula > 0) puntaje = 1;
        else if (nombre.split(' ').some((palabra) => palabra.startsWith(texto))) puntaje = 2;
        else if (nombre.includes(texto)) puntaje = 3;
        if (puntaje !== null) conPuntaje.push({ puntaje, v, cedula });
      }
      conPuntaje.sort((a, b) => a.puntaje - b.puntaje || a.cedula.localeCompare(b.cedula, 'es', { numeric: true }));
      const suggestions = conPuntaje.slice(0, SUGERENCIAS_MAXIMO).map(({ v, cedula }) => ({
        id: v.id,
        cedula,
        fullName: v.full_name,
        pollingPlace: decryptField(v.polling_place),
        votingTable: decryptField(v.voting_table),
      }));
      return res.status(200).json({ suggestions, total: conPuntaje.length });
    } catch (err) {
      console.error('Error en GET /admin/voters/sugerencias:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Agregar votantes desde el panel: con el formulario, o desde un archivo o
// una hoja de cálculo, que el panel manda en lotes de hasta 200. Nunca
// modifica a uno que ya está (a diferencia de /admin/voters/bulk, que
// actualiza sus datos): las cédulas que ya estaban se informan y quedan
// como estaban, así que volver a cargar el mismo archivo no cambia nada.
// Si el puesto o la mesa ya figuran en el padrón escritos de otra forma
// ("puesto central", "1"), se guardan como figuran, para que el padrón no
// tenga el mismo lugar escrito de dos maneras; también entre los votantes
// del mismo pedido, cuando el puesto es nuevo. assisted (opcional) los
// marca para el voto asistido, y origen dice en la auditoría de dónde
// vinieron.
const VOTER_FIELD_LABELS = {
  cedula: 'la cédula debe tener de 5 a 20 letras, números o guiones',
  fullName: 'el nombre debe tener 3 caracteres o más',
  pollingPlace: 'falta el puesto de votación',
  votingTable: 'falta la mesa',
  assisted: 'el voto asistido debe ser sí o no',
};

// "voters[2].cedula" -> { fila: 3, campo: 'cedula' }: qué votante y qué dato
// tienen el error. Sin expresión regular: la ruta sale del pedido.
function votanteConError(ruta = '') {
  const [antes, campo] = String(ruta).split('].');
  const indice = antes.startsWith('voters[') ? Number(antes.slice('voters['.length)) : NaN;
  return Number.isInteger(indice) && campo ? { fila: indice + 1, campo } : null;
}

app.post(
  '/admin/voters',
  requireAdmin,
  adminOpsLimiter,
  jsonVotantes,
  [
    body('voters').isArray({ min: 1, max: 200 }),
    body('voters.*.cedula').isString().trim().isLength({ min: 5, max: 20 }).matches(/^[0-9A-Za-z-]+$/),
    body('voters.*.fullName').isString().trim().isLength({ min: 3, max: 200 }),
    body('voters.*.pollingPlace').isString().trim().isLength({ min: 2, max: 150 }),
    body('voters.*.votingTable').isString().trim().isLength({ min: 1, max: 50 }),
    body('voters.*.assisted').optional().isBoolean({ strict: true }),
    body('origen').optional().isIn(['formulario', 'archivo']),
  ],
  async (req, res) => {
    const errors = validationResult(req).array();
    if (errors.length > 0) {
      // "Votante 3: la cédula debe tener…"
      const conError = votanteConError(errors[0].path);
      const motivo = conError && Object.hasOwn(VOTER_FIELD_LABELS, conError.campo) ? VOTER_FIELD_LABELS[conError.campo] : null;
      return res.status(400).json({
        error: motivo ? `Votante ${conError.fila}: ${motivo}.` : 'Agrega entre 1 y 200 votantes por vez.',
      });
    }

    const { voters } = req.body;
    const cedulas = voters.map((v) => v.cedula);
    const repetida = cedulas.find((c, i) => cedulas.indexOf(c) !== i);
    if (repetida) return res.status(400).json({ error: `La cédula ${repetida} está dos veces en el formulario.` });

    const lugares = await lugaresDelPadron(pool);
    const pins = voters.map(() => generateAccessCode());
    const pinExpiresAt = vencimientoDeUnPinNuevo();
    const pinHashes = await Promise.all(pins.map((pin) => bcrypt.hash(pin, 10)));

    const client = await pool.connect();
    const accessCodes = [];
    const duplicates = [];
    try {
      await client.query('BEGIN');
      for (const [i, v] of voters.entries()) {
        const { pollingPlace, votingTable } = lugarCanonico(lugares, v.pollingPlace, v.votingTable);
        const result = await client.query(
          `INSERT INTO voters (cedula, full_name, polling_place, voting_table, access_code_hash, access_code_expires_at, created_by, assisted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (cedula) DO NOTHING
           RETURNING id`,
          [
            encryptField(v.cedula), v.fullName, encryptField(pollingPlace), encryptField(votingTable),
            // eslint-disable-next-line security/detect-object-injection -- i es el índice numérico de voters, pins y pinHashes, arreglos paralelos
            pinHashes[i], pinExpiresAt, req.user.sub, v.assisted === true,
          ]
        );
        if (result.rows.length === 1) {
          // eslint-disable-next-line security/detect-object-injection -- i es el índice numérico de pins, paralelo a voters
          accessCodes.push({ cedula: v.cedula, pin: pins[i], fullName: v.fullName, pollingPlace, votingTable });
        } else {
          duplicates.push(v.cedula);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error en POST /admin/voters:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
      client.release();
    }

    await recordAuditEvent({
      eventType: 'VOTERS_ADDED',
      actorType: 'admin',
      actorRef: req.user.username,
      req,
      metadata: {
        inserted: accessCodes.length,
        duplicates: duplicates.length,
        assisted: voters.filter((v) => v.assisted === true).length,
        pinExpiresAt,
        via: req.body.origen || 'formulario',
      },
    });
    return res.status(201).json({ inserted: accessCodes.length, duplicates, accessCodes, pinExpiresAt });
  }
);

// Eliminar a un votante del padrón. No hay edición: si un dato está mal, se
// elimina y se vuelve a agregar. Los votos que ya emitió se conservan (son
// anónimos: no apuntan a esta fila) y el acta no cambia. Queda en la
// auditoría con el hash de su cédula, nunca con la cédula.
app.delete(
  '/admin/voters/:id',
  requireAdmin,
  adminOpsLimiter,
  [param('id').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'id de votante inválido' });
    try {
      const deleted = await pool.query('DELETE FROM voters WHERE id = $1 RETURNING cedula', [req.params.id]);
      if (deleted.rows.length === 0) return res.status(404).json({ error: 'Votante no encontrado' });
      await recordAuditEvent({
        eventType: 'VOTER_DELETED',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { voterId: req.params.id, voterIdHash: buildVoterIdHash(decryptField(deleted.rows[0].cedula)) },
      });
      return res.status(204).send();
    } catch (err) {
      console.error('Error en DELETE /admin/voters/:id:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// El votante perdió o cambió el celular: se borra su autenticador y lo
// vuelve a registrar en su próximo ingreso (con su cédula y su PIN).
app.post(
  '/admin/voters/:id/reset-totp',
  requireAdmin,
  adminOpsLimiter,
  [param('id').isInt({ min: 1 }).toInt()],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'id de votante inválido' });
    try {
      const updated = await pool.query(
        'UPDATE voters SET totp_secret = NULL, totp_last_step = NULL WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (updated.rows.length === 0) return res.status(404).json({ error: 'Votante no encontrado' });
      await recordAuditEvent({
        eventType: 'VOTER_TOTP_RESET',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { voterId: req.params.id },
      });
      return res.status(200).json({ id: req.params.id, hasTotp: false });
    } catch (err) {
      console.error('Error en POST /admin/voters/:id/reset-totp:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Marca (o desmarca) a un votante para el voto asistido: en vez de su
// autenticador, lo autoriza el jurado de su mesa. Queda en la auditoría.
app.put(
  '/admin/voters/:id/assisted',
  requireAdmin,
  adminOpsLimiter,
  [param('id').isInt({ min: 1 }).toInt(), body('assisted').isBoolean({ strict: true })],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Indica assisted: true o false' });
    try {
      const updated = await pool.query('UPDATE voters SET assisted = $1 WHERE id = $2 RETURNING id, assisted', [
        req.body.assisted,
        req.params.id,
      ]);
      if (updated.rows.length === 0) return res.status(404).json({ error: 'Votante no encontrado' });
      await recordAuditEvent({
        eventType: 'VOTER_ASSISTED_CHANGED',
        actorType: 'admin',
        actorRef: req.user.username,
        req,
        metadata: { voterId: req.params.id, assisted: req.body.assisted },
      });
      return res.status(200).json(updated.rows[0]);
    } catch (err) {
      console.error('Error en PUT /admin/voters/:id/assisted:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

/* ============================================================
 * JURADO DE MESA
 * ============================================================ */

// Su mesa (o todo su puesto, si no tiene mesa) y los votantes asistidos que
// puede autorizar: el nombre, la mesa y los últimos 4 dígitos de la cédula,
// para reconocerlos al cotejar el documento. Los asistidos son pocos: se
// descifran y se filtran con la misma regla que la autorización.
app.get('/jurado/mesa', requireRole('jurado'), adminReadLimiter, async (req, res) => {
  try {
    const jurado = await pool.query(
      `SELECT polling_place, voting_table FROM admins WHERE id = $1 AND role = 'jurado'`,
      [req.user.sub]
    );
    if (jurado.rows.length === 0) return res.status(404).json({ error: 'Jurado no encontrado' });
    const lugar = {
      pollingPlace: decryptField(jurado.rows[0].polling_place),
      votingTable: jurado.rows[0].voting_table ? decryptField(jurado.rows[0].voting_table) : null,
    };
    const voters = await pool.query(
      `SELECT full_name, cedula, polling_place, voting_table FROM voters WHERE assisted AND is_active ORDER BY full_name`
    );
    const assistedVoters = voters.rows
      .map((v) => ({
        fullName: v.full_name,
        cedulaEnd: decryptField(v.cedula).slice(-4),
        pollingPlace: decryptField(v.polling_place),
        votingTable: decryptField(v.voting_table),
      }))
      .filter((v) => juradoCubre(lugar, v))
      .map(({ fullName, cedulaEnd, votingTable }) => ({ fullName, cedulaEnd, votingTable }));
    return res.status(200).json({ ...lugar, assistedVoters });
  } catch (err) {
    console.error('Error en GET /jurado/mesa:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Módulo de auditoría: consulta del registro inmutable de eventos de login
// y de gestión de identidad. Nunca expone cédulas ni contraseñas en texto
// plano (ver audit.js y el schema de audit_log).
app.get('/admin/audit-log', requireAdmin, adminReadLimiter, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const eventType = req.query.eventType || null;

  try {
    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT id, event_type, actor_type, actor_ref, ip_address, metadata, created_at
           FROM audit_log
          WHERE ($1::text IS NULL OR event_type = $1)
          ORDER BY id DESC
          LIMIT $2 OFFSET $3`,
        [eventType, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM audit_log WHERE ($1::text IS NULL OR event_type = $1)`,
        [eventType]
      ),
    ]);
    return res.status(200).json({ limit, offset, total: countResult.rows[0].total, events: result.rows });
  } catch (err) {
    console.error('Error en GET /admin/audit-log:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

module.exports = app;

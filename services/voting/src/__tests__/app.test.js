// Pruebas de integración de voting-service contra la app de Express en
// memoria (Supertest, sin abrir puerto real) y la base real configurada por
// entorno (Supabase). No se llama a auth-service: los JWT se firman aquí
// mismo con JWT_SECRET, replicando exactamente el payload que auth-service
// emite en /login/admin y /login/voter. Todo dato que estas pruebas crean
// (plantillas, elecciones, opciones, votos, y un admin de prueba necesario
// para satisfacer el FK created_by) usa el prefijo CITEST-VOTING-<timestamp>
// para poder identificarlo y borrarlo sin riesgo al final (afterAll), sin
// tocar datos reales.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const pool = require('../db');

const RUN_ID = `CITEST-VOTING-${Date.now()}`;
const JWT_SECRET = process.env.JWT_SECRET;

function signAdmin(sub, role = 'admin') {
  return jwt.sign(
    { sub, username: `${RUN_ID}-${role}`, role },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10m' }
  );
}

function signVoter(hashSuffix) {
  return jwt.sign(
    {
      sub: 1,
      role: 'voter',
      voterIdHash: `${RUN_ID}-HASH-${hashSuffix}`,
      pollingPlace: 'Puesto CI',
      votingTable: 'Mesa CI',
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10m' }
  );
}

let adminToken;
let auditorToken;
let voter1Token;
let voter2Token;
let voter3Token;

let testAdminId;

// Elección activa #1: la elección "principal" usada para votar con éxito,
// probar doble voto, y servir de destino para el optionId "cruzado".
let activeElection1Id;
let optionAId;
let optionBId;

// Elección activa #2: solo existe para tener una opción que NO pertenece a
// la elección #1 (prueba de optionId inválido para la elección indicada).
let activeElection2Id;
let optionCId;

// Elección "scheduled" (fuera de ventana / no activa todavía): prueba del 403.
let scheduledElectionId;
let optionDId;

// Se llenan durante las pruebas de /admin/templates y /admin/elections.
let createdTemplateId;
let createdElectionId; // creada vía API en /admin/elections, para probar /stop

beforeAll(async () => {
  // Admin de prueba real en la tabla admins: elections.created_by y
  // election_templates.created_by tienen FK a admins(id), así que el "sub"
  // del JWT de admin debe apuntar a una fila que realmente exista, o los
  // INSERT de /admin/templates y /admin/elections fallarían con 500 por
  // violación de FK.
  const adminRow = await pool.query(
    `INSERT INTO admins (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`${RUN_ID}-ADMIN`]
  );
  testAdminId = adminRow.rows[0].id;

  adminToken = signAdmin(testAdminId, 'admin');
  auditorToken = signAdmin(999999, 'auditor'); // el auditor nunca escribe, no necesita FK real
  voter1Token = signVoter('1');
  voter2Token = signVoter('2');
  voter3Token = signVoter('3');

  const e1 = await pool.query(
    `INSERT INTO elections (title, status, scheduled_start, scheduled_end)
     VALUES ($1, 'active', now() - interval '1 hour', now() + interval '1 hour')
     RETURNING id`,
    [`${RUN_ID}-ACTIVE-1`]
  );
  activeElection1Id = e1.rows[0].id;

  const optA = await pool.query(
    `INSERT INTO election_options (election_id, label) VALUES ($1, $2) RETURNING id`,
    [activeElection1Id, 'Opcion A']
  );
  optionAId = optA.rows[0].id;

  const optB = await pool.query(
    `INSERT INTO election_options (election_id, label) VALUES ($1, $2) RETURNING id`,
    [activeElection1Id, 'Opcion B']
  );
  optionBId = optB.rows[0].id;

  const e2 = await pool.query(
    `INSERT INTO elections (title, status, scheduled_start, scheduled_end)
     VALUES ($1, 'active', now() - interval '1 hour', now() + interval '1 hour')
     RETURNING id`,
    [`${RUN_ID}-ACTIVE-2`]
  );
  activeElection2Id = e2.rows[0].id;

  const optC = await pool.query(
    `INSERT INTO election_options (election_id, label) VALUES ($1, $2) RETURNING id`,
    [activeElection2Id, 'Opcion C (otra elección)']
  );
  optionCId = optC.rows[0].id;

  const eSched = await pool.query(
    `INSERT INTO elections (title, status, scheduled_start, scheduled_end)
     VALUES ($1, 'scheduled', now() + interval '1 hour', now() + interval '2 hours')
     RETURNING id`,
    [`${RUN_ID}-SCHEDULED`]
  );
  scheduledElectionId = eSched.rows[0].id;

  const optD = await pool.query(
    `INSERT INTO election_options (election_id, label) VALUES ($1, $2) RETURNING id`,
    [scheduledElectionId, 'Opcion D']
  );
  optionDId = optD.rows[0].id;
});

afterAll(async () => {
  // Orden importa por las FK: primero elections (cascada a election_options
  // y votes), luego election_templates (cascada a template_options), y por
  // último el admin de prueba (referenciado por created_by en las dos
  // tablas anteriores, sin ON DELETE CASCADE).
  await pool.query('DELETE FROM elections WHERE title LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM election_templates WHERE name LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM admins WHERE username LIKE $1', [`${RUN_ID}%`]);
  await pool.end();
});

describe('GET /health', () => {
  it('responde 200 sin autenticación', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'voting' });
  });
});

describe('POST /vote', () => {
  it('rechaza sin token (401)', async () => {
    const res = await request(app)
      .post('/vote')
      .send({ electionId: activeElection1Id, optionId: optionAId });
    expect(res.status).toBe(401);
  });

  it('rechaza un token que no es de votante, p.ej. uno de admin (403)', async () => {
    const res = await request(app)
      .post('/vote')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ electionId: activeElection1Id, optionId: optionAId });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Este token no es válido para votar');
  });

  it('registra un voto exitoso con un JWT de votante válido (201)', async () => {
    const res = await request(app)
      .post('/vote')
      .set('Authorization', `Bearer ${voter1Token}`)
      .send({ electionId: activeElection1Id, optionId: optionAId });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Voto registrado correctamente');
  });

  it('rechaza el doble voto del mismo votante en la misma elección (409)', async () => {
    const res = await request(app)
      .post('/vote')
      .set('Authorization', `Bearer ${voter1Token}`)
      .send({ electionId: activeElection1Id, optionId: optionBId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Ya se registró un voto para esta elección');
  });

  it('rechaza votar en una elección fuera de ventana / no activa todavía (403)', async () => {
    const res = await request(app)
      .post('/vote')
      .set('Authorization', `Bearer ${voter2Token}`)
      .send({ electionId: scheduledElectionId, optionId: optionDId });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no existe, aún no abre, ya cerró, ya fue detenida, o no está activa/);
  });

  it('rechaza un optionId que no pertenece a la elección indicada (400)', async () => {
    const res = await request(app)
      .post('/vote')
      .set('Authorization', `Bearer ${voter3Token}`)
      .send({ electionId: activeElection1Id, optionId: optionCId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Opción inválida para esta elección');
  });

  it('rechaza electionId/optionId no numéricos (400, nunca 500)', async () => {
    const res = await request(app)
      .post('/vote')
      .set('Authorization', `Bearer ${voter3Token}`)
      .send({ electionId: 'no-es-un-numero', optionId: optionAId });
    expect(res.status).toBe(400);
  });
});

describe('GET /my-votes', () => {
  it('rechaza sin token (401)', async () => {
    const res = await request(app).get('/my-votes');
    expect(res.status).toBe(401);
  });

  it('devuelve solo electionId y createdAt, nunca el nombre de la elección ni la opción elegida', async () => {
    const res = await request(app)
      .get('/my-votes')
      .set('Authorization', `Bearer ${voter1Token}`);
    expect(res.status).toBe(200);
    const vote = res.body.votes.find((v) => v.electionId === activeElection1Id);
    expect(vote).toBeDefined();
    // Ni "title"/"electionName" ni "optionId"/"optionLabel": el historial del
    // votante solo puede decir "votaste, a esta hora", nunca en qué.
    expect(Object.keys(vote).sort()).toEqual(['createdAt', 'electionId']);
  });
});

describe('GET /elections/:id/options (pública)', () => {
  it('devuelve las opciones de una elección sin necesitar autenticación', async () => {
    const res = await request(app).get(`/elections/${activeElection1Id}/options`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((o) => o.label).sort()).toEqual(['Opcion A', 'Opcion B']);
  });

  it('rechaza un id de elección no numérico (400)', async () => {
    const res = await request(app).get('/elections/no-es-un-id/options');
    expect(res.status).toBe(400);
  });
});

describe('GET /elections/active (pública)', () => {
  it('lista solo elecciones activas dentro de ventana, con sus opciones, y excluye las programadas', async () => {
    const res = await request(app).get('/elections/active');
    expect(res.status).toBe(200);
    const ids = res.body.map((e) => e.id);
    expect(ids).toContain(activeElection1Id);
    expect(ids).toContain(activeElection2Id);
    expect(ids).not.toContain(scheduledElectionId);

    const found = res.body.find((e) => e.id === activeElection1Id);
    expect(found.options).toHaveLength(2);
  });
});

describe('POST /admin/templates y GET /admin/templates', () => {
  it('POST rechaza sin token (401)', async () => {
    const res = await request(app)
      .post('/admin/templates')
      .send({ name: `${RUN_ID}-TPL-NOAUTH`, options: ['A', 'B'] });
    expect(res.status).toBe(401);
  });

  it('POST rechaza a un auditor con 403 (crear plantillas es solo admin)', async () => {
    const res = await request(app)
      .post('/admin/templates')
      .set('Authorization', `Bearer ${auditorToken}`)
      .send({ name: `${RUN_ID}-TPL-AUDITOR`, options: ['A', 'B'] });
    expect(res.status).toBe(403);
  });

  it('POST rechaza datos inválidos, p.ej. un nombre demasiado corto (400)', async () => {
    const res = await request(app)
      .post('/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ab', options: ['A', 'B'] });
    expect(res.status).toBe(400);
  });

  it('POST crea una plantilla genérica con un admin autenticado (201)', async () => {
    const res = await request(app)
      .post('/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `${RUN_ID}-TPL-GENERIC`, templateType: 'generic', options: ['Opcion 1', 'Opcion 2'] });
    expect(res.status).toBe(201);
    expect(res.body.templateId).toEqual(expect.any(Number));
    expect(res.body.templateType).toBe('generic');
    expect(res.body.optionsCount).toBe(2);
    createdTemplateId = res.body.templateId;
  });

  it('GET rechaza sin token (401)', async () => {
    const res = await request(app).get('/admin/templates');
    expect(res.status).toBe(401);
  });

  it('GET rechaza a un auditor con 403 (lectura de plantillas también es solo admin)', async () => {
    const res = await request(app)
      .get('/admin/templates')
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(res.status).toBe(403);
  });

  it('GET devuelve la plantilla creada, con sus opciones, a un admin', async () => {
    const res = await request(app)
      .get('/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const found = res.body.find((t) => t.id === createdTemplateId);
    expect(found).toBeDefined();
    expect(found.name).toBe(`${RUN_ID}-TPL-GENERIC`);
    expect(found.options.map((o) => o.label).sort()).toEqual(['Opcion 1', 'Opcion 2']);
  });
});

describe('POST /admin/elections y GET /admin/elections', () => {
  it('POST rechaza sin token (401)', async () => {
    const res = await request(app)
      .post('/admin/elections')
      .send({
        templateId: createdTemplateId,
        title: `${RUN_ID}-ELECCION-NOAUTH`,
        scheduledStart: new Date(Date.now() + 3600_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 7200_000).toISOString(),
      });
    expect(res.status).toBe(401);
  });

  it('POST rechaza a un auditor con 403 (crear elecciones es solo admin)', async () => {
    const res = await request(app)
      .post('/admin/elections')
      .set('Authorization', `Bearer ${auditorToken}`)
      .send({
        templateId: createdTemplateId,
        title: `${RUN_ID}-ELECCION-AUDITOR`,
        scheduledStart: new Date(Date.now() + 3600_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 7200_000).toISOString(),
      });
    expect(res.status).toBe(403);
  });

  it('POST rechaza scheduledEnd anterior o igual a scheduledStart (400)', async () => {
    const res = await request(app)
      .post('/admin/elections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: createdTemplateId,
        title: `${RUN_ID}-ELECCION-BADWINDOW`,
        scheduledStart: new Date(Date.now() + 7200_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 3600_000).toISOString(),
      });
    expect(res.status).toBe(400);
  });

  it('POST rechaza un templateId que no existe (404)', async () => {
    const res = await request(app)
      .post('/admin/elections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: 999999999,
        title: `${RUN_ID}-ELECCION-NOPLANTILLA`,
        scheduledStart: new Date(Date.now() + 3600_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 7200_000).toISOString(),
      });
    expect(res.status).toBe(404);
  });

  it('POST instancia una elección a partir de la plantilla, en estado "scheduled" (201)', async () => {
    const res = await request(app)
      .post('/admin/elections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: createdTemplateId,
        title: `${RUN_ID}-ELECCION-API`,
        // scheduledStart en el pasado reciente: simula una elección cuya
        // ventana ya arrancó pero que el scheduler-worker (no corre en este
        // test) todavía no pasó a "active". Se usa así, en vez de con
        // scheduledStart futuro, para poder detenerla en el describe de
        // /stop más abajo sin chocar con el CHECK valid_time_window (ver
        // nota ahí sobre el caso "scheduled" con inicio futuro).
        scheduledStart: new Date(Date.now() - 5 * 60_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 3600_000).toISOString(),
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scheduled');
    createdElectionId = res.body.electionId;
  });

  it('GET rechaza sin token (401)', async () => {
    const res = await request(app).get('/admin/elections');
    expect(res.status).toBe(401);
  });

  it('GET acepta a un auditor (200) — a diferencia de plantillas, la lectura de elecciones es admin+auditor', async () => {
    const res = await request(app)
      .get('/admin/elections')
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(res.status).toBe(200);
    const found = res.body.find((e) => e.id === createdElectionId);
    expect(found).toBeDefined();
    expect(found.template_name).toBe(`${RUN_ID}-TPL-GENERIC`);
  });

  it('GET acepta a un admin (200)', async () => {
    const res = await request(app)
      .get('/admin/elections')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.id === createdElectionId)).toBe(true);
  });
});

describe('POST /admin/elections/:id/stop', () => {
  it('rechaza sin token (401)', async () => {
    const res = await request(app).post(`/admin/elections/${createdElectionId}/stop`);
    expect(res.status).toBe(401);
  });

  it('rechaza a un auditor con 403 (detener es solo admin)', async () => {
    const res = await request(app)
      .post(`/admin/elections/${createdElectionId}/stop`)
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(res.status).toBe(403);
  });

  it('detiene la elección creada por API: pasa a "closed" de inmediato (200)', async () => {
    const res = await request(app)
      .post(`/admin/elections/${createdElectionId}/stop`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.election.status).toBe('closed');
  });

  it('detenerla de nuevo devuelve 409 (ya estaba cerrada)', async () => {
    const res = await request(app)
      .post(`/admin/elections/${createdElectionId}/stop`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
  });

  // Regresión: una elección "scheduled" con scheduled_start en el FUTURO
  // (nunca llegó a abrir) violaba el CHECK valid_time_window al detenerla
  // (scheduled_end quedaba antes que scheduled_start) y respondía 500 en vez
  // de cerrarla. Arreglado en services/voting/src/app.js (POST /admin/elections/:id/stop).
  it('detener una elección programada que AÚN NO abre (scheduled_start futuro) responde 200, no 500', async () => {
    const futureElection = await pool.query(
      `INSERT INTO elections (title, template_id, status, scheduled_start, scheduled_end)
       VALUES ($1, $2, 'scheduled', now() + interval '1 hour', now() + interval '2 hours')
       RETURNING id`,
      [`${RUN_ID}-ELECCION-FUTURA`, createdTemplateId]
    );
    const futureElectionId = futureElection.rows[0].id;

    const res = await request(app)
      .post(`/admin/elections/${futureElectionId}/stop`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.election.status).toBe('closed');

    await pool.query('DELETE FROM elections WHERE id = $1', [futureElectionId]);
  });
});

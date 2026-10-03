// Pruebas de integración de analytics-service contra la app de Express en
// memoria (Supertest, sin abrir puerto real) y un PostgreSQL de verdad: el
// desechable que levanta scripts/lib/jest-db-setup.js para esta corrida (o
// el de DB_HOST, si viene definido). Todo dato que estas pruebas crean (elección + sus
// opciones + los tableros de reporte) usa el prefijo único CITEST-ANALYTICS-
// para poder identificarlo y borrarlo sin riesgo al final (afterAll), sin
// tocar datos reales de otras elecciones.
//
// Los JWT se firman aquí mismo (no se llama a auth-service): mismo shape
// exacto que usa auth-service en POST /login/admin
// ({ sub, username, role }, HS256) para que el middleware requireRole de
// analytics los acepte igual que a uno emitido de verdad.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const pool = require('../db');

const RUN_ID = `CITEST-ANALYTICS-${Date.now()}`;
const JWT_SECRET = process.env.JWT_SECRET;

let adminToken;
let auditorToken;
let voterToken; // rol válido en el sistema pero no autorizado en analytics
let electionId;
let optionIds = [];
let dashboardId;

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

beforeAll(async () => {
  // El INSERT de report_dashboards guarda created_by con una FK real hacia
  // admins(id) (ver POST /api/elections/:id/dashboards en app.js), así que
  // hace falta una fila real: se crea un admin propio de la prueba (igual
  // que en voting; su password_hash no es un bcrypt válido, así que nadie
  // puede iniciar sesión con él) y se borra en el afterAll.
  const testAdmin = await pool.query(
    `INSERT INTO admins (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`${RUN_ID}-admin`]
  );
  const realAdminId = testAdmin.rows[0].id;

  adminToken = signToken({ sub: realAdminId, username: `${RUN_ID}-admin`, role: 'admin' });
  // El sub del auditor nunca se persiste (las rutas de escritura son
  // admin-only y el auditor recibe 403 antes de tocar la base), así que no
  // hace falta que corresponda a una fila real.
  auditorToken = signToken({ sub: 999999999, username: `${RUN_ID}-auditor`, role: 'auditor' });
  voterToken = signToken({ sub: 1, username: 'voter-de-prueba', role: 'voter' });

  const electionRes = await pool.query(
    `INSERT INTO elections (title, status, scheduled_start, scheduled_end, created_by)
     VALUES ($1, 'active', now() - interval '1 hour', now() + interval '1 hour', $2)
     RETURNING id`,
    [RUN_ID, realAdminId]
  );
  electionId = electionRes.rows[0].id;

  const optionsRes = await pool.query(
    `INSERT INTO election_options (election_id, label, candidate_number)
     VALUES ($1, 'CITEST Opción A', '1'), ($1, 'CITEST Opción B', '2')
     RETURNING id`,
    [electionId]
  );
  optionIds = optionsRes.rows.map((r) => r.id);
});

afterAll(async () => {
  // Orden importa por las foreign keys: dashboards y options referencian a
  // elections, y elections y dashboards al admin de prueba, así que ese va
  // al final.
  await pool.query('DELETE FROM report_dashboards WHERE election_id = $1', [electionId]);
  await pool.query('DELETE FROM election_options WHERE election_id = $1', [electionId]);
  await pool.query('DELETE FROM elections WHERE id = $1', [electionId]);
  await pool.query('DELETE FROM admins WHERE username = $1', [`${RUN_ID}-admin`]);
  await pool.end();
});

describe('GET /health', () => {
  it('responde 200 sin autenticación', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'analytics' });
  });
});

describe('Autenticación / control de acceso en /api', () => {
  it('rechaza sin token con 401', async () => {
    const res = await request(app).get(`/api/elections/${electionId}/results`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('rechaza un token de un rol no autorizado (voter) con 403', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/results`)
      .set('Authorization', `Bearer ${voterToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Permisos insuficientes');
  });

  it('rechaza un token inválido/mal formado con 401', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/results`)
      .set('Authorization', 'Bearer token-basura-no-es-un-jwt');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/elections/:id/results', () => {
  it('rechaza un id no numérico con 400', async () => {
    const res = await request(app)
      .get('/api/elections/no-es-un-id/results')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('devuelve 404 para una elección que no existe', async () => {
    const res = await request(app)
      .get('/api/elections/999999999/results')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('en vivo (elección activa, sin acta) solo devuelve el total de votos, no los votos por opción', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/results`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.certified).toBe(false);
    expect(res.body.resultsHidden).toBe(true);
    expect(res.body.totalVotes).toBe(0);
    expect(res.body.results).toBeUndefined();
    expect(res.body.concentration).toBeUndefined();
  });

  it('un auditor también puede leer el total en vivo (solo lectura)', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/results`)
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.resultsHidden).toBe(true);
    expect(res.body.totalVotes).toBe(0);
  });
});

describe('GET /api/elections/:id/metrics/timeseries', () => {
  it('devuelve puntos vacíos (sin votos) agrupados por hora', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/timeseries?interval=hour`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.interval).toBe('hour');
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.points).toHaveLength(0);
  });

  it('acepta interval=day también', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/timeseries?interval=day`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.interval).toBe('day');
  });

  it('rechaza un interval fuera de la whitelist con 400', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/timeseries?interval=week`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/elections/:id/metrics/participation', () => {
  it('agrupa por puesto de votación (polling_place) por defecto', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/participation?groupBy=polling_place`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.groupBy).toBe('polling_place');
    expect(Array.isArray(res.body.groups)).toBe(true);
    // Sin votos emitidos en esta elección, ningún grupo debería tener
    // votesCast asociado a ella (los registered vienen del padrón real, que
    // sí puede tener filas, pero votesCast siempre en 0 para este electionId).
    for (const g of res.body.groups) {
      expect(g).toEqual(
        expect.objectContaining({ group: expect.any(String), registered: expect.any(Number), votesCast: 0 })
      );
    }
  });

  it('agrupa por mesa (voting_table) cuando se pide explícitamente', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/participation?groupBy=voting_table`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.groupBy).toBe('voting_table');
  });

  it('rechaza un groupBy fuera de la whitelist con 400', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/participation?groupBy=algo_invalido`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/elections/:id/metrics/operational', () => {
  it('devuelve métricas operativas en cero para una elección sin votos', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/operational`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.totalVotes).toBe(0);
    expect(res.body.votesPerMinute).toBe(0);
    expect(res.body.tablesWithVotes).toBe(0);
    expect(typeof res.body.totalTables).toBe('number');
  });

  it('devuelve 404 para una elección que no existe', async () => {
    const res = await request(app)
      .get('/api/elections/999999999/metrics/operational')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Estadística: concentración (HHI), participación con IC 95% y anomalías', () => {
  // Timestamps historicos fijos (no relativos a "now()") para que los
  // buckets horarios de date_trunc caigan siempre en el mismo lugar, sin
  // depender de en qué segundo/minuto real corra la prueba.
  const crypto = require('crypto');
  const { encryptField } = require('../voterCrypto');
  function fakeHash() {
    return crypto.randomBytes(32).toString('hex');
  }
  // 30 votantes propios en el padrón (cifrados, como los deja auth-service):
  // la tasa de participación se calcula sobre el padrón, y la base de
  // pruebas empieza con el padrón vacío.
  const TEST_CEDULAS = Array.from({ length: 30 }, (_, i) => `CI-AN-${Date.now().toString().slice(-8)}-${i}`);

  afterAll(async () => {
    await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [TEST_CEDULAS.map(encryptField)]);
  });

  beforeAll(async () => {
    for (const cedula of TEST_CEDULAS) {
      await pool.query(
        `INSERT INTO voters (cedula, full_name, polling_place, voting_table) VALUES ($1, $2, $3, $4)`,
        [encryptField(cedula), 'Votante de Prueba CI', encryptField('Puesto Central'), encryptField('Mesa 1')]
      );
    }

    // 5 votos para la opción A repartidos en 5 horas distintas (1 por
    // bucket) + 10 votos para la opción B, todos en una sexta hora: un pico
    // deliberado para que el detector de anomalías tenga algo que marcar,
    // y una distribución de votos desigual (5 vs 10 de 15) para que el HHI
    // dé un valor de concentración "alta" verificable a mano.
    const rows = [];
    for (let h = 8; h <= 12; h++) {
      rows.push([electionId, optionIds[0], fakeHash(), 'Puesto Central', 'Mesa 1', `2020-01-01 ${h}:00:00+00`]);
    }
    for (let i = 0; i < 10; i++) {
      rows.push([electionId, optionIds[1], fakeHash(), 'Puesto Central', 'Mesa 1', '2020-01-01 13:00:00+00']);
    }
    for (const row of rows) {
      await pool.query(
        `INSERT INTO votes (election_id, option_id, voter_id_hash, polling_place, voting_table, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        row
      );
    }
    // No hace falta limpieza propia: "votes.election_id" referencia a
    // "elections" con ON DELETE CASCADE, así que el afterAll de arriba (que
    // borra la elección de prueba) se lleva estos votos con ella.
  });

  it('/results con la elección activa cuenta los 15 votos, pero no dice cuántos tiene cada opción', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/results`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalVotes).toBe(15);
    expect(res.body.results).toBeUndefined();
    expect(res.body.concentration).toBeUndefined();
    // Ni siquiera las etiquetas: el orden en que vinieran ya diría quién va primero.
    expect(JSON.stringify(res.body)).not.toContain('CITEST Opción');
  });

  it('/metrics/operational calcula la tasa de participación con un intervalo de confianza 95% coherente', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/operational`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalVotes).toBe(15);
    expect(res.body.participationRate).toBeGreaterThan(0);
    expect(res.body.participationCi95.low).toBeGreaterThanOrEqual(0);
    expect(res.body.participationCi95.high).toBeLessThanOrEqual(100);
    // El intervalo siempre debe contener a la tasa puntual, y el límite
    // inferior nunca puede superar al superior.
    expect(res.body.participationCi95.low).toBeLessThanOrEqual(res.body.participationRate);
    expect(res.body.participationCi95.high).toBeGreaterThanOrEqual(res.body.participationRate);
  });

  it('/metrics/timeseries marca como anomalía el bucket con el pico de 10 votos', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/timeseries?interval=hour`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(6);
    expect(Array.isArray(res.body.anomalies)).toBe(true);
    expect(res.body.anomalies).toHaveLength(1);
    expect(res.body.anomalies[0].votes).toBe(10);
    expect(Math.abs(res.body.anomalies[0].zScore)).toBeGreaterThan(2);
  });

  it('con menos de 4 buckets no marca anomalías, aunque haya un valor mucho más alto que el resto', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/timeseries?interval=day`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Agrupado por día, los 15 votos caen en un único bucket (mismo día
    // histórico) — con 1 solo punto no hay suficiente muestra para un
    // z-score confiable, así que debe devolver un arreglo vacío.
    expect(res.body.points.length).toBeLessThan(4);
    expect(res.body.anomalies).toEqual([]);
  });
});

// Estadística avanzada (lógica en advancedStats.js, probada a fondo en
// advancedStats.test.js). Acá se prueba el cableado de cada ruta contra la
// base real: validación, 404, permisos y forma de la respuesta. Corre
// después del bloque anterior, así que la elección de prueba ya tiene los
// 15 votos (5 a A, 10 a B) que ese bloque sembró.
describe('Estadística avanzada: proyección, momento de definición, integridad y accesos', () => {
  const routes = ['turnout-projection', 'lead-timeline', 'integrity', 'suspicious-access'];

  it.each(routes)('/metrics/%s rechaza un id no numérico con 400', async (route) => {
    const res = await request(app)
      .get(`/api/elections/abc/metrics/${route}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it.each(routes)('/metrics/%s devuelve 404 para una elección que no existe', async (route) => {
    const res = await request(app)
      .get(`/api/elections/999999999/metrics/${route}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it.each(routes)('/metrics/%s rechaza un rol no autorizado (voter) con 403', async (route) => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/${route}`)
      .set('Authorization', `Bearer ${voterToken}`);
    expect(res.status).toBe(403);
  });

  it('/metrics/turnout-projection proyecta la elección activa con sus 15 votos', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/turnout-projection`)
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.votesSoFar).toBe(15);
    // Ventana de 2 h con 1 h transcurrida y 15 votos: supera los mínimos.
    expect(res.body.state).toBe('en_curso');
    expect(['historico', 'ritmo_constante']).toContain(res.body.method);
    expect(res.body.projectedVotes).toBeGreaterThanOrEqual(15);
    expect(res.body.interval.lowPct).toBeLessThanOrEqual(res.body.projectedTurnoutPct);
    expect(res.body.interval.highPct).toBeGreaterThanOrEqual(res.body.projectedTurnoutPct);
  });

  it('/metrics/lead-timeline no dice quién va adelante mientras la elección no tiene acta', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/lead-timeline`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('oculto_hasta_certificar');
    expect(res.body.currentLeader).toBeUndefined();
    expect(res.body.checkpoints).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('CITEST Opción');
  });

  it('/metrics/integrity: una elección activa todavía no tiene acta', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/integrity`)
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('sin_certificar');
  });

  it('/metrics/suspicious-access devuelve totales, motivos y alertas de la ventana de la elección', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/suspicious-access`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.windowMinutes).toBe(15);
    expect(res.body.totals.attempts).toBe(res.body.totals.failures + res.body.totals.successes);
    expect(Array.isArray(res.body.alerts)).toBe(true);
    expect(new Date(res.body.window.to) >= new Date(res.body.window.from)).toBe(true);
  });
});

// Con el acta certificada, los resultados se publican completos. El acta se
// inserta acá directamente (sin pasar por scrutiny-service): solo importa
// lo que analytics hace con ella. OJO: scrutiny_ledger es APPEND-ONLY, así
// que esa fila y la elección a la que apunta quedan en la base desechable
// de la corrida (igual que en las pruebas de scrutiny); el afterAll borra lo
// que sí se puede (votos y opciones).
describe('Elección certificada: los votos por opción se publican', () => {
  const crypto = require('crypto');
  let closedId;
  let options;
  // Otra IP de origen (la app confía en un proxy, ver "trust proxy"): el
  // archivo completo supera las 60 lecturas por minuto del límite por IP.
  const get = (path) =>
    request(app).get(path).set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', '203.0.113.77');

  beforeAll(async () => {
    const election = await pool.query(
      `INSERT INTO elections (title, status, scheduled_start, scheduled_end, created_by)
       VALUES ($1, 'closed', '2020-01-01 07:00:00+00', '2020-01-01 14:00:00+00', NULL) RETURNING id`,
      // Sin creador: esta elección no se puede borrar (la retiene el acta), y
      // si apuntara al admin de prueba, el afterAll general no podría borrarlo.
      [`${RUN_ID}-cerrada`]
    );
    closedId = election.rows[0].id;
    const opts = await pool.query(
      `INSERT INTO election_options (election_id, label, candidate_number)
       VALUES ($1, 'CITEST Cerrada A', '1'), ($1, 'CITEST Cerrada B', '2') RETURNING id, label, candidate_number`,
      [closedId]
    );
    options = opts.rows;
    // Igual que la elección activa: 5 votos a A (uno por hora) y 10 a B al final.
    for (let h = 8; h <= 12; h++) {
      await pool.query(
        `INSERT INTO votes (election_id, option_id, voter_id_hash, polling_place, voting_table, created_at)
         VALUES ($1, $2, $3, 'Puesto Central', 'Mesa 1', $4)`,
        [closedId, options[0].id, crypto.randomBytes(32).toString('hex'), `2020-01-01 ${h}:00:00+00`]
      );
    }
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `INSERT INTO votes (election_id, option_id, voter_id_hash, polling_place, voting_table, created_at)
         VALUES ($1, $2, $3, 'Puesto Central', 'Mesa 1', '2020-01-01 13:00:00+00')`,
        [closedId, options[1].id, crypto.randomBytes(32).toString('hex')]
      );
    }
    const overall = [
      { optionId: options[1].id, candidateNumber: '2', label: 'CITEST Cerrada B', logo: null, votes: 10 },
      { optionId: options[0].id, candidateNumber: '1', label: 'CITEST Cerrada A', logo: null, votes: 5 },
    ];
    const results = {
      overall,
      byTable: [{ pollingPlace: 'Puesto Central', votingTable: 'Mesa 1', totalVotes: 15, results: overall }],
      winner: { ...overall[0], tie: false, tiedWith: [] },
    };
    await pool.query(
      `INSERT INTO scrutiny_ledger (election_id, total_votes, results, previous_hash, record_hash)
       VALUES ($1, 15, $2, $3, $4)`,
      [closedId, JSON.stringify(results), '0'.repeat(64), crypto.randomBytes(32).toString('hex')]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM votes WHERE election_id = $1', [closedId]);
    await pool.query('DELETE FROM election_options WHERE election_id = $1', [closedId]);
  });

  it('/results devuelve el acta: votos por opción, ganador y concentración (HHI)', async () => {
    const res = await get(`/api/elections/${closedId}/results`);
    expect(res.status).toBe(200);
    expect(res.body.certified).toBe(true);
    expect(res.body.resultsHidden).toBeUndefined();
    expect(res.body.totalVotes).toBe(15);
    expect(res.body.results.map((r) => r.votes)).toEqual([10, 5]);
    expect(res.body.winner.label).toBe('CITEST Cerrada B');
    // Reparto real: 33.33%^2 + 66.67%^2 ≈ 5556.
    expect(res.body.concentration.hhi).toBeGreaterThan(5000);
    expect(res.body.concentration.hhi).toBeLessThan(6000);
    expect(res.body.concentration.level).toBe('alta');
  });

  it('/metrics/lead-timeline dice quién ganó y cuándo pasó a liderar', async () => {
    const res = await get(`/api/elections/${closedId}/metrics/lead-timeline`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ok');
    expect(res.body.totalVotes).toBe(15);
    expect(res.body.currentLeader.label).toBe('CITEST Cerrada B');
  });
});

describe('Elección cerrada que el escrutinio todavía no certificó', () => {
  let pendingId;
  const get = (path) =>
    request(app).get(path).set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', '203.0.113.78');

  beforeAll(async () => {
    const election = await pool.query(
      `INSERT INTO elections (title, status, scheduled_start, scheduled_end, created_by)
       VALUES ($1, 'closed', now() - interval '2 hours', now() - interval '1 minute', NULL) RETURNING id`,
      [`${RUN_ID}-por-certificar`]
    );
    pendingId = election.rows[0].id;
    const opt = await pool.query(
      `INSERT INTO election_options (election_id, label) VALUES ($1, 'CITEST Por certificar') RETURNING id`,
      [pendingId]
    );
    await pool.query(
      `INSERT INTO votes (election_id, option_id, voter_id_hash, polling_place, voting_table)
       VALUES ($1, $2, $3, 'Puesto Central', 'Mesa 1')`,
      [pendingId, opt.rows[0].id, require('crypto').randomBytes(32).toString('hex')]
    );
  });

  afterAll(async () => {
    // Sin acta, esta elección sí se puede borrar.
    await pool.query('DELETE FROM votes WHERE election_id = $1', [pendingId]);
    await pool.query('DELETE FROM election_options WHERE election_id = $1', [pendingId]);
    await pool.query('DELETE FROM elections WHERE id = $1', [pendingId]);
  });

  it('/results responde 202 con el total, sin votos por opción', async () => {
    const res = await get(`/api/elections/${pendingId}/results`);
    expect(res.status).toBe(202);
    expect(res.body.resultsHidden).toBe(true);
    expect(res.body.totalVotes).toBe(1);
    expect(res.body.results).toBeUndefined();
  });

  it('/metrics/lead-timeline sigue oculto hasta que haya acta', async () => {
    const res = await get(`/api/elections/${pendingId}/metrics/lead-timeline`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('oculto_hasta_certificar');
  });
});

describe('GET /api/elections/:id/metrics/audit', () => {
  it('devuelve un arreglo de eventos (vacío para una elección recién creada)', async () => {
    const res = await request(app)
      .get(`/api/elections/${electionId}/metrics/audit`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events).toHaveLength(0);
  });
});

describe('CRUD de /api/elections/:id/dashboards y /api/dashboards/:dashboardId', () => {
  it('POST rechaza sin token con 401', async () => {
    const res = await request(app)
      .post(`/api/elections/${electionId}/dashboards`)
      .send({ name: 'No debería crearse' });
    expect(res.status).toBe(401);
  });

  it('POST rechaza a un auditor con 403 (solo admin puede escribir)', async () => {
    const res = await request(app)
      .post(`/api/elections/${electionId}/dashboards`)
      .set('Authorization', `Bearer ${auditorToken}`)
      .send({ name: 'No debería crearse' });
    expect(res.status).toBe(403);
  });

  it('POST rechaza un body sin name con 400', async () => {
    const res = await request(app)
      .post(`/api/elections/${electionId}/dashboards`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST crea un tablero cuando lo pide un admin', async () => {
    const res = await request(app)
      .post(`/api/elections/${electionId}/dashboards`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `${RUN_ID}-dashboard`, layout: { widgets: [{ type: 'timeseries' }] } });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${RUN_ID}-dashboard`);
    expect(res.body.electionId).toBe(electionId);
    expect(res.body.layout).toEqual({ widgets: [{ type: 'timeseries' }] });
    dashboardId = res.body.id;
  });

  it('GET lista los tableros de la elección, tanto para admin como para auditor', async () => {
    const asAdmin = await request(app)
      .get(`/api/elections/${electionId}/dashboards`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.dashboards.some((d) => d.id === dashboardId)).toBe(true);

    const asAuditor = await request(app)
      .get(`/api/elections/${electionId}/dashboards`)
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(asAuditor.status).toBe(200);
    expect(asAuditor.body.dashboards.some((d) => d.id === dashboardId)).toBe(true);
  });

  it('GET lista rechaza sin token con 401', async () => {
    const res = await request(app).get(`/api/elections/${electionId}/dashboards`);
    expect(res.status).toBe(401);
  });

  it('GET por id devuelve el tablero, tanto para admin como para auditor', async () => {
    const asAdmin = await request(app)
      .get(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.id).toBe(dashboardId);

    const asAuditor = await request(app)
      .get(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(asAuditor.status).toBe(200);
  });

  it('GET por id devuelve 404 para un tablero que no existe', async () => {
    const res = await request(app)
      .get('/api/dashboards/999999999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT rechaza a un auditor con 403', async () => {
    const res = await request(app)
      .put(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${auditorToken}`)
      .send({ name: 'Intento de auditor' });
    expect(res.status).toBe(403);
  });

  it('PUT actualiza el tablero cuando lo pide un admin', async () => {
    const res = await request(app)
      .put(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `${RUN_ID}-dashboard-editado`, layout: { widgets: [] } });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`${RUN_ID}-dashboard-editado`);
    expect(res.body.id).toBe(dashboardId);
  });

  it('DELETE rechaza a un auditor con 403', async () => {
    const res = await request(app)
      .delete(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${auditorToken}`);
    expect(res.status).toBe(403);
  });

  it('DELETE borra el tablero cuando lo pide un admin, y luego un GET devuelve 404', async () => {
    const del = await request(app)
      .delete(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(204);

    const getAfterDelete = await request(app)
      .get(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getAfterDelete.status).toBe(404);
  });
});

describe('GET /api/dashboard/summary', () => {
  it('rechaza sin token con 401', async () => {
    const res = await request(app).get('/api/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('devuelve los totales globales del sistema', async () => {
    const res = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('active_polls');
    expect(res.body).toHaveProperty('total_votes');
    // Nuestra elección de prueba está 'active', así que el conteo global
    // de elecciones activas debe ser al menos 1.
    expect(Number(res.body.active_polls)).toBeGreaterThanOrEqual(1);
  });
});

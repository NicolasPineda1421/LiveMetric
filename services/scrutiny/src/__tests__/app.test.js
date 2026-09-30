// Pruebas de integración de scrutiny-service contra la app de Express en
// memoria (Supertest, sin abrir puerto real) y un PostgreSQL de verdad: el
// desechable que levanta scripts/lib/jest-db-setup.js para esta corrida (o
// el de DB_HOST, si viene definido). Todo dato que estas pruebas crean usa el prefijo
// CITEST-SCRUTINY-<timestamp> para poder identificarlo después.
//
// OJO: la tabla scrutiny_ledger es APPEND-ONLY (trigger prevent_row_mutation
// bloquea UPDATE/DELETE, incluso desde estas pruebas — es una característica
// de seguridad del sistema, no un bug). Por eso:
//   - Certificamos UNA sola elección de prueba en todo el archivo, y
//     reutilizamos esa misma elección para los casos de idempotencia,
//     /certifications/:id y el PDF.
//   - En afterAll solo borramos "votes" y "election_options" (eso sí se
//     puede). La fila de "elections" y la fila de "scrutiny_ledger" quedan
//     PERMANENTEMENTE en la base a propósito: no se borran ni se intenta
//     borrar la elección, porque el acta la referencia por FK y el trigger
//     de append-only bloquearía cualquier intento de propagar el borrado.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../app');
const pool = require('../db');
const { computeRecordHash } = require('../hashChain');
const { keyIdOf, loadPublicKey } = require('../actaSignature');

const RUN_ID = `CITEST-SCRUTINY-${Date.now()}`;
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

function signAdminToken() {
  return jwt.sign({ sub: 1, username: 'ci-admin', role: 'admin' }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
}

function randomVoterHash() {
  return crypto.randomBytes(32).toString('hex'); // CHAR(64)
}

async function createElection({ status, title }) {
  const now = Date.now();
  const res = await pool.query(
    `INSERT INTO elections (title, status, scheduled_start, scheduled_end)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, status, new Date(now - 60 * 60 * 1000), new Date(now + 60 * 60 * 1000)]
  );
  return res.rows[0].id;
}

async function createOption(electionId, label, candidateNumber) {
  const res = await pool.query(
    `INSERT INTO election_options (election_id, label, candidate_number) VALUES ($1, $2, $3) RETURNING id`,
    [electionId, label, candidateNumber]
  );
  return res.rows[0].id;
}

async function createVote(electionId, optionId, pollingPlace, votingTable) {
  await pool.query(
    `INSERT INTO votes (election_id, option_id, voter_id_hash, polling_place, voting_table)
     VALUES ($1, $2, $3, $4, $5)`,
    [electionId, optionId, randomVoterHash(), pollingPlace, votingTable]
  );
}

let adminToken;

// Elección "closed" con 2 opciones y votos reales, certificada UNA sola vez.
let closedElectionId;
let optionAId;
let optionBId;

// Elección "active" (no cerrada): se usa para el caso 409 de
// /internal/certify Y TAMBIÉN para el caso 404 de /certifications/:id (esa
// ruta no filtra por status, solo por ausencia de fila en scrutiny_ledger,
// así que sirve para ambos casos sin crear una tercera elección).
//
// IMPORTANTE: se usa status='active' a propósito, NUNCA 'closed', para esta
// elección "señuelo". El worker scheduler-service real corre en Docker en
// este mismo entorno (docker-compose), con un cron cada minuto, y certifica
// automáticamente CUALQUIER elección con status='closed' sin acta que
// encuentre en la base — sin importar que sea un dato de prueba. Si esta
// elección quedara en 'closed' durante los segundos que dura el archivo de
// test, ese worker en vivo podría certificarla de verdad antes del afterAll,
// dejando un acta permanente extra no deseada (esto realmente sucedió una
// vez al escribir este archivo, ver reporte). Al mantenerla 'active' y
// borrarla en el afterAll mucho antes de que llegue su scheduled_end, nunca
// entra en el radar del worker en vivo.
let activeElectionId;

beforeAll(async () => {
  adminToken = signAdminToken();

  closedElectionId = await createElection({ status: 'closed', title: `${RUN_ID}-closed` });
  optionAId = await createOption(closedElectionId, 'Candidato A', '1');
  optionBId = await createOption(closedElectionId, 'Candidato B', '2');
  await createVote(closedElectionId, optionAId, 'Puesto CI', 'Mesa 1');
  await createVote(closedElectionId, optionAId, 'Puesto CI', 'Mesa 1');
  await createVote(closedElectionId, optionBId, 'Puesto CI', 'Mesa 2');

  activeElectionId = await createElection({ status: 'active', title: `${RUN_ID}-active` });
});

afterAll(async () => {
  // Limpieza SOLO de lo que el trigger de append-only permite borrar. NO se
  // borra la fila de "elections" de closedElectionId (queda a propósito, ver
  // comentario de cabecera) y jamás se toca "scrutiny_ledger".
  await pool.query('DELETE FROM votes WHERE election_id = $1', [closedElectionId]);
  await pool.query('DELETE FROM election_options WHERE election_id = $1', [closedElectionId]);

  // activeElectionId NUNCA pasó por scrutiny_ledger (se mantuvo 'active'
  // todo el tiempo), así que sí se puede borrar por completo.
  await pool.query('DELETE FROM election_options WHERE election_id = $1', [activeElectionId]);
  await pool.query('DELETE FROM elections WHERE id = $1', [activeElectionId]);

  await pool.end();
});

describe('GET /health', () => {
  it('responde 200 sin autenticación', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'scrutiny' });
  });
});

describe('POST /internal/certify/:electionId', () => {
  it('rechaza la petición sin el token interno', async () => {
    const res = await request(app).post(`/internal/certify/${closedElectionId}`);
    expect(res.status).toBe(401);
  });

  it('rechaza la petición con un token interno incorrecto', async () => {
    const res = await request(app)
      .post(`/internal/certify/${closedElectionId}`)
      .set('X-Internal-Token', 'token-invalido-a-proposito');
    expect(res.status).toBe(401);
  });

  it('rechaza certificar una elección que NO está cerrada (409)', async () => {
    const res = await request(app)
      .post(`/internal/certify/${activeElectionId}`)
      .set('X-Internal-Token', INTERNAL_TOKEN);
    expect(res.status).toBe(409);
  });

  it('certifica una elección cerrada con votos reales y devuelve el acta (201)', async () => {
    const res = await request(app)
      .post(`/internal/certify/${closedElectionId}`)
      .set('X-Internal-Token', INTERNAL_TOKEN);
    expect(res.status).toBe(201);
    expect(res.body.electionId).toBe(closedElectionId);
    expect(res.body.totalVotes).toBe(3);
    expect(res.body.recordHash).toEqual(expect.any(String));
    expect(res.body.recordHash).toHaveLength(64);
    expect(res.body.winner).toBeDefined();
    expect(res.body.winner.optionId).toBe(optionAId);
    expect(res.body.winner.votes).toBe(2);
    // Firmada con la clave de esta instalación (la pareja de ACTA_PUBLIC_KEY).
    expect(res.body.signature).toEqual(expect.any(String));
    expect(res.body.signingKeyId).toBe(keyIdOf(loadPublicKey(process.env.ACTA_PUBLIC_KEY)));
  });

  it('una segunda llamada sobre la MISMA elección es idempotente (200, no crea un acta nueva)', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS c FROM scrutiny_ledger WHERE election_id = $1', [
      closedElectionId,
    ]);
    expect(before.rows[0].c).toBe(1);

    const res = await request(app)
      .post(`/internal/certify/${closedElectionId}`)
      .set('X-Internal-Token', INTERNAL_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.electionId).toBe(closedElectionId);

    const after = await pool.query('SELECT COUNT(*)::int AS c FROM scrutiny_ledger WHERE election_id = $1', [
      closedElectionId,
    ]);
    expect(after.rows[0].c).toBe(1);
  });
});

describe('GET /certifications/:electionId', () => {
  it('rechaza la consulta sin JWT de admin', async () => {
    const res = await request(app).get(`/certifications/${closedElectionId}`);
    expect(res.status).toBe(401);
  });

  it('devuelve el acta de la elección certificada', async () => {
    const res = await request(app)
      .get(`/certifications/${closedElectionId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.election_id).toBe(closedElectionId);
    expect(res.body.total_votes).toBe(3);
    expect(res.body.record_hash).toEqual(expect.any(String));
    expect(res.body.verification).toMatchObject({
      verdict: 'verificada',
      hashOk: true,
      linkOk: true,
      signature: 'valida',
      problems: [],
    });
  });

  it('devuelve 404 para una elección que aún no tiene acta', async () => {
    const res = await request(app)
      .get(`/certifications/${activeElectionId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /certifications/:electionId/acta.pdf', () => {
  it('devuelve el PDF del acta certificada', async () => {
    const res = await request(app)
      .get(`/certifications/${closedElectionId}/acta.pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        response.setEncoding('binary');
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          callback(null, Buffer.from(data, 'binary'));
        });
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.length).toBeGreaterThan(0);
  });

  // El auditor ve el veredicto del acta en Resultados (Analytics), pero el
  // acta oficial y la verificación de la cadena son solo del administrador.
  it('un auditor o un votante no pueden descargar el acta ni verificar la cadena (403)', async () => {
    for (const role of ['auditor', 'voter']) {
      const token = jwt.sign({ sub: 2, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      for (const ruta of [`/certifications/${closedElectionId}/acta.pdf`, `/certifications/${closedElectionId}`, '/verify']) {
        const res = await request(app).get(ruta).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
      }
    }
  });
});

describe('GET /verify', () => {
  it('devuelve la cadena de actas como válida', async () => {
    const res = await request(app).get('/verify').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.brokenAt).toEqual([]);
    expect(typeof res.body.totalRecords).toBe('number');
    expect(res.body.totalRecords).toBeGreaterThanOrEqual(1);
    const record = res.body.records.find((r) => r.electionId === closedElectionId);
    expect(record).toMatchObject({ verdict: 'verificada', signature: 'valida', title: `${RUN_ID}-closed` });
  });
});

// Simula a alguien con acceso directo a la base: se salta el trigger de
// append-only, cambia el resultado del acta y rehace su hash (la cadena de
// hashes no usa ningún secreto). Lo que no puede rehacer es la firma. Solo
// corre contra la base desechable de las pruebas (scripts/lib/jest-db-setup.js),
// nunca contra una base que venga de DB_HOST: la deja con un acta alterada.
const conBaseDesechable = process.env.LIVEMETRIC_DB_PRUEBAS ? describe : describe.skip;
conBaseDesechable('un acta alterada directo en la base, con su hash rehecho', () => {
  beforeAll(async () => {
    const { rows } = await pool.query(
      'SELECT results, total_votes, previous_hash FROM scrutiny_ledger WHERE election_id = $1',
      [closedElectionId]
    );
    const results = rows[0].results;
    results.overall.find((o) => o.optionId === optionBId).votes += 100; // el que perdió, ahora "gana"
    const recordHash = computeRecordHash({
      previousHash: rows[0].previous_hash,
      electionId: closedElectionId,
      totalVotes: rows[0].total_votes,
      results,
    });
    await pool.query('ALTER TABLE scrutiny_ledger DISABLE TRIGGER trg_scrutiny_no_update');
    try {
      await pool.query('UPDATE scrutiny_ledger SET results = $1, record_hash = $2 WHERE election_id = $3', [
        JSON.stringify(results),
        recordHash,
        closedElectionId,
      ]);
    } finally {
      await pool.query('ALTER TABLE scrutiny_ledger ENABLE TRIGGER trg_scrutiny_no_update');
    }
  });

  it('GET /verify lo detecta por la firma, aunque la cadena de hashes cuadre', async () => {
    const res = await request(app).get('/verify').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    const record = res.body.records.find((r) => r.electionId === closedElectionId);
    expect(record).toMatchObject({ hashOk: true, linkOk: true, signature: 'invalida', verdict: 'alterada' });
    expect(res.body.brokenAt).toEqual([
      expect.objectContaining({ electionId: closedElectionId, hashOk: true, signature: 'invalida' }),
    ]);
  });

  it('GET /certifications/:id marca el acta como alterada', async () => {
    const res = await request(app)
      .get(`/certifications/${closedElectionId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.verification.verdict).toBe('alterada');
    expect(res.body.verification.problems.join(' ')).toMatch(/firma digital no corresponde/);
  });

  it('el PDF del acta alterada se sigue generando (encabezado con la advertencia)', async () => {
    const res = await request(app)
      .get(`/certifications/${closedElectionId}/acta.pdf`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});

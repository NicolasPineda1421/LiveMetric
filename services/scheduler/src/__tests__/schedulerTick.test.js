// Prueba unitaria de la lógica del tick del scheduler-worker
// (runSchedulerTick), contra la base real (Supabase) pero con el fetch al
// scrutiny-service MOCKEADO (nunca se llama a un scrutiny-service real).
//
// Todo dato que crea esta prueba usa el prefijo CITEST-SCHEDULER-<timestamp>
// en el título. A diferencia de scrutiny, estas elecciones SÍ se pueden
// borrar por completo en el afterAll: como el fetch está mockeado, nunca
// llegan a generar una fila real en scrutiny_ledger.
const pool = require('../db');
const { runSchedulerTick } = require('../schedulerTick');

const RUN_ID = `CITEST-SCHEDULER-${Date.now()}`;
const SCRUTINY_URL = 'http://scrutiny-service-fake:3004';
const INTERNAL_TOKEN = 'test-internal-token-fake';

const createdElectionIds = [];

async function createElection({ title, status, scheduledStart, scheduledEnd }) {
  const res = await pool.query(
    `INSERT INTO elections (title, status, scheduled_start, scheduled_end)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, status, scheduledStart, scheduledEnd]
  );
  const id = res.rows[0].id;
  createdElectionIds.push(id);
  return id;
}

async function getElectionStatus(id) {
  const res = await pool.query('SELECT status FROM elections WHERE id = $1', [id]);
  return res.rows[0]?.status;
}

afterAll(async () => {
  if (createdElectionIds.length > 0) {
    await pool.query('DELETE FROM election_options WHERE election_id = ANY($1::int[])', [
      createdElectionIds,
    ]);
    await pool.query('DELETE FROM elections WHERE id = ANY($1::int[])', [createdElectionIds]);
  }
  await pool.end();
});

describe('runSchedulerTick', () => {
  it('activa una elección "scheduled" cuya ventana ya empezó', async () => {
    const now = Date.now();
    const electionId = await createElection({
      title: `${RUN_ID}-to-activate`,
      status: 'scheduled',
      scheduledStart: new Date(now - 60 * 1000), // empezó hace 1 minuto
      scheduledEnd: new Date(now + 60 * 60 * 1000), // termina en 1 hora
    });

    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const summary = await runSchedulerTick({ fetchImpl, scrutinyUrl: SCRUTINY_URL, internalToken: INTERNAL_TOKEN });

    expect(summary.activated).toBeGreaterThanOrEqual(1);
    const status = await getElectionStatus(electionId);
    expect(status).toBe('active');
  });

  it('cierra una elección "active" cuya scheduled_end ya pasó', async () => {
    const now = Date.now();
    const electionId = await createElection({
      title: `${RUN_ID}-to-close`,
      status: 'active',
      scheduledStart: new Date(now - 2 * 60 * 60 * 1000), // empezó hace 2 horas
      scheduledEnd: new Date(now - 60 * 1000), // terminó hace 1 minuto
    });

    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const summary = await runSchedulerTick({ fetchImpl, scrutinyUrl: SCRUTINY_URL, internalToken: INTERNAL_TOKEN });

    expect(summary.closed).toBeGreaterThanOrEqual(1);
    const status = await getElectionStatus(electionId);
    expect(status).toBe('closed');
  });

  it('solicita la certificación de una elección "closed" sin acta, con la URL y el header correctos', async () => {
    const now = Date.now();
    const electionId = await createElection({
      title: `${RUN_ID}-to-certify-ok`,
      status: 'closed',
      scheduledStart: new Date(now - 2 * 60 * 60 * 1000),
      scheduledEnd: new Date(now - 60 * 60 * 1000),
    });

    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const summary = await runSchedulerTick({ fetchImpl, scrutinyUrl: SCRUTINY_URL, internalToken: INTERNAL_TOKEN });

    expect(summary.certifyErrors).toBe(0);
    const calledWithThisElection = fetchImpl.mock.calls.find(([url]) =>
      url.includes(`/internal/certify/${electionId}`)
    );
    expect(calledWithThisElection).toBeDefined();
    const [url, options] = calledWithThisElection;
    expect(url).toBe(`${SCRUTINY_URL}/internal/certify/${electionId}`);
    expect(options.method).toBe('POST');
    expect(options.headers['X-Internal-Token']).toBe(INTERNAL_TOKEN);
  });

  it('captura el error si scrutiny-service responde con un status de error, sin lanzar excepción', async () => {
    const now = Date.now();
    const electionId = await createElection({
      title: `${RUN_ID}-to-certify-fail`,
      status: 'closed',
      scheduledStart: new Date(now - 2 * 60 * 60 * 1000),
      scheduledEnd: new Date(now - 60 * 60 * 1000),
    });

    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    const summary = await runSchedulerTick({ fetchImpl, scrutinyUrl: SCRUTINY_URL, internalToken: INTERNAL_TOKEN });
    expect(summary).toBeDefined();
    expect(summary.certifyErrors).toBeGreaterThanOrEqual(1);

    const calledWithThisElection = fetchImpl.mock.calls.find(([url]) =>
      url.includes(`/internal/certify/${electionId}`)
    );
    expect(calledWithThisElection).toBeDefined();
  });
});

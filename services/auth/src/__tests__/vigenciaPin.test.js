// Vigencia del PIN del votante (VIGENCIA DEL PIN en app.js): vence en una
// fecha, y hasta entonces sirve haya o no una votación abierta. Las
// elecciones que hacen falta (para la fecha sugerida) se arman y se borran
// en cada prueba.
//
// Los intentos rechazados van desde IPs distintas (la app confía en un
// proxy): si no, agotarían el límite de intentos del login, que es por IP.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField } = require('../voterCrypto');
const totp = require('../totp');
const { abrirVotacion, cerrarVotacion } = require('./votacion');

const RUN_ID = `CITEST_VIG_${Date.now()}`;
const sufijo = Date.now().toString().slice(-7);
const CEDULA = `CI-VIG-${sufijo}`;
const PIN = String(crypto.randomInt(100000, 1000000));
const ADMIN = { username: `${RUN_ID}_admin`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };
const HORA = 60 * 60 * 1000;
const VENCIDO = /Tu PIN venció/;

let adminToken;
let ipLibre = 10;
const otraIp = () => `203.0.113.${ipLibre++}`;
const ingresar = (cuerpo = { cedula: CEDULA, pin: PIN }, ip = otraIp()) =>
  request(app).post('/login/voter').set('X-Forwarded-For', ip).send(cuerpo);
const conAdmin = (metodo, ruta) =>
  (metodo === 'get' ? request(app).get(ruta) : request(app).post(ruta)).set('Authorization', `Bearer ${adminToken}`);

// Corre "prueba" con una elección armada a medida, y la borra después.
async function conVotacion(opciones, prueba) {
  const id = await abrirVotacion(`${RUN_ID}-eleccion`, opciones);
  try {
    return await prueba(id);
  } finally {
    await cerrarVotacion(id);
  }
}

const venceEn = (intervalo) =>
  pool.query(`UPDATE voters SET access_code_expires_at = ${intervalo} WHERE cedula = $1`, [encryptField(CEDULA)]);

async function ultimoMotivo() {
  const r = await pool.query(
    `SELECT metadata ->> 'reason' AS reason FROM audit_log WHERE event_type = 'LOGIN_FAILURE_VOTER' ORDER BY id DESC LIMIT 1`
  );
  return r.rows[0].reason;
}

beforeAll(async () => {
  await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [
    ADMIN.username,
    await bcrypt.hash(ADMIN.password, 4),
    'admin',
  ]);
  adminToken = (await request(app).post('/login/admin').send(ADMIN)).body.token;
  await pool.query(
    `INSERT INTO voters (cedula, full_name, polling_place, voting_table, access_code_hash, access_code_expires_at)
     VALUES ($1, 'Votante de la vigencia', $2, $3, $4, now() + interval '1 day')`,
    [encryptField(CEDULA), encryptField('Puesto CI'), encryptField('Mesa 1'), await bcrypt.hash(PIN, 4)]
  );
});

afterEach(() => venceEn("now() + interval '1 day'"));

afterAll(async () => {
  // La cédula está cifrada: se borra por su valor cifrado, no con LIKE.
  const cedulas = [CEDULA, `CI-VIGB-${sufijo}`, `CI-VIGC-${sufijo}`, `CI-VIGD-${sufijo}`];
  await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [cedulas.map(encryptField)]);
  await pool.query('DELETE FROM admins WHERE username = $1', [ADMIN.username]);
  await pool.end();
});

describe('Haya o no una votación', () => {
  it('sin ninguna elección, con el PIN vigente entra (por ejemplo, a registrar su autenticador)', async () => {
    const res = await ingresar();
    expect(res.status).toBe(200);
    expect(res.body.next).toBe('registro');
  });

  it('con una elección cerrada o terminada, también: lo que decide es el vencimiento del PIN', async () => {
    await conVotacion({ status: 'closed' }, async () => {
      expect((await ingresar()).status).toBe(200);
    });
    await conVotacion({ desdeMin: -120, hastaMin: -1 }, async () => {
      expect((await ingresar()).status).toBe(200);
    });
  });
});

describe('Fecha de vencimiento', () => {
  it('un PIN vencido no entra, haya o no votación; con el PIN equivocado no se revela que venció', async () => {
    await venceEn("now() - interval '1 minute'");
    const res = await ingresar();
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(VENCIDO);
    expect(await ultimoMotivo()).toBe('pin_vencido');
    await conVotacion({}, async () => {
      expect((await ingresar()).body.error).toMatch(VENCIDO);
    });
    const equivocado = await ingresar({ cedula: CEDULA, pin: PIN === '111111' ? '222222' : '111111' });
    expect(equivocado.status).toBe(401);
    expect(equivocado.body.error).toBe('Cédula o PIN incorrectos');
  });

  it('el segundo paso vuelve a comprobar: si en el medio venció el PIN, no abre la sesión', async () => {
    const paso1 = await ingresar();
    await venceEn("now() - interval '1 second'");
    const vencido = await request(app).post('/login/voter/registro').set('X-Forwarded-For', otraIp())
      .send({ challenge: paso1.body.challenge, code: totp.codeAt(paso1.body.secret, totp.currentStep()) });
    expect(vencido.status).toBe(403);
    expect(vencido.body.error).toMatch(VENCIDO);
    const { rows } = await pool.query('SELECT totp_secret FROM voters WHERE cedula = $1', [encryptField(CEDULA)]);
    expect(rows[0].totp_secret).toBeNull();
  });
});

describe('Vencimiento al generar los PIN', () => {
  const cargar = (cedula, extra = {}) =>
    conAdmin('post', '/admin/voters/bulk').send({
      voters: [{ cedula, fullName: 'Votante de la carga', pollingPlace: 'Puesto CI', votingTable: 'Mesa 1' }],
      ...extra,
    });

  it('sin fecha pedida, vencen al cierre de la última elección programada (o en 24 h si no hay ninguna)', async () => {
    const sinEleccion = await cargar(`CI-VIGB-${sufijo}`);
    expect(sinEleccion.status).toBe(201);
    expect(Math.abs(new Date(sinEleccion.body.pinExpiresAt) - (Date.now() + 24 * HORA))).toBeLessThan(60 * 1000);

    await conVotacion({ status: 'scheduled', desdeMin: 60 * 24, hastaMin: 60 * 30 }, async (id) => {
      const { rows } = await pool.query('SELECT scheduled_end FROM elections WHERE id = $1', [id]);
      const conEleccion = await cargar(`CI-VIGC-${sufijo}`);
      expect(Math.abs(new Date(conEleccion.body.pinExpiresAt) - rows[0].scheduled_end)).toBeLessThan(1000);

      const lista = await conAdmin('get', '/admin/voters?limit=200');
      expect(lista.body.pinExpiry).toMatchObject({ electionTitle: `${RUN_ID}-eleccion`, maxDays: 90 });
      const fila = lista.body.voters.find((v) => v.cedula === `CI-VIGC-${sufijo}`);
      expect(new Date(fila.pin_expires_at).getTime()).toBe(new Date(conEleccion.body.pinExpiresAt).getTime());
    });
  });

  it('respeta la fecha pedida, y rechaza una pasada, una de más de 90 días o una que no es fecha', async () => {
    const pedida = new Date(Date.now() + 3 * 24 * HORA).toISOString();
    const ok = await cargar(`CI-VIGD-${sufijo}`, { pinExpiresAt: pedida });
    expect(ok.status).toBe(201);
    expect(ok.body.pinExpiresAt).toBe(pedida);

    for (const mala of [new Date(Date.now() - HORA).toISOString(), new Date(Date.now() + 91 * 24 * HORA).toISOString(), 'mañana', 12345]) {
      const res = await cargar(`CI-VIGE-${sufijo}`, { pinExpiresAt: mala });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fecha futura, de no más de 90 días/);
    }
  });

  it('regenerar el PIN le pone el vencimiento pedido', async () => {
    const { rows } = await pool.query('SELECT id FROM voters WHERE cedula = $1', [encryptField(CEDULA)]);
    const pedida = new Date(Date.now() + 2 * HORA).toISOString();
    const res = await conAdmin('post', `/admin/voters/${rows[0].id}/reset-pin`).send({ pinExpiresAt: pedida });
    expect(res.status).toBe(200);
    expect(res.body.pinExpiresAt).toBe(pedida);
    const mala = await conAdmin('post', `/admin/voters/${rows[0].id}/reset-pin`).send({ pinExpiresAt: '2020-01-01T00:00:00Z' });
    expect(mala.status).toBe(400);
  });
});

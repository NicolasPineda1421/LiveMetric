// Pruebas de integración de auth-service contra la app de Express en
// memoria (Supertest, sin abrir puerto real) y la base real configurada por
// entorno (Supabase). Todo dato que estas pruebas crean usa el prefijo
// CITEST_ para poder identificarlo y borrarlo sin riesgo al final
// (afterAll), sin tocar datos reales del padrón/admins.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField } = require('../voterCrypto');

const RUN_ID = `CITEST_${Date.now()}`;
const TEST_ADMIN_USER = `${RUN_ID}_admin`;
// Contraseña aleatoria por corrida (en vez de una fija en el código): las
// cuentas de prueba se crean contra la base real, así que su contraseña no
// debe ser conocida ni reutilizable. 19 caracteres, sobre el mínimo de 10.
const TEST_ADMIN_PASS = `Ci-${crypto.randomBytes(12).toString('base64url')}`;
const TEST_AUDITOR_USER = `${RUN_ID}_auditor`;
// La cédula real solo admite [0-9A-Za-z-] y máximo 20 caracteres (ver
// validación de /admin/voters/bulk) — nada de guion bajo, y corta.
const TEST_VOTER_CEDULA = `CI-${Date.now().toString().slice(-10)}`;

// Admin base de las pruebas: se crea directo en la base con una contraseña
// aleatoria (igual que hacen las pruebas de voting), en vez de depender de
// un admin sembrado con una credencial fija: el repositorio no lleva
// ninguna. Se borra en el afterAll junto con los demás CITEST_.
const BASE_ADMIN_USER = `${RUN_ID}_base`;
const BASE_ADMIN_PASS = `Ci-${crypto.randomBytes(12).toString('base64url')}`;

let adminToken;

async function createBaseAdmin() {
  await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [
    BASE_ADMIN_USER,
    await bcrypt.hash(BASE_ADMIN_PASS, 12),
    'admin',
  ]);
  const res = await request(app)
    .post('/login/admin')
    .send({ username: BASE_ADMIN_USER, password: BASE_ADMIN_PASS });
  return res.body.token;
}

beforeAll(async () => {
  adminToken = await createBaseAdmin();
});

afterAll(async () => {
  // Limpieza best-effort: nunca debe dejar basura de CI en datos reales.
  // "cedula" está cifrada en la base (voterCrypto.js): hay que cifrar el
  // mismo valor de prueba con la misma clave para poder encontrarla, un
  // "WHERE cedula = <texto plano>" nunca matchearía nada.
  // El votante primero: su created_by apunta al admin base (FK).
  await pool.query('DELETE FROM voters WHERE cedula = $1', [encryptField(TEST_VOTER_CEDULA)]);
  await pool.query('DELETE FROM admins WHERE username LIKE $1', [`${RUN_ID}%`]);
  await pool.end();
});

describe('GET /health', () => {
  it('responde 200 sin autenticación', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'auth' });
  });
});

describe('POST /login/admin', () => {
  it('rechaza credenciales inválidas con un mensaje genérico', async () => {
    const res = await request(app)
      .post('/login/admin')
      .send({ username: BASE_ADMIN_USER, password: 'clave-incorrecta-123' }); // gitleaks:allow (password de prueba deliberadamente incorrecta, no un secreto)
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Credenciales inválidas');
  });

  it('rechaza un usuario que no existe con el MISMO mensaje genérico (no distingue)', async () => {
    const res = await request(app)
      .post('/login/admin')
      .send({ username: 'usuario_que_no_existe_jamas', password: 'cualquiera123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Credenciales inválidas');
  });

  it('acepta la credencial correcta de un admin y devuelve un JWT con role', async () => {
    const res = await request(app)
      .post('/login/admin')
      .send({ username: BASE_ADMIN_USER, password: BASE_ADMIN_PASS });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.role).toBe('admin');
  });

  it('rechaza payloads mal formados (400, nunca 500)', async () => {
    const res = await request(app).post('/login/admin').send({ username: 'ab' });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/users', () => {
  it('rechaza la creación sin token', async () => {
    const res = await request(app)
      .post('/admin/users')
      .send({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PASS });
    expect(res.status).toBe(401);
  });

  it('crea un admin nuevo cuando lo pide un admin autenticado', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PASS });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe(TEST_ADMIN_USER);
  });

  it('crea un usuario con rol auditor cuando se pide explícitamente', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: TEST_AUDITOR_USER, password: TEST_ADMIN_PASS, role: 'auditor' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('auditor');
  });

  it('el nuevo admin puede loguearse con su propio rol', async () => {
    const res = await request(app)
      .post('/login/admin')
      .send({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PASS });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('el nuevo auditor se loguea con role "auditor", no "admin"', async () => {
    const res = await request(app)
      .post('/login/admin')
      .send({ username: TEST_AUDITOR_USER, password: TEST_ADMIN_PASS });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('auditor');
  });

  it('rechaza username duplicado con 409', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PASS });
    expect(res.status).toBe(409);
  });
});

describe('POST /admin/voters/bulk + login de votante con PIN', () => {
  let generatedPin;
  let voterId;

  it('carga un votante nuevo y devuelve su PIN en texto plano UNA vez', async () => {
    const res = await request(app)
      .post('/admin/voters/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        voters: [
          {
            cedula: TEST_VOTER_CEDULA,
            fullName: 'Votante de Prueba CI',
            pollingPlace: 'Puesto CI',
            votingTable: 'Mesa CI',
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(1);
    expect(res.body.accessCodes).toHaveLength(1);
    expect(res.body.accessCodes[0].cedula).toBe(TEST_VOTER_CEDULA);
    expect(res.body.accessCodes[0].pin).toMatch(/^\d{6}$/);
    generatedPin = res.body.accessCodes[0].pin;
  });

  it('re-subir el mismo votante actualiza en vez de duplicar, y NO regenera el PIN', async () => {
    const res = await request(app)
      .post('/admin/voters/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        voters: [
          {
            cedula: TEST_VOTER_CEDULA,
            fullName: 'Votante de Prueba CI (editado)',
            pollingPlace: 'Puesto CI',
            votingTable: 'Mesa CI',
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.updated).toBe(1);
    expect(res.body.accessCodes).toHaveLength(0); // no genera PIN nuevo en un update
  });

  it('el votante puede loguearse con el PIN generado', async () => {
    const res = await request(app)
      .post('/login/voter')
      .send({ cedula: TEST_VOTER_CEDULA, pin: generatedPin });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('voter');
    expect(res.body.pollingPlace).toBe('Puesto CI');
  });

  it('rechaza un PIN incorrecto con un mensaje genérico', async () => {
    const res = await request(app)
      .post('/login/voter')
      .send({ cedula: TEST_VOTER_CEDULA, pin: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Cédula o PIN incorrectos');
  });

  it('el listado de padrón muestra los campos descifrados (no el ciphertext crudo)', async () => {
    const res = await request(app)
      .get('/admin/voters?limit=200')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const found = res.body.voters.find((v) => v.cedula === TEST_VOTER_CEDULA);
    expect(found).toBeDefined();
    expect(found.polling_place).toBe('Puesto CI');
    expect(found.has_pin).toBe(true);
    voterId = found.id;
  });

  it('regenerar el PIN invalida el anterior', async () => {
    const resetRes = await request(app)
      .post(`/admin/voters/${voterId}/reset-pin`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resetRes.status).toBe(200);
    const newPin = resetRes.body.pin;
    expect(newPin).not.toBe(generatedPin);

    const oldPinLogin = await request(app)
      .post('/login/voter')
      .send({ cedula: TEST_VOTER_CEDULA, pin: generatedPin });
    expect(oldPinLogin.status).toBe(401);

    const newPinLogin = await request(app)
      .post('/login/voter')
      .send({ cedula: TEST_VOTER_CEDULA, pin: newPin });
    expect(newPinLogin.status).toBe(200);
  });
});

describe('GET /admin/audit-log', () => {
  it('devuelve eventos paginados con un total', async () => {
    const res = await request(app)
      .get('/admin/audit-log?limit=5&offset=0')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body.events.length).toBeLessThanOrEqual(5);
  });

  it('rechaza la consulta sin token de admin', async () => {
    const res = await request(app).get('/admin/audit-log');
    expect(res.status).toBe(401);
  });
});

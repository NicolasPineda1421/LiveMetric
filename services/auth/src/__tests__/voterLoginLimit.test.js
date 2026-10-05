// Límite de intentos del login de votantes (voterLoginLimiter en app.js).
// En un archivo aparte a propósito: el contador del límite vive en la
// memoria de la app, y Jest carga una app nueva por archivo, así que estas
// pruebas no bloquean los logins de app.test.js (ni al revés).
//
// Lo que se prueba es el caso real de un puesto de votación: todos los
// votantes entran desde el mismo equipo (la misma IP). Los ingresos
// correctos no deben agotar el límite; los fallidos sí, porque son los que
// delatan a alguien adivinando PINs.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField } = require('../voterCrypto');

const CEDULA = `CI-LIM-${Date.now().toString().slice(-8)}`;
const PIN = String(crypto.randomInt(100000, 1000000));
const PIN_EQUIVOCADO = PIN === '111111' ? '222222' : '111111';

const login = (pin) => request(app).post('/login/voter').send({ cedula: CEDULA, pin });

beforeAll(async () => {
  await pool.query(
    `INSERT INTO voters (cedula, full_name, polling_place, voting_table, access_code_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [encryptField(CEDULA), 'Votante de prueba del límite', encryptField('Puesto CI'), encryptField('Mesa 1'), await bcrypt.hash(PIN, 4)],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM voters WHERE cedula = $1', [encryptField(CEDULA)]);
  await pool.end();
});

describe('Límite de intentos del login de votantes', () => {
  it('muchos ingresos correctos desde la misma IP no agotan el límite (un puesto de votación con un solo equipo)', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await login(PIN);
      expect(res.status).toBe(200);
    }
  });

  it('los intentos fallidos sí: después del octavo, la IP queda bloqueada', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await login(PIN_EQUIVOCADO);
      expect(res.status).toBe(401);
    }
    const bloqueado = await login(PIN_EQUIVOCADO);
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.error).toMatch(/Demasiados intentos/);

    // El bloqueo vale también para el PIN correcto, hasta que pase la ventana.
    const correcto = await login(PIN);
    expect(correcto.status).toBe(429);
  });
});

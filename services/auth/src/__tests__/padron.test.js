// Padrón desde el panel: agregar votantes con el formulario (sin modificar
// a los que ya están), filtrar el listado y eliminar. Cada prueba usa un
// puesto propio de la corrida, para no mezclarse con los datos de otras.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField } = require('../voterCrypto');
const { abrirVotacion, cerrarVotacion } = require('./votacion');

const RUN_ID = `CITEST_PAD_${Date.now()}`;
const sufijo = Date.now().toString().slice(-7);
const PUESTO = `Puesto Pad ${sufijo}`;
const ced = (n) => `CI-PAD${n}-${sufijo}`;
const ADMIN = { username: `${RUN_ID}_admin`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };

let adminToken;
// Un solo pedido por llamada: supertest abre un servidor por cada uno. Cada
// uno sale de otra IP: las operaciones de administración tienen un límite
// de 20 por minuto e IP, y este archivo hace más.
const PEDIDOS = { get: (r) => request(app).get(r), post: (r) => request(app).post(r), delete: (r) => request(app).delete(r) };
let ipAdmin = 0;
const conAdmin = (metodo, ruta) =>
  PEDIDOS[metodo](ruta) // eslint-disable-line security/detect-object-injection -- metodo es siempre un literal de estas pruebas
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Forwarded-For', `198.18.0.${(ipAdmin++ % 250) + 1}`);
const agregar = (voters, extra = {}) => conAdmin('post', '/admin/voters').send({ voters, ...extra });
const listar = (filtros = {}) => conAdmin('get', `/admin/voters?${new URLSearchParams({ limit: '200', pollingPlace: PUESTO, ...filtros })}`);
const nombres = (res) => res.body.voters.map((v) => v.full_name).sort();

beforeAll(async () => {
  await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [
    ADMIN.username,
    await bcrypt.hash(ADMIN.password, 4),
    'admin',
  ]);
  adminToken = (await request(app).post('/login/admin').send(ADMIN)).body.token;
});

afterAll(async () => {
  await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [[1, 2, 3, 4, 5, 6].map((n) => encryptField(ced(n)))]);
  await pool.query('DELETE FROM admins WHERE username = $1', [ADMIN.username]);
  await pool.end();
});

describe('Agregar con el formulario', () => {
  it('agrega varios votantes, con su PIN y su vencimiento', async () => {
    const res = await agregar([
      { cedula: ced(1), fullName: 'María José Ángel', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
      { cedula: ced(2), fullName: 'Pedro Ruiz', pollingPlace: PUESTO, votingTable: 'Mesa 2' },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(2);
    expect(res.body.duplicates).toEqual([]);
    expect(res.body.accessCodes.map((a) => a.cedula)).toEqual([ced(1), ced(2)]);
    expect(res.body.accessCodes.every((a) => /^\d{6}$/.test(a.pin))).toBe(true);
    expect(res.body.pinExpiresAt).toEqual(expect.any(String));
  });

  it('una cédula que ya está no se modifica: se informa y el resto se agrega', async () => {
    const res = await agregar([
      { cedula: ced(1), fullName: 'Otro Nombre', pollingPlace: 'Otro Puesto', votingTable: 'Mesa 9' },
      { cedula: ced(3), fullName: 'Lucía Pérez', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(1);
    expect(res.body.duplicates).toEqual([ced(1)]);
    const lista = await listar();
    expect(lista.body.voters.find((v) => v.cedula === ced(1)).full_name).toBe('María José Ángel');
  });

  it('el puesto y la mesa escritos de otra forma se guardan como ya figuran en el padrón', async () => {
    await agregar([{ cedula: ced(4), fullName: 'Ana Gómez', pollingPlace: PUESTO.toUpperCase(), votingTable: '2' }]);
    const fila = (await listar()).body.voters.find((v) => v.cedula === ced(4));
    expect(fila).toMatchObject({ polling_place: PUESTO, voting_table: 'Mesa 2' });
  });

  it('dice qué votante tiene el error, y rechaza una cédula repetida en el mismo formulario', async () => {
    const malo = await agregar([
      { cedula: ced(5), fullName: 'Bien Escrito', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
      { cedula: 'x', fullName: 'Cédula Corta', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
    ]);
    expect(malo.status).toBe(400);
    expect(malo.body.error).toBe('Votante 2: la cédula debe tener de 5 a 20 letras, números o guiones.');
    const repetida = await agregar([
      { cedula: ced(5), fullName: 'Uno', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
      { cedula: ced(5), fullName: 'Dos', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
    ]);
    expect(repetida.body.error).toBe(`La cédula ${ced(5)} está dos veces en el formulario.`);
    expect((await agregar([])).body.error).toBe('Agrega entre 1 y 200 votantes por vez.');
  });
});

describe('Filtros del listado', () => {
  beforeAll(async () => {
    // Ana (CI-PAD4) vota asistida; María (CI-PAD1) tiene el PIN vencido.
    await pool.query('UPDATE voters SET assisted = true WHERE cedula = $1', [encryptField(ced(4))]);
    await pool.query(`UPDATE voters SET access_code_expires_at = now() - interval '1 minute' WHERE cedula = $1`, [encryptField(ced(1))]);
  });

  it('por puesto y por mesa (con "1" igual a "Mesa 1"), con el total filtrado', async () => {
    const puesto = await listar();
    expect(puesto.body.total).toBe(4);
    expect(puesto.body.registered).toBeGreaterThanOrEqual(4);
    expect(nombres(await listar({ votingTable: '1' }))).toEqual(['Lucía Pérez', 'María José Ángel']);
  });

  it('por parte de la cédula o del nombre, sin mayúsculas ni tildes', async () => {
    expect(nombres(await listar({ q: 'maria jose' }))).toEqual(['María José Ángel']);
    expect(nombres(await listar({ q: `pad3-${sufijo}` }))).toEqual(['Lucía Pérez']);
  });

  it('por estado del PIN, del autenticador y del voto asistido', async () => {
    expect(nombres(await listar({ pin: 'vencido' }))).toEqual(['María José Ángel']);
    expect((await listar({ pin: 'vigente' })).body.total).toBe(3);
    expect(nombres(await listar({ assisted: 'true' }))).toEqual(['Ana Gómez']);
    expect((await listar({ totp: 'registrado' })).body.total).toBe(0);
    expect((await listar({ totp: 'pendiente' })).body.total).toBe(4);
    // El estado del PIN viaja en cada fila; si venció, no se dice más.
    expect((await listar({ q: 'maria' })).body.voters[0]).toMatchObject({ pin_state: 'vencido' });
    expect((await listar({ q: 'maria' })).body.voters[0]).not.toHaveProperty('pin_expired');
  });

  it('pagina el resultado filtrado, y rechaza un filtro que no existe', async () => {
    const pagina = await listar({ limit: '2', offset: '2' });
    expect(pagina.body.voters).toHaveLength(2);
    expect(pagina.body.total).toBe(4);
    expect((await listar({ pin: 'cualquiera' })).status).toBe(400);
  });
});

describe('Eliminar', () => {
  it('elimina al votante, queda en la auditoría sin la cédula, y ya no puede ingresar', async () => {
    const votacion = await abrirVotacion(`${RUN_ID}-votacion`);
    try {
      const pin = (await agregar([{ cedula: ced(6), fullName: 'Votante Eliminado', pollingPlace: PUESTO, votingTable: 'Mesa 1' }])).body.accessCodes[0].pin;
      const { id } = (await listar({ q: 'eliminado' })).body.voters[0];
      const res = await conAdmin('delete', `/admin/voters/${id}`);
      expect(res.status).toBe(204);
      expect((await listar({ q: 'eliminado' })).body.total).toBe(0);

      const { rows } = await pool.query(
        `SELECT actor_ref, metadata FROM audit_log WHERE event_type = 'VOTER_DELETED' ORDER BY id DESC LIMIT 1`
      );
      expect(rows[0].actor_ref).toBe(ADMIN.username);
      expect(rows[0].metadata).toMatchObject({ voterId: id, voterIdHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(JSON.stringify(rows[0].metadata)).not.toContain(ced(6));

      const ingreso = await request(app).post('/login/voter').set('X-Forwarded-For', '203.0.113.250').send({ cedula: ced(6), pin });
      expect(ingreso.status).toBe(401);
      expect((await conAdmin('delete', `/admin/voters/${id}`)).status).toBe(404);
    } finally {
      await cerrarVotacion(votacion);
    }
  });

  it('solo el administrador puede eliminar', async () => {
    const { id } = (await listar({ q: 'lucia' })).body.voters[0];
    expect((await request(app).delete(`/admin/voters/${id}`)).status).toBe(401);
  });
});

describe('Límites de las operaciones de administración', () => {
  it('filtrar mucho el listado no deja sin cupo para eliminar: consultas y cambios tienen límites separados', async () => {
    const ip = '198.19.0.1';
    const consultar = () => request(app).get(`/admin/voters?pollingPlace=${encodeURIComponent(PUESTO)}`).set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', ip);
    for (let i = 0; i < 25; i++) expect((await consultar()).status).toBe(200);
    const { id } = (await listar({ q: 'pedro' })).body.voters[0];
    const eliminar = await request(app).delete(`/admin/voters/${id}`).set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', ip);
    expect(eliminar.status).toBe(204);
  });
});

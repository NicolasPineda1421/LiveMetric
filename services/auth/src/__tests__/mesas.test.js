// Mesas de votación (migración 010): crearlas, renombrarlas y eliminarlas
// desde la pestaña "Puestos" (mesas.js y las rutas /admin/mesas).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField, decryptField } = require('../voterCrypto');
const { normalizarPuesto } = require('../lugares');
const { UBICACION, VIVE_CERCA } = require('./ubicacion');
const { abrirVotacion, cerrarVotacion } = require('./votacion');

const RUN_ID = `CITEST_MESA_${Date.now()}`;
const sufijo = Date.now().toString().slice(-7);
const PUESTO = `Escuela de Mesas ${sufijo}`;
let n = 0;
const cedula = () => `CI-MESA${(n += 1)}-${sufijo}`;
const ADMIN = { username: `${RUN_ID}_admin`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };
const CLAVE_JURADO = `Ci-${crypto.randomBytes(12).toString('base64url')}`;
let jurados = 0;

let adminToken;
// Cada pedido sale de otra IP: este archivo hace más de 20 operaciones.
const PEDIDOS = {
  get: (r) => request(app).get(r), post: (r) => request(app).post(r), put: (r) => request(app).put(r), delete: (r) => request(app).delete(r),
};
let ip = 0;
const conAdmin = (metodo, ruta) =>
  PEDIDOS[metodo](ruta) // eslint-disable-line security/detect-object-injection -- metodo es siempre un literal de estas pruebas
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Forwarded-For', `198.18.3.${(ip++ % 250) + 1}`);

const agregarVotantes = (mesas) => conAdmin('post', '/admin/voters').send({
  voters: mesas.map((votingTable) => ({ cedula: cedula(), fullName: 'Votante de Mesa', pollingPlace: PUESTO, votingTable, ...UBICACION })),
});
const crearMesa = (votingTable, pollingPlace = PUESTO) => conAdmin('post', '/admin/mesas').send({ pollingPlace, votingTable });
const renombrar = (votingTable, nombre) => conAdmin('put', '/admin/mesas').send({ pollingPlace: PUESTO, votingTable, nombre });
const eliminar = (votingTable, pollingPlace = PUESTO) => conAdmin('delete', '/admin/mesas').send({ pollingPlace, votingTable });
const crearJurado = (votingTable) => conAdmin('post', '/admin/users').send({
  username: `${RUN_ID}_j${(jurados += 1)}`, password: CLAVE_JURADO, role: 'jurado', pollingPlace: PUESTO, votingTable, ...VIVE_CERCA,
});
const elPuesto = async (nombre = PUESTO) => (await conAdmin('get', '/admin/puestos')).body.puestos.find((p) => p.pollingPlace === nombre);
const laMesa = async (nombre) => (await elPuesto()).mesas.find((m) => m.nombre === nombre);
const ultimoEvento = async (tipo) => (await pool.query(
  'SELECT metadata FROM audit_log WHERE event_type = $1 AND actor_ref = $2 ORDER BY id DESC LIMIT 1', [tipo, ADMIN.username]
)).rows[0]?.metadata;
// Las mesas de los votantes de esta prueba, descifradas.
const mesasDelPadron = async () => (await pool.query('SELECT voting_table FROM voters WHERE cedula = ANY($1)', [
  Array.from({ length: n }, (_, i) => encryptField(`CI-MESA${i + 1}-${sufijo}`)),
])).rows.map((f) => decryptField(f.voting_table)).sort();

beforeAll(async () => {
  await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [ADMIN.username, await bcrypt.hash(ADMIN.password, 4), 'admin']);
  adminToken = (await request(app).post('/login/admin').send(ADMIN)).body.token;
  expect((await agregarVotantes(['Mesa 1', 'Mesa 1', 'Mesa 2'])).status).toBe(201);
});

afterAll(async () => {
  await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [Array.from({ length: n }, (_, i) => encryptField(`CI-MESA${i + 1}-${sufijo}`))]);
  await pool.query('DELETE FROM admins WHERE username LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM mesas_votacion WHERE puesto_clave LIKE $1', [`% ${sufijo}`]);
  await pool.query('DELETE FROM puestos_votacion WHERE clave LIKE $1', [`% ${sufijo}`]);
  await pool.end();
});

describe('Crear una mesa', () => {
  it('queda en el puesto sin votantes, y se puede elegir para votantes y jurados', async () => {
    const res = await crearMesa('  Mesa   3 ');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ pollingPlace: PUESTO, votingTable: 'Mesa 3' });
    expect(await laMesa('Mesa 3')).toEqual({ nombre: 'Mesa 3', votantes: 0, jurados: 0 });
    expect(await ultimoEvento('MESA_CREADA')).toEqual({ pollingPlace: PUESTO, votingTable: 'Mesa 3' });

    const lugares = (await conAdmin('get', '/admin/padron/lugares')).body.places.find((p) => p.pollingPlace === PUESTO);
    expect(lugares.votingTables).toEqual(['Mesa 1', 'Mesa 2', 'Mesa 3']);
    // Un jurado ya puede ser de ella...
    expect((await crearJurado('3')).status).toBe(201);
    expect(await laMesa('Mesa 3')).toEqual({ nombre: 'Mesa 3', votantes: 0, jurados: 1 });
    // ...y un votante escrito "3" queda en ella, con el nombre con que se creó.
    expect((await agregarVotantes(['3'])).status).toBe(201);
    expect(await laMesa('Mesa 3')).toMatchObject({ votantes: 1 });
    expect(await mesasDelPadron()).toEqual(['Mesa 1', 'Mesa 1', 'Mesa 2', 'Mesa 3']);
  });

  it('no repite una mesa escrita de otra forma, ni la crea en un puesto que no existe, ni acepta «Mesa» sola', async () => {
    expect((await crearMesa('1')).status).toBe(409);
    expect((await crearMesa('MESA 2')).body.error).toBe(`El puesto «${PUESTO}» ya tiene la mesa «Mesa 2».`);
    expect((await crearMesa('Mesa 1', `Puesto Inexistente ${sufijo}`)).status).toBe(404);
    expect((await crearMesa('Mesa')).status).toBe(400);
    expect((await crearMesa('x'.repeat(51))).status).toBe(400);
  });
});

describe('Renombrar una mesa', () => {
  it('cambia la mesa de sus votantes y de sus jurados, y queda en la auditoría', async () => {
    expect((await crearJurado('Mesa 1')).status).toBe(201);
    const res = await renombrar('1', 'Mesa A');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pollingPlace: PUESTO, votingTable: 'Mesa A', votantes: 2, jurados: 1 });
    expect(await mesasDelPadron()).toEqual(['Mesa 2', 'Mesa 3', 'Mesa A', 'Mesa A']);
    const jurado = await pool.query('SELECT voting_table FROM admins WHERE username = $1', [`${RUN_ID}_j2`]);
    expect(decryptField(jurado.rows[0].voting_table)).toBe('Mesa A');
    expect(await laMesa('Mesa A')).toEqual({ nombre: 'Mesa A', votantes: 2, jurados: 1 });
    expect(await laMesa('Mesa 1')).toBeUndefined();
    expect(await ultimoEvento('MESA_RENOMBRADA')).toEqual({ pollingPlace: PUESTO, antes: 'Mesa 1', ahora: 'Mesa A', votantes: 2, jurados: 1 });
  });

  it('una mesa creada sin votantes también se renombra, y se puede cambiar solo cómo se escribe', async () => {
    expect((await crearMesa('7')).status).toBe(201);
    expect((await renombrar('7', 'Mesa 7')).body).toEqual({ pollingPlace: PUESTO, votingTable: 'Mesa 7', votantes: 0, jurados: 0 });
    expect((await renombrar('Mesa 7', 'Mesa 8')).status).toBe(200);
    expect(await laMesa('Mesa 8')).toEqual({ nombre: 'Mesa 8', votantes: 0, jurados: 0 });
    expect(await laMesa('Mesa 7')).toBeUndefined();
  });

  it('no junta dos mesas, no repite el mismo nombre y no renombra una mesa que no existe', async () => {
    const juntar = await renombrar('Mesa 2', '3');
    expect(juntar.status).toBe(409);
    expect(juntar.body.error).toBe(`El puesto «${PUESTO}» ya tiene la mesa «Mesa 3»: con ese nombre, las dos mesas quedarían en una.`);
    expect((await renombrar('Mesa 2', 'Mesa 2')).status).toBe(400);
    expect((await renombrar('Mesa 99', 'Mesa 100')).status).toBe(404);
    expect(await mesasDelPadron()).toEqual(['Mesa 2', 'Mesa 3', 'Mesa A', 'Mesa A']);
  });

  it('no con una votación en curso: el acta quedaría partida entre los dos nombres', async () => {
    const eleccion = await abrirVotacion(`${RUN_ID} en curso`);
    try {
      const res = await renombrar('Mesa 2', 'Mesa B');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/^Hay una votación en curso/);
      expect(await mesasDelPadron()).toContain('Mesa 2');
    } finally {
      await cerrarVotacion(eleccion);
    }
    expect((await renombrar('Mesa 2', 'Mesa B')).status).toBe(200);
  });
});

describe('Eliminar una mesa', () => {
  it('solo sin votantes ni jurados', async () => {
    const conVotantes = await eliminar('Mesa B');
    expect(conVotantes.status).toBe(409);
    expect(conVotantes.body.error).toBe('La mesa «Mesa B» tiene 1 votante: no se puede eliminar. Si el nombre está mal, renómbrala.');

    expect((await crearMesa('Mesa 9')).status).toBe(201);
    expect((await crearJurado('9')).status).toBe(201);
    const conJurado = await eliminar('9');
    expect(conJurado.status).toBe(409);
    expect(conJurado.body.error).toMatch(/tiene 1 jurado: cámbiale la mesa en «Usuarios»/);
    await pool.query('DELETE FROM admins WHERE username = $1', [`${RUN_ID}_j3`]);

    expect((await eliminar('mesa 9')).status).toBe(204);
    expect(await laMesa('Mesa 9')).toBeUndefined();
    expect(await ultimoEvento('MESA_ELIMINADA')).toEqual({ pollingPlace: PUESTO, votingTable: 'Mesa 9' });
    expect((await eliminar('Mesa 9')).status).toBe(404);
  });

  it('al quitar un puesto sin votantes se van también sus mesas creadas', async () => {
    const vacio = `Puesto Vacío ${sufijo}`;
    const fila = await pool.query(
      `INSERT INTO puestos_votacion (nombre, clave, codigo_municipio, departamento, municipio, zona)
       VALUES ($1, $2, '15001', 'Boyacá', 'Tunja', 'urbana') RETURNING id`,
      [vacio, vacio.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')]
    );
    expect((await crearMesa('Mesa 1', vacio)).status).toBe(201);
    expect((await elPuesto(vacio)).mesas).toEqual([{ nombre: 'Mesa 1', votantes: 0, jurados: 0 }]);
    expect((await conAdmin('delete', `/admin/puestos/${fila.rows[0].id}`)).status).toBe(204);
    expect((await pool.query('SELECT 1 FROM mesas_votacion WHERE puesto_clave = $1', [vacio.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')])).rows).toEqual([]);
  });
});

describe('Permisos', () => {
  it('solo un administrador crea, renombra o elimina mesas', async () => {
    expect((await request(app).post('/admin/mesas').send({ pollingPlace: PUESTO, votingTable: 'Mesa 5' })).status).toBe(401);
    expect((await request(app).put('/admin/mesas').send({ pollingPlace: PUESTO, votingTable: 'Mesa 2', nombre: 'Mesa C' })).status).toBe(401);
    expect((await request(app).delete('/admin/mesas').send({ pollingPlace: PUESTO, votingTable: 'Mesa 3' })).status).toBe(401);
  });
});

// Dónde vive cada jurado (migración 011): solo puede ser de un puesto cerca,
// del mismo municipio y, si el puesto tiene localidad, de la misma
// (cercaDelPuesto en divipola.js).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField, decryptField } = require('../voterCrypto');

const RUN_ID = `CITEST_JUB_${Date.now()}`;
const sufijo = Date.now().toString().slice(-7);
const KENNEDY = `Colegio Kennedy ${sufijo}`;
const USAQUEN = `Colegio Usaquén ${sufijo}`;
const CHIA = `Escuela Chía ${sufijo}`;
const FAGUA = `Escuela Fagua ${sufijo}`;
let n = 0;
const cedula = () => `CI-JUB${(n += 1)}-${sufijo}`;
const ADMIN = { username: `${RUN_ID}_admin`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };
const CLAVE = `Ci-${crypto.randomBytes(12).toString('base64url')}`;
let jurados = 0;

const BOGOTA = { departamento: 'Bogotá', municipio: 'Bogotá' };
const VIVE_KENNEDY = { ...BOGOTA, localidad: 'Kennedy' };
const VIVE_USAQUEN = { ...BOGOTA, localidad: 'Usaquén' };
const VIVE_CHIA = { departamento: 'Cundinamarca', municipio: 'Chía' };

let adminToken;
const PEDIDOS = {
  get: (r) => request(app).get(r), post: (r) => request(app).post(r), put: (r) => request(app).put(r),
};
let ip = 0;
const conAdmin = (metodo, ruta) =>
  PEDIDOS[metodo](ruta) // eslint-disable-line security/detect-object-injection -- metodo es siempre un literal de estas pruebas
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Forwarded-For', `198.18.4.${(ip++ % 250) + 1}`);
const crearJurado = (pollingPlace, vive) => conAdmin('post', '/admin/users').send({
  username: `${RUN_ID}_j${(jurados += 1)}`, password: CLAVE, role: 'jurado', pollingPlace, votingTable: 'Mesa 1', ...vive,
});
const usuario = async (username) => (await conAdmin('get', '/admin/users')).body.users.find((u) => u.username === username);

beforeAll(async () => {
  await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [ADMIN.username, await bcrypt.hash(ADMIN.password, 4), 'admin']);
  adminToken = (await request(app).post('/login/admin').send(ADMIN)).body.token;
  const votante = (pollingPlace, ubicacion) => ({ cedula: cedula(), fullName: 'Votante', pollingPlace, votingTable: 'Mesa 1', ...ubicacion });
  const carga = await conAdmin('post', '/admin/voters').send({
    voters: [
      votante(KENNEDY, { ...VIVE_KENNEDY, zona: 'urbana' }),
      votante(USAQUEN, { ...VIVE_USAQUEN, zona: 'urbana' }),
      votante(CHIA, { ...VIVE_CHIA, zona: 'rural' }),
      votante(FAGUA, { ...VIVE_CHIA, localidad: 'Vereda Fagua', zona: 'rural' }),
    ],
  });
  expect(carga.status).toBe(201);
});

afterAll(async () => {
  await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [Array.from({ length: n }, (_, i) => encryptField(`CI-JUB${i + 1}-${sufijo}`))]);
  await pool.query('DELETE FROM admins WHERE username LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM puestos_votacion WHERE clave LIKE $1', [`% ${sufijo}`]);
  await pool.end();
});

describe('Crear un jurado', () => {
  it('necesita dónde vive, de las listas del DANE', async () => {
    const sin = await crearJurado(KENNEDY, {});
    expect(sin.status).toBe(400);
    expect(sin.body.error).toMatch(/^Indica dónde vive el jurado/);
    const mal = await crearJurado(KENNEDY, { departamento: 'Bogotá', municipio: 'Medellín' });
    expect(mal.status).toBe(400);
    expect(mal.body.error).toMatch(/^Dónde vive el jurado: no hay un municipio «Medellín»/);
    const localidad = await crearJurado(KENNEDY, { ...BOGOTA, localidad: 'Chapinero Alto' });
    expect(localidad.body.error).toMatch(/no es una de las 20 localidades/);
  });

  it('solo de un puesto de su municipio y de su localidad', async () => {
    expect((await crearJurado(KENNEDY, VIVE_KENNEDY)).status).toBe(201);
    const otraLocalidad = await crearJurado(USAQUEN, VIVE_KENNEDY);
    expect(otraLocalidad.status).toBe(400);
    expect(otraLocalidad.body.error).toBe(
      `El puesto «${USAQUEN}» está en Bogotá, D.C., Usaquén y el jurado vive en Bogotá, D.C., Kennedy: `
      + 'un jurado solo puede ser de un puesto de su municipio y, si el puesto tiene localidad, de su misma localidad.'
    );
    const otroMunicipio = await crearJurado(KENNEDY, { departamento: 'Boyacá', municipio: 'Tunja' });
    expect(otroMunicipio.status).toBe(400);
    expect(otroMunicipio.body.error).toMatch(/y el jurado vive en Tunja \(Boyacá\):/);
  });

  it('un puesto sin localidad queda cerca de todo su municipio; uno con localidad, solo de los que viven en ella', async () => {
    expect((await crearJurado(CHIA, VIVE_CHIA)).status).toBe(201);
    expect((await crearJurado(FAGUA, VIVE_CHIA)).status).toBe(400);
    // La localidad se compara sin mayúsculas, tildes ni espacios de más.
    expect((await crearJurado(FAGUA, { ...VIVE_CHIA, localidad: '  vereda  FAGUA ' })).status).toBe(201);
  });
});

describe('Usuarios y cambio de mesa', () => {
  it('el listado dice dónde vive cada jurado y si su puesto está cerca', async () => {
    const kennedy = await usuario(`${RUN_ID}_j4`);
    expect(kennedy).toMatchObject({ polling_place: KENNEDY, cerca: true });
    expect(kennedy.ubicacion).toEqual({
      pais: 'Colombia', codigoMunicipio: '11001', departamento: 'Bogotá, D.C.', municipio: 'Bogotá, D.C.', localidad: 'Kennedy', zona: null,
    });
    // Un jurado de antes de la migración 011 no tiene ubicación: ni cerca ni lejos.
    await pool.query(
      "INSERT INTO admins (username, password_hash, role, polling_place, voting_table) VALUES ($1, 'x', 'jurado', $2, $3)",
      [`${RUN_ID}_viejo`, encryptField(KENNEDY), encryptField('Mesa 1')]
    );
    expect(await usuario(`${RUN_ID}_viejo`)).toMatchObject({ ubicacion: null, cerca: null });
  });

  it('se guarda cifrada', async () => {
    const { rows } = await pool.query('SELECT ubicacion FROM admins WHERE username = $1', [`${RUN_ID}_j4`]);
    expect(rows[0].ubicacion).not.toMatch(/Kennedy/);
    expect(JSON.parse(decryptField(rows[0].ubicacion)).localidad).toBe('Kennedy');
  });

  it('no se le cambia a un puesto lejos; con dónde vive ahora, sí', async () => {
    const { id } = await usuario(`${RUN_ID}_j4`);
    const lejos = await conAdmin('put', `/admin/users/${id}/mesa`).send({ pollingPlace: USAQUEN, votingTable: 'Mesa 1' });
    expect(lejos.status).toBe(400);
    expect(lejos.body.error).toMatch(/y el jurado vive en Bogotá, D.C., Kennedy:/);
    const mudado = await conAdmin('put', `/admin/users/${id}/mesa`).send({ pollingPlace: USAQUEN, votingTable: 'Mesa 1', ...VIVE_USAQUEN });
    expect(mudado.status).toBe(200);
    expect(mudado.body).toMatchObject({ pollingPlace: USAQUEN, ubicacion: { localidad: 'Usaquén' } });
    expect(await usuario(`${RUN_ID}_j4`)).toMatchObject({ polling_place: USAQUEN, cerca: true });
  });

  it('a un jurado sin ubicación se le pide al cambiarle la mesa', async () => {
    const { id } = await usuario(`${RUN_ID}_viejo`);
    expect((await conAdmin('put', `/admin/users/${id}/mesa`).send({ pollingPlace: KENNEDY, votingTable: 'Mesa 1' })).status).toBe(400);
    const res = await conAdmin('put', `/admin/users/${id}/mesa`).send({ pollingPlace: KENNEDY, votingTable: 'Mesa 1', ...VIVE_KENNEDY });
    expect(res.status).toBe(200);
    expect(await usuario(`${RUN_ID}_viejo`)).toMatchObject({ ubicacion: { localidad: 'Kennedy' }, cerca: true });
  });

  it('si después se corrige la ubicación del puesto, el listado avisa que el jurado quedó lejos', async () => {
    const res = await conAdmin('put', '/admin/puestos/ubicacion').send({ pollingPlace: KENNEDY, ...BOGOTA, localidad: 'Bosa', zona: 'urbana' });
    expect(res.status).toBe(200);
    expect(await usuario(`${RUN_ID}_viejo`)).toMatchObject({ polling_place: KENNEDY, cerca: false });
  });
});

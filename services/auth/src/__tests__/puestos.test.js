// Puestos de votación con su ubicación (migración 009): todo puesto la
// necesita, se registra con su primer votante y se corrige en "Puestos".
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField } = require('../voterCrypto');
const { normalizarPuesto } = require('../lugares');

const RUN_ID = `CITEST_PUE_${Date.now()}`;
const sufijo = Date.now().toString().slice(-7);
const puesto = (nombre) => `${nombre} ${sufijo}`;
let n = 0;
const cedula = () => `CI-PUE${(n += 1)}-${sufijo}`;
const ADMIN = { username: `${RUN_ID}_admin`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };
const TUNJA = { departamento: 'Boyacá', municipio: 'Tunja', zona: 'urbana' };

let adminToken;
// Cada pedido sale de otra IP: este archivo hace más de 20 operaciones.
const PEDIDOS = {
  get: (r) => request(app).get(r), post: (r) => request(app).post(r), put: (r) => request(app).put(r), delete: (r) => request(app).delete(r),
};
let ip = 0;
const conAdmin = (metodo, ruta) =>
  PEDIDOS[metodo](ruta) // eslint-disable-line security/detect-object-injection -- metodo es siempre un literal de estas pruebas
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Forwarded-For', `198.18.2.${(ip++ % 250) + 1}`);
const votante = (pollingPlace, extra = {}) => ({ cedula: cedula(), fullName: 'Votante de Puesto', pollingPlace, votingTable: 'Mesa 1', ...extra });
const agregar = (voters) => conAdmin('post', '/admin/voters').send({ voters });
const puestos = async () => (await conAdmin('get', '/admin/puestos')).body.puestos;
const buscar = async (nombre) => (await puestos()).find((p) => p.pollingPlace === nombre);

beforeAll(async () => {
  await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [ADMIN.username, await bcrypt.hash(ADMIN.password, 4), 'admin']);
  adminToken = (await request(app).post('/login/admin').send(ADMIN)).body.token;
});

afterAll(async () => {
  await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [Array.from({ length: n }, (_, i) => encryptField(`CI-PUE${i + 1}-${sufijo}`))]);
  await pool.query('DELETE FROM puestos_votacion WHERE clave LIKE $1', [`% ${sufijo}`]);
  await pool.query('DELETE FROM admins WHERE username = $1', [ADMIN.username]);
  await pool.end();
});

describe('Al agregar votantes', () => {
  it('un puesto nuevo sin ubicación se rechaza, y no se agrega nadie', async () => {
    const res = await agregar([votante(puesto('Sin Ubicación'))]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Votante 1: el puesto «${puesto('Sin Ubicación')}» todavía no tiene ubicación: indica su departamento, su municipio y su zona (urbana o rural).`);
    expect(await buscar(puesto('Sin Ubicación'))).toBeUndefined();
  });

  it('basta con que una fila del puesto la traiga, en cualquier orden; otra puede agregar la localidad', async () => {
    const nombre = puesto('Colegio Andino');
    const res = await agregar([
      votante(nombre),
      votante(nombre.toUpperCase(), { ...TUNJA, departamento: 'BOYACA' }),
      votante(nombre, { ...TUNJA, localidad: 'Centro' }),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(3);
    expect(await buscar(nombre)).toMatchObject({
      votingTables: ['Mesa 1'],
      voters: 3,
      ubicacion: { pais: 'Colombia', codigoMunicipio: '15001', departamento: 'Boyacá', municipio: 'Tunja', localidad: 'Centro', zona: 'urbana' },
    });
    const { rows } = await pool.query(`SELECT metadata FROM audit_log WHERE event_type = 'VOTERS_ADDED' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].metadata.puestosUbicados).toEqual([nombre]);
  });

  it('un puesto que ya tiene ubicación no la necesita, y no la cambia por una carga', async () => {
    const nombre = puesto('Colegio Andino');
    expect((await agregar([votante(nombre), votante(nombre, { ...TUNJA, municipio: '15001' })])).status).toBe(201);
    const otra = await agregar([votante(nombre, { departamento: 'Boyacá', municipio: 'Duitama', zona: 'urbana' })]);
    expect(otra.status).toBe(400);
    expect(otra.body.error).toBe(
      `Votante 1: el puesto «${nombre}» está en Tunja (Boyacá), Centro, zona urbana, y aquí dice Duitama (Boyacá), zona urbana. `
      + 'Si es otro puesto, dale otro nombre; si la ubicación está mal, corrígela en la pestaña «Puestos».',
    );
  });

  it('dos ubicaciones distintas para un mismo puesto nuevo, o una que no existe, se rechazan', async () => {
    const nombre = puesto('Escuela Doble');
    const doble = await agregar([votante(nombre, TUNJA), votante(nombre, { ...TUNJA, zona: 'rural' })]);
    expect(doble.status).toBe(400);
    expect(doble.body.error).toMatch(/^Votante 2: el puesto «.*» está en Tunja \(Boyacá\), zona urbana en otra fila, y aquí dice Tunja \(Boyacá\), zona rural\./);
    const mal = await agregar([votante(nombre, { departamento: 'Boyacá', municipio: 'Medellín', zona: 'urbana' })]);
    expect(mal.body.error).toBe('Votante 1: no hay un municipio «Medellín» en Boyacá.');
    expect(await buscar(nombre)).toBeUndefined();
  });

  it('la carga por API (/admin/voters/bulk) sigue las mismas reglas', async () => {
    const nombre = puesto('Puesto Bulk');
    const sin = await conAdmin('post', '/admin/voters/bulk').send({ voters: [votante(nombre)] });
    expect(sin.status).toBe(400);
    const con = await conAdmin('post', '/admin/voters/bulk').send({ voters: [votante(nombre, { departamento: 'Antioquia', municipio: 'Medellín', zona: 'urbana' })] });
    expect(con.status).toBe(201);
    expect((await buscar(nombre)).ubicacion).toMatchObject({ codigoMunicipio: '05001', municipio: 'Medellín' });
  });
});

describe('Filtrar el padrón por la ubicación del puesto', () => {
  const MEDELLIN = { departamento: 'Antioquia', municipio: 'Medellín', localidad: 'Comuna 14 El Poblado', zona: 'urbana' };
  const RURAL = { departamento: 'Antioquia', municipio: 'Medellín', localidad: 'Corregimiento Santa Elena', zona: 'rural' };
  const listar = async (filtros) => (await conAdmin('get', `/admin/voters?${new URLSearchParams({ q: sufijo, limit: '200', ...filtros })}`)).body;
  // Solo los puestos de estas pruebas (en este archivo hay otros, como el de la carga por API, en Medellín).
  const nombres = (body) => body.voters.map((v) => v.polling_place).filter((n) => n.startsWith('Filtro')).sort();

  beforeAll(async () => {
    expect((await agregar([
      votante(puesto('Filtro Poblado'), MEDELLIN), votante(puesto('Filtro Poblado')),
      votante(puesto('Filtro Santa Elena'), RURAL),
      votante(puesto('Filtro Tunja'), TUNJA),
    ])).status).toBe(201);
  });

  it('cada votante va con la ubicación de su puesto, y se filtra por departamento, municipio, localidad o zona', async () => {
    const antioquia = await listar({ departamento: '05' });
    expect(nombres(antioquia)).toEqual([puesto('Filtro Poblado'), puesto('Filtro Poblado'), puesto('Filtro Santa Elena')]);
    expect(antioquia.voters[0].ubicacion).toMatchObject({ departamento: 'Antioquia', municipio: 'Medellín', codigoMunicipio: '05001' });
    expect(nombres(await listar({ municipio: '15001' }))).toContain(puesto('Filtro Tunja'));
    expect(nombres(await listar({ municipio: '05001', zona: 'rural' }))).toEqual([puesto('Filtro Santa Elena')]);
    expect(nombres(await listar({ localidad: 'comuna 14 el poblado' }))).toEqual([puesto('Filtro Poblado'), puesto('Filtro Poblado')]);
    expect(nombres(await listar({ pais: 'Colombia', departamento: '05' }))).toHaveLength(3);
  });

  it('dice en qué departamentos votan los filtrados, de más a menos', async () => {
    const body = await listar({ pollingPlace: '' });
    const de = (codigo) => body.porDepartamento.find((d) => d.codigo === codigo);
    expect(de('05')).toEqual({ codigo: '05', departamento: 'Antioquia', votantes: expect.any(Number) });
    expect(de('05').votantes).toBeGreaterThanOrEqual(3);
    const conUbicacion = body.porDepartamento.filter((d) => d.codigo !== null).map((d) => d.votantes);
    expect(conUbicacion).toEqual([...conUbicacion].sort((a, b) => b - a));
    const antioquia = await listar({ departamento: '05' });
    expect(antioquia.porDepartamento).toEqual([{ codigo: '05', departamento: 'Antioquia', votantes: antioquia.total }]);
  });

  it('los votantes de un puesto sin ubicación se encuentran con país "sin ubicación"', async () => {
    const SIN = puesto('Filtro Sin Ubicación');
    await pool.query('INSERT INTO voters (cedula, full_name, polling_place, voting_table) VALUES ($1, $2, $3, $4)', [
      encryptField(cedula()), 'Votante Sin Ubicación', encryptField(SIN), encryptField('Mesa 1'),
    ]);
    const body = await listar({ pais: 'sin_ubicacion' });
    expect(nombres(body)).toContain(SIN);
    expect(body.voters.every((v) => v.ubicacion === null)).toBe(true);
    expect(body.porDepartamento.at(-1)).toMatchObject({ codigo: null, departamento: null });
  });

  it('un filtro de ubicación mal formado responde 400', async () => {
    for (const filtro of [{ departamento: 'Antioquia' }, { municipio: '123' }, { zona: 'mixta' }]) {
      expect((await conAdmin('get', `/admin/voters?${new URLSearchParams(filtro)}`)).status).toBe(400);
    }
  });
});

describe('Pestaña "Puestos"', () => {
  // Un puesto de antes de la migración 009: en el padrón, sin ubicación.
  const ANTIGUO = puesto('Puesto Antiguo');
  beforeAll(async () => {
    await pool.query('INSERT INTO voters (cedula, full_name, polling_place, voting_table) VALUES ($1, $2, $3, $4)', [
      encryptField(cedula()), 'Votante Antiguo', encryptField(ANTIGUO), encryptField('Mesa 1'),
    ]);
  });

  it('el catálogo del DANE y la lista de puestos son solo para el administrador', async () => {
    expect((await request(app).get('/admin/divipola')).status).toBe(401);
    expect((await request(app).get('/admin/puestos')).status).toBe(401);
    const catalogo = await conAdmin('get', '/admin/divipola');
    expect(catalogo.body.departamentos).toHaveLength(33);
    expect(catalogo.headers['cache-control']).toBe('private, max-age=86400');
  });

  it('un puesto sin ubicación figura así, y no se le agregan votantes hasta que la tenga', async () => {
    expect(await buscar(ANTIGUO)).toMatchObject({ voters: 1, ubicacion: null });
    expect((await agregar([votante(ANTIGUO)])).status).toBe(400);
  });

  it('el administrador le pone la ubicación, queda en la auditoría, y ya se le agregan votantes', async () => {
    const res = await conAdmin('put', '/admin/puestos/ubicacion').send({ pollingPlace: ANTIGUO.toLowerCase(), departamento: 'Bogotá', municipio: 'Bogotá', localidad: 'suba', zona: 'urbana' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pollingPlace: ANTIGUO, ubicacion: { codigoMunicipio: '11001', localidad: 'Suba' } });
    const { rows } = await pool.query(`SELECT metadata FROM audit_log WHERE event_type = 'PUESTO_UBICACION_GUARDADA' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].metadata).toEqual({ pollingPlace: ANTIGUO, antes: null, ahora: 'Bogotá, D.C., Suba, zona urbana', codigoMunicipio: '11001' });
    expect((await agregar([votante(ANTIGUO)])).status).toBe(201);
  });

  it('la corrige (sin localidad, la quita), y la auditoría dice cuál tenía', async () => {
    const res = await conAdmin('put', '/admin/puestos/ubicacion').send({ pollingPlace: ANTIGUO, departamento: '25', municipio: 'Chía', zona: 'rural' });
    expect(res.body.ubicacion).toMatchObject({ municipio: 'Chía', localidad: null, zona: 'rural' });
    const { rows } = await pool.query(`SELECT metadata FROM audit_log WHERE event_type = 'PUESTO_UBICACION_GUARDADA' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].metadata).toMatchObject({ antes: 'Bogotá, D.C., Suba, zona urbana', ahora: 'Chía (Cundinamarca), zona rural' });
  });

  it('un puesto que no existe, o una ubicación incompleta, se rechazan', async () => {
    const noExiste = await conAdmin('put', '/admin/puestos/ubicacion').send({ pollingPlace: puesto('No Existe'), ...TUNJA });
    expect(noExiste.status).toBe(404);
    const incompleta = await conAdmin('put', '/admin/puestos/ubicacion').send({ pollingPlace: ANTIGUO, departamento: 'Boyacá' });
    expect(incompleta.status).toBe(400);
    expect(incompleta.body.error).toBe('Falta el municipio; falta la zona (urbana o rural).');
    expect((await conAdmin('put', '/admin/puestos/ubicacion').send({ pollingPlace: ANTIGUO })).status).toBe(400);
  });

  it('un puesto con votantes no se quita; sin votantes, sí', async () => {
    const { id } = (await buscar(ANTIGUO)).ubicacion;
    expect((await conAdmin('delete', `/admin/puestos/${id}`)).status).toBe(409);
    await pool.query('DELETE FROM voters WHERE polling_place = $1', [encryptField(ANTIGUO)]);
    expect(await buscar(ANTIGUO)).toMatchObject({ voters: 0, votingTables: [] });
    expect((await conAdmin('delete', `/admin/puestos/${id}`)).status).toBe(204);
    expect(await buscar(ANTIGUO)).toBeUndefined();
    const { rows } = await pool.query('SELECT 1 FROM puestos_votacion WHERE clave = $1', [normalizarPuesto(ANTIGUO)]);
    expect(rows).toHaveLength(0);
    expect((await conAdmin('delete', `/admin/puestos/${id}`)).status).toBe(404);
  });
});

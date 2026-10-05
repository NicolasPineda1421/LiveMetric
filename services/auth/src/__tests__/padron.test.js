// Padrón desde el panel: agregar votantes con el formulario (sin modificar
// a los que ya están), filtrar el listado y eliminar. Cada prueba usa un
// puesto propio de la corrida, para no mezclarse con los datos de otras.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField } = require('../voterCrypto');

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

describe('Sugerencias del buscador (autocompletar)', () => {
  const sugerir = (q) => conAdmin('get', `/admin/voters/sugerencias?q=${encodeURIComponent(q)}`);
  // Diez más, en otro puesto, para probar el máximo de 8; y uno cuya cédula
  // empieza con "an", para el orden.
  const extra = [...Array.from({ length: 10 }, (_, i) => `LIM${i}-${sufijo}`), `AN-${sufijo}`];

  beforeAll(async () => {
    await agregar(extra.map((cedula, i) => ({ cedula, fullName: i < 10 ? `Votante Lote ${i}` : 'Zoe Zapata', pollingPlace: `${PUESTO} B`, votingTable: 'Mesa 1' })));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [extra.map(encryptField)]);
  });

  it('muestra la cédula, el nombre, el puesto y la mesa de cada sugerencia', async () => {
    const res = await sugerir(`pad3-${sufijo}`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([
      { id: expect.any(Number), cedula: ced(3), fullName: 'Lucía Pérez', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
    ]);
  });

  it('primero las cédulas que empiezan con lo escrito, después por nombre', async () => {
    const res = await sugerir('an');
    const nombres = res.body.suggestions.map((v) => v.fullName);
    expect(nombres[0]).toBe('Zoe Zapata');
    expect(nombres).toEqual(expect.arrayContaining(['Ana Gómez', 'María José Ángel']));
    expect(nombres).not.toContain('Lucía Pérez');
  });

  it('por nombre, sin mayúsculas ni tildes, y también por una parte del medio', async () => {
    expect((await sugerir('LUC')).body.suggestions.map((v) => v.fullName)).toEqual(['Lucía Pérez']);
    expect((await sugerir('erez')).body.suggestions.map((v) => v.fullName)).toEqual(['Lucía Pérez']);
  });

  it('a lo sumo 8, con el total de coincidencias', async () => {
    const res = await sugerir(`lim`);
    expect(res.body.suggestions).toHaveLength(8);
    expect(res.body.total).toBe(10);
    expect(res.body.suggestions.map((v) => v.cedula)).toEqual(extra.slice(0, 8));
  });

  it('pide al menos 2 caracteres, y solo para el administrador', async () => {
    expect((await sugerir('a')).status).toBe(400);
    expect((await request(app).get('/admin/voters/sugerencias?q=an')).status).toBe(401);
  });
});

describe('Eliminar', () => {
  it('elimina al votante, queda en la auditoría sin la cédula, y ya no puede ingresar', async () => {
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

describe('Carga desde un archivo, en lotes', () => {
  const PUESTO_LOTE = `${PUESTO} Lote`;
  const cedLote = (n) => `LOTE${n}-${sufijo}`;
  // 45 votantes con nombres largos: el pedido pasa de 10 kB, el límite del
  // resto de las rutas. El puesto, la mitad escrito de otra forma.
  const lote = Array.from({ length: 45 }, (_, i) => ({
    cedula: cedLote(i),
    fullName: `Persona Importada ${i} ${'x'.repeat(150)}`,
    pollingPlace: i < 20 ? PUESTO_LOTE : PUESTO_LOTE.toUpperCase(),
    votingTable: i < 20 ? 'Mesa 1' : '1',
    ...(i === 0 ? { assisted: true } : {}),
  }));

  afterAll(async () => {
    await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [lote.map((v) => encryptField(v.cedula))]);
  });

  it('un lote de más de 10 kB entra, con el voto asistido, y un puesto nuevo queda escrito de una sola forma', async () => {
    expect(JSON.stringify({ voters: lote }).length).toBeGreaterThan(10 * 1024);
    const res = await agregar(lote, { origen: 'archivo' });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(45);
    expect(res.body.accessCodes[44]).toMatchObject({ cedula: cedLote(44), pollingPlace: PUESTO_LOTE, votingTable: 'Mesa 1' });

    const lista = await listar({ pollingPlace: PUESTO_LOTE });
    expect(lista.body.total).toBe(45);
    expect(new Set(lista.body.voters.map((v) => `${v.polling_place}|${v.voting_table}`))).toEqual(new Set([`${PUESTO_LOTE}|Mesa 1`]));
    expect((await listar({ pollingPlace: PUESTO_LOTE, assisted: 'true' })).body.voters.map((v) => v.cedula)).toEqual([cedLote(0)]);

    const { rows } = await pool.query(`SELECT metadata FROM audit_log WHERE event_type = 'VOTERS_ADDED' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].metadata).toMatchObject({ inserted: 45, duplicates: 0, assisted: 1, via: 'archivo' });
  }, 60000);

  it('volver a cargar el mismo archivo no cambia nada: todos se informan como repetidos', async () => {
    const res = await agregar([{ ...lote[1], fullName: 'Otro Nombre' }, lote[2]], { origen: 'archivo' });
    expect(res.body).toMatchObject({ inserted: 0, duplicates: [cedLote(1), cedLote(2)] });
    expect((await listar({ pollingPlace: PUESTO_LOTE, q: cedLote(1) })).body.voters[0].full_name).toBe(lote[1].fullName);
  });

  it('sin sesión no se lee el cuerpo grande, y las demás rutas siguen con el límite de 10 kB', async () => {
    expect((await request(app).post('/admin/voters').send({ voters: lote })).status).toBe(401);
    expect((await request(app).post('/admin/voters/bulk').send({ voters: lote })).status).toBe(401);
    expect((await request(app).post('/login/admin').set('X-Forwarded-For', '198.18.1.1').send({ username: 'x', password: 'y'.repeat(11 * 1024) })).status).toBe(413);
  });

  it('el voto asistido es sí o no, y el origen, formulario o archivo', async () => {
    const asistido = await agregar([{ ...lote[0], cedula: cedLote(99), assisted: 'si' }]);
    expect(asistido.status).toBe(400);
    expect(asistido.body.error).toBe('Votante 1: el voto asistido debe ser sí o no.');
    expect((await agregar([lote[0]], { origen: 'correo' })).status).toBe(400);
  });
});

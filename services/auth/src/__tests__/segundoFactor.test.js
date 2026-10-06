// Segundo factor del votante (TOTP) y voto asistido por el jurado de su
// mesa, de punta a punta contra la app y la base desechable de la corrida.
//
// Los códigos se calculan con el mismo secreto que tendría la app del
// celular. Un código no sirve dos veces y cada paso de 30 s se usa una sola
// vez, así que cada cuenta hace a lo sumo dos ingresos correctos (el paso
// actual y el siguiente, dentro del margen de ±30 s).
//
// Los intentos fallidos van desde IPs distintas (la app confía en un
// proxy, ver "trust proxy"): si no, este archivo agotaría el límite de
// intentos del login, que es por IP.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../app');
const pool = require('../db');
const { encryptField, decryptField } = require('../voterCrypto');
const { conUbicacion } = require('./ubicacion');
const totp = require('../totp');

const RUN_ID = `CITEST_2F_${Date.now()}`;
const sufijo = Date.now().toString().slice(-7);
const CEDULAS = { conApp: `CI-2FA-${sufijo}`, doble: `CI-2FB-${sufijo}`, asistida: `CI-2FC-${sufijo}`, otraMesa: `CI-2FD-${sufijo}` };
const PUESTO = `Puesto 2F ${sufijo}`;
const ADMIN = { username: `${RUN_ID}_admin`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };
const JURADO_1 = { username: `${RUN_ID}_j1`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };
const JURADO_2 = { username: `${RUN_ID}_j2`, password: `Ci-${crypto.randomBytes(12).toString('base64url')}` };

let adminToken;
const pins = new Map();
let ipLibre = 10;
const otraIp = () => `198.51.100.${ipLibre++}`;
const post = (ruta, cuerpo, ip = '192.0.2.1') => request(app).post(ruta).set('X-Forwarded-For', ip).send(cuerpo);
const METODOS = { get: (r) => request(app).get(r), post: (r) => request(app).post(r), put: (r) => request(app).put(r) };
// Las operaciones de administración tienen su propio límite por IP (20 por
// minuto): cada bloque que hace muchas usa la suya.
let ipAdmin = '192.0.2.200';
const conToken = (metodo, ruta, token) => METODOS[metodo](ruta).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ipAdmin); // eslint-disable-line security/detect-object-injection -- metodo es siempre un literal de estas pruebas

async function votante(cedula) {
  const r = await pool.query('SELECT id, totp_secret, totp_last_step FROM voters WHERE cedula = $1', [encryptField(cedula)]);
  return r.rows[0];
}

async function jurado(username) {
  const r = await pool.query('SELECT id, totp_secret, totp_last_step FROM admins WHERE username = $1', [username]);
  return r.rows[0];
}

// El próximo código que la cuenta todavía acepta: el del paso actual, o el
// siguiente si el actual ya se usó.
function codigoSiguiente(fila) {
  const paso = Math.max(totp.currentStep(), Number(fila.totp_last_step ?? -1) + 1);
  return totp.codeAt(decryptField(fila.totp_secret), paso);
}

const codigoDelQr = (paso1) => totp.codeAt(paso1.body.secret, totp.currentStep());

async function eventos(tipo, actorRef) {
  const r = await pool.query('SELECT metadata FROM audit_log WHERE event_type = $1 AND actor_ref = $2', [tipo, actorRef]);
  return r.rows;
}

beforeAll(async () => {
  await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [
    ADMIN.username,
    await bcrypt.hash(ADMIN.password, 4),
    'admin',
  ]);
  adminToken = (await post('/login/admin', ADMIN)).body.token;

  const carga = await conToken('post', '/admin/voters/bulk', adminToken).send({
    voters: conUbicacion([
      { cedula: CEDULAS.conApp, fullName: 'Votante Con App', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
      { cedula: CEDULAS.doble, fullName: 'Votante Doble Registro', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
      { cedula: CEDULAS.asistida, fullName: 'Votante Asistida', pollingPlace: PUESTO, votingTable: 'Mesa 1' },
      { cedula: CEDULAS.otraMesa, fullName: 'Votante Otra Mesa', pollingPlace: PUESTO, votingTable: 'Mesa 2' },
    ]),
  });
  for (const { cedula, pin } of carga.body.accessCodes) pins.set(cedula, pin);

  for (const [cuenta, mesa] of [[JURADO_1, 'Mesa 1'], [JURADO_2, 'Mesa 2']]) {
    const creado = await conToken('post', '/admin/users', adminToken).send({
      ...cuenta,
      role: 'jurado',
      pollingPlace: PUESTO,
      votingTable: mesa,
    });
    expect(creado.status).toBe(201);
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM voters WHERE cedula = ANY($1)', [Object.values(CEDULAS).map(encryptField)]);
  await pool.query('DELETE FROM admins WHERE username LIKE $1', [`${RUN_ID}%`]);
  await pool.end();
});

describe('Votante con autenticador', () => {
  let paso1;

  it('con el PIN correcto todavía no hay sesión: el primer ingreso pide registrar el autenticador', async () => {
    paso1 = await post('/login/voter', { cedula: CEDULAS.conApp, pin: pins.get(CEDULAS.conApp) });
    expect(paso1.status).toBe(200);
    expect(paso1.body.next).toBe('registro');
    expect(paso1.body.token).toBeUndefined();
    expect(paso1.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(paso1.body.otpauthUri).toContain(`secret=${paso1.body.secret}`);
    // La cuenta en la app muestra solo los últimos 4 dígitos de la cédula.
    expect(decodeURIComponent(paso1.body.otpauthUri)).toContain(`Votante ···${CEDULAS.conApp.slice(-4)}`);
  });

  it('el desafío del primer paso no sirve como sesión', async () => {
    const res = await conToken('get', '/admin/voters', paso1.body.challenge);
    expect(res.status).toBe(403);
  });

  it('un código equivocado no registra nada', async () => {
    const malo = codigoDelQr(paso1) === '000000' ? '111111' : '000000';
    const res = await post('/login/voter/registro', { challenge: paso1.body.challenge, code: malo }, otraIp());
    expect(res.status).toBe(401);
    expect((await votante(CEDULAS.conApp)).totp_secret).toBeNull();
  });

  it('con un código válido registra el autenticador (cifrado) y abre la sesión', async () => {
    const res = await post('/login/voter/registro', { challenge: paso1.body.challenge, code: codigoDelQr(paso1) });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('voter');
    expect(res.body.pollingPlace).toBe(PUESTO);
    const fila = await votante(CEDULAS.conApp);
    expect(fila.totp_secret).not.toBe(paso1.body.secret);
    expect(decryptField(fila.totp_secret)).toBe(paso1.body.secret);
  });

  it('en los ingresos siguientes pide el código, y un código usado no sirve otra vez', async () => {
    const pedir = () => post('/login/voter', { cedula: CEDULAS.conApp, pin: pins.get(CEDULAS.conApp) });
    const primero = await pedir();
    expect(primero.body).toEqual({ next: 'codigo', challenge: expect.any(String) });
    const codigo = codigoSiguiente(await votante(CEDULAS.conApp));
    const sesion = await post('/login/voter/codigo', { challenge: primero.body.challenge, code: codigo });
    expect(sesion.status).toBe(200);
    expect(sesion.body.role).toBe('voter');

    const segundo = await pedir();
    const reuso = await post('/login/voter/codigo', { challenge: segundo.body.challenge, code: codigo }, otraIp());
    expect(reuso.status).toBe(401);
    expect(reuso.body.error).toMatch(/Código incorrecto o vencido/);
  });

  it('un desafío solo sirve para su paso, y uno alterado no sirve', async () => {
    const paso = await post('/login/voter', { cedula: CEDULAS.conApp, pin: pins.get(CEDULAS.conApp) });
    const ip = otraIp();
    const enOtroPaso = await post('/login/voter/registro', { challenge: paso.body.challenge, code: '123456' }, ip);
    expect(enOtroPaso.status).toBe(401);
    const asistido = await post('/login/voter/asistido', { challenge: paso.body.challenge, juradoUsername: JURADO_1.username, juradoCode: '123456' }, ip);
    expect(asistido.status).toBe(401);
    const [cabecera, cuerpo, firma] = paso.body.challenge.split('.');
    const alterado = `${cabecera}.${cuerpo}.${firma.slice(0, -2)}xx`;
    const res = await post('/login/voter/codigo', { challenge: alterado, code: '123456' }, ip);
    expect(res.status).toBe(401);
  });

  it('si dos personas intentan registrar la misma cédula, gana la primera y la otra se entera', async () => {
    const ingreso = () => post('/login/voter', { cedula: CEDULAS.doble, pin: pins.get(CEDULAS.doble) });
    const [a, b] = [await ingreso(), await ingreso()];
    expect(a.body.secret).not.toBe(b.body.secret);
    expect((await post('/login/voter/registro', { challenge: a.body.challenge, code: codigoDelQr(a) })).status).toBe(200);
    const tarde = await post('/login/voter/registro', { challenge: b.body.challenge, code: codigoDelQr(b) }, otraIp());
    expect(tarde.status).toBe(409);
    expect(tarde.body.error).toMatch(/ya tiene un autenticador registrado/);
  });

  it('el administrador restablece el autenticador y el votante vuelve a registrarlo', async () => {
    const { id } = await votante(CEDULAS.doble);
    const res = await conToken('post', `/admin/voters/${id}/reset-totp`, adminToken);
    expect(res.status).toBe(200);
    expect((await votante(CEDULAS.doble)).totp_secret).toBeNull();
    const paso = await post('/login/voter', { cedula: CEDULAS.doble, pin: pins.get(CEDULAS.doble) });
    expect(paso.body.next).toBe('registro');
  });
});

describe('Voto asistido', () => {
  const ids = {};
  let tokenJurado1;

  beforeAll(async () => {
    ids.asistida = (await votante(CEDULAS.asistida)).id;
    ids.otraMesa = (await votante(CEDULAS.otraMesa)).id;
  });

  it('solo el administrador marca a un votante como asistido, y queda en la auditoría', async () => {
    const sinToken = await request(app).put(`/admin/voters/${ids.asistida}/assisted`).send({ assisted: true });
    expect(sinToken.status).toBe(401);
    for (const id of [ids.asistida, ids.otraMesa]) {
      const res = await conToken('put', `/admin/voters/${id}/assisted`, adminToken).send({ assisted: true });
      expect(res.body).toEqual({ id, assisted: true });
    }
    const malo = await conToken('put', `/admin/voters/${ids.asistida}/assisted`, adminToken).send({ assisted: 'si' });
    expect(malo.status).toBe(400);
    const auditoria = await eventos('VOTER_ASSISTED_CHANGED', ADMIN.username);
    expect(auditoria.map((e) => e.metadata)).toContainEqual({ voterId: ids.asistida, assisted: true });
  });

  it('un jurado sin puesto no se puede crear', async () => {
    const res = await conToken('post', '/admin/users', adminToken).send({
      username: `${RUN_ID}_jx`,
      password: JURADO_1.password,
      role: 'jurado',
    });
    expect(res.status).toBe(400);
  });

  it('el jurado también entra con segundo factor: registra su autenticador en el primer ingreso', async () => {
    const ip = otraIp();
    const paso1 = await post('/login/admin', JURADO_1, ip);
    expect(paso1.body.next).toBe('registro');
    expect(paso1.body.token).toBeUndefined();
    const sesion = await post('/login/admin/registro', { challenge: paso1.body.challenge, code: codigoDelQr(paso1) }, ip);
    expect(sesion.status).toBe(200);
    expect(sesion.body.role).toBe('jurado');
    tokenJurado1 = sesion.body.token;
  });

  it('el jurado ve su mesa y los votantes asistidos que puede autorizar, y nada del panel', async () => {
    const res = await conToken('get', '/jurado/mesa', tokenJurado1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pollingPlace: PUESTO,
      votingTable: 'Mesa 1',
      assistedVoters: [{ fullName: 'Votante Asistida', cedulaEnd: CEDULAS.asistida.slice(-4), votingTable: 'Mesa 1' }],
    });
    expect((await conToken('get', '/admin/voters', tokenJurado1)).status).toBe(403);
    expect((await conToken('get', '/jurado/mesa', adminToken)).status).toBe(403);
  });

  it('el votante asistido, con su PIN, pasa a la autorización del jurado (no a la app)', async () => {
    const paso1 = await post('/login/voter', { cedula: CEDULAS.asistida, pin: pins.get(CEDULAS.asistida) });
    expect(paso1.body).toEqual({ next: 'jurado', challenge: expect.any(String) });
    const conCodigo = await post('/login/voter/codigo', { challenge: paso1.body.challenge, code: '123456' }, otraIp());
    expect(conCodigo.status).toBe(401);
  });

  it('el código equivocado del jurado no autoriza', async () => {
    const paso1 = await post('/login/voter', { cedula: CEDULAS.asistida, pin: pins.get(CEDULAS.asistida) });
    const correcto = codigoSiguiente(await jurado(JURADO_1.username));
    const res = await post('/login/voter/asistido', {
      challenge: paso1.body.challenge,
      juradoUsername: JURADO_1.username,
      juradoCode: correcto === '000000' ? '111111' : '000000',
    }, otraIp());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Usuario o código del jurado incorrectos.');
  });

  it('un jurado no puede autorizar a un votante de otra mesa (y su código no se gasta)', async () => {
    const paso1 = await post('/login/voter', { cedula: CEDULAS.otraMesa, pin: pins.get(CEDULAS.otraMesa) });
    const antes = await jurado(JURADO_1.username);
    const res = await post('/login/voter/asistido', {
      challenge: paso1.body.challenge,
      juradoUsername: JURADO_1.username,
      juradoCode: codigoSiguiente(antes),
    }, otraIp());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no es de la mesa/);
    expect((await jurado(JURADO_1.username)).totp_last_step).toBe(antes.totp_last_step);
  });

  it('el jurado de su mesa autoriza: sesión de votante, y la auditoría dice quién autorizó', async () => {
    const paso1 = await post('/login/voter', { cedula: CEDULAS.asistida, pin: pins.get(CEDULAS.asistida) });
    const codigo = codigoSiguiente(await jurado(JURADO_1.username));
    const res = await post('/login/voter/asistido', {
      challenge: paso1.body.challenge,
      juradoUsername: JURADO_1.username,
      juradoCode: codigo,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'voter', pollingPlace: PUESTO, votingTable: 'Mesa 1' });
    const [autorizacion] = await eventos('ASSISTED_LOGIN_AUTHORIZED', JURADO_1.username);
    expect(autorizacion.metadata).toMatchObject({ pollingPlace: PUESTO, votingTable: 'Mesa 1' });

    // El mismo código del jurado no sirve para un segundo ingreso.
    const otra = await post('/login/voter', { cedula: CEDULAS.asistida, pin: pins.get(CEDULAS.asistida) });
    const reuso = await post('/login/voter/asistido', {
      challenge: otra.body.challenge,
      juradoUsername: JURADO_1.username,
      juradoCode: codigo,
    }, otraIp());
    expect(reuso.status).toBe(401);
  });

  it('con el autenticador ya registrado, el jurado entra con su código', async () => {
    const ip = otraIp();
    const registro = await post('/login/admin', JURADO_2, ip);
    await post('/login/admin/registro', { challenge: registro.body.challenge, code: codigoDelQr(registro) }, ip);

    const paso1 = await post('/login/admin', JURADO_2, ip);
    expect(paso1.body).toEqual({ next: 'codigo', challenge: expect.any(String) });
    const sesion = await post('/login/admin/codigo', { challenge: paso1.body.challenge, code: codigoSiguiente(await jurado(JURADO_2.username)) }, ip);
    expect(sesion.status).toBe(200);
    expect(sesion.body.role).toBe('jurado');
  });

  it('el administrador ve los jurados con su mesa y les restablece el autenticador', async () => {
    const lista = await conToken('get', '/admin/users', adminToken);
    const fila = lista.body.users.find((u) => u.username === JURADO_2.username);
    expect(fila).toMatchObject({ role: 'jurado', polling_place: PUESTO, voting_table: 'Mesa 2', has_totp: true });
    expect(fila).not.toHaveProperty('totp_secret');

    const res = await conToken('post', `/admin/users/${fila.id}/reset-totp`, adminToken);
    expect(res.status).toBe(200);
    expect((await jurado(JURADO_2.username)).totp_secret).toBeNull();

    const admin = lista.body.users.find((u) => u.username === ADMIN.username);
    expect((await conToken('post', `/admin/users/${admin.id}/reset-totp`, adminToken)).status).toBe(404);
  });
});

// El puesto y la mesa del jurado se eligen del padrón y se comparan sin
// depender de cómo se escribieron; sin mesa, el jurado es de todo el puesto.
// Corre después de "Voto asistido": los dos votantes asistidos (Mesa 1 y
// Mesa 2) ya están marcados.
describe('Puesto y mesa del jurado', () => {
  const JURADO_PUESTO = { username: `${RUN_ID}_jp`, password: JURADO_1.password };
  const JURADO_VIEJO = { username: `${RUN_ID}_jv`, password: JURADO_1.password };

  beforeAll(() => {
    ipAdmin = '192.0.2.201';
  });

  async function registrarJurado(cuenta) {
    const ip = otraIp();
    const paso1 = await post('/login/admin', cuenta, ip);
    const sesion = await post('/login/admin/registro', { challenge: paso1.body.challenge, code: codigoDelQr(paso1) }, ip);
    return sesion.body.token;
  }

  // Cada código del jurado sirve una vez, y el margen es de ±30 s: para
  // autorizar varias veces seguidas sin esperar al siguiente paso real, la
  // prueba olvida el último paso usado (en la vida real, pasan 30 s).
  async function autorizar(cedula, cuenta, ip) {
    await pool.query('UPDATE admins SET totp_last_step = NULL WHERE username = $1', [cuenta.username]);
    const paso1 = await post('/login/voter', { cedula, pin: pins.get(cedula) }, ip);
    return post('/login/voter/asistido', {
      challenge: paso1.body.challenge,
      juradoUsername: cuenta.username,
      juradoCode: codigoSiguiente(await jurado(cuenta.username)),
    }, ip);
  }

  it('el administrador ve los puestos del padrón con sus mesas', async () => {
    const res = await conToken('get', '/admin/padron/lugares', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.places).toContainEqual({
      pollingPlace: PUESTO,
      votingTables: ['Mesa 1', 'Mesa 2'],
      voters: 4,
      ubicacion: expect.objectContaining({ municipio: 'Tunja', departamento: 'Boyacá', codigoMunicipio: '15001', zona: 'urbana' }),
    });
  });

  it('al crearlo, el puesto y la mesa se guardan como figuran en el padrón, aunque se escriban distinto', async () => {
    const cuenta = { username: `${RUN_ID}_jn`, password: JURADO_1.password };
    const res = await conToken('post', '/admin/users', adminToken).send({ ...cuenta, role: 'jurado', pollingPlace: PUESTO.toLowerCase(), votingTable: '1' });
    expect(res.status).toBe(201);
    const fila = (await conToken('get', '/admin/users', adminToken)).body.users.find((u) => u.username === cuenta.username);
    expect(fila).toMatchObject({ polling_place: PUESTO, voting_table: 'Mesa 1' });
  });

  it('un puesto o una mesa que no están en el padrón se rechazan', async () => {
    const crear = (lugar) => conToken('post', '/admin/users', adminToken).send({ username: `${RUN_ID}_jx2`, password: JURADO_1.password, role: 'jurado', ...lugar });
    const puesto = await crear({ pollingPlace: 'Punto central', votingTable: 'Mesa 1' });
    expect(puesto.status).toBe(400);
    expect(puesto.body.error).toBe('Ese puesto no está en el padrón.');
    const mesa = await crear({ pollingPlace: PUESTO, votingTable: 'Mesa 9' });
    expect(mesa.body.error).toBe('Esa mesa no está en ese puesto del padrón.');
  });

  it('un jurado de todo el puesto ve los asistidos de todas sus mesas y autoriza en cualquiera', async () => {
    const creado = await conToken('post', '/admin/users', adminToken).send({ ...JURADO_PUESTO, role: 'jurado', pollingPlace: PUESTO });
    expect(creado.status).toBe(201);
    const token = await registrarJurado(JURADO_PUESTO);
    const panel = await conToken('get', '/jurado/mesa', token);
    expect(panel.body.votingTable).toBeNull();
    expect(panel.body.assistedVoters.map((v) => v.votingTable).sort()).toEqual(['Mesa 1', 'Mesa 2']);

    const res = await autorizar(CEDULAS.otraMesa, JURADO_PUESTO);
    expect(res.status).toBe(200);
    expect(res.body.votingTable).toBe('Mesa 2');
  });

  it('un jurado creado antes, con la mesa escrita "1", autoriza a los votantes de la "Mesa 1"', async () => {
    await pool.query(
      `INSERT INTO admins (username, password_hash, role, polling_place, voting_table) VALUES ($1, $2, 'jurado', $3, $4)`,
      [JURADO_VIEJO.username, await bcrypt.hash(JURADO_VIEJO.password, 4), encryptField(PUESTO.toUpperCase()), encryptField('1')]
    );
    await registrarJurado(JURADO_VIEJO);
    const res = await autorizar(CEDULAS.asistida, JURADO_VIEJO);
    expect(res.status).toBe(200);
    const otra = await autorizar(CEDULAS.otraMesa, JURADO_VIEJO, otraIp());
    expect(otra.status).toBe(403);
    expect(otra.body.error).toBe('Ese jurado no es de la mesa ni del puesto de este votante.');
  });

  it('el administrador cambia la mesa de un jurado (o lo deja en todo el puesto), y queda en la auditoría', async () => {
    const { id } = await jurado(JURADO_VIEJO.username);
    const res = await conToken('put', `/admin/users/${id}/mesa`, adminToken).send({ pollingPlace: PUESTO, votingTable: 'mesa 2' });
    expect(res.body).toEqual({ id, pollingPlace: PUESTO, votingTable: 'Mesa 2' });
    expect((await autorizar(CEDULAS.otraMesa, JURADO_VIEJO)).status).toBe(200);

    const todo = await conToken('put', `/admin/users/${id}/mesa`, adminToken).send({ pollingPlace: PUESTO, votingTable: '' });
    expect(todo.body.votingTable).toBeNull();
    expect((await conToken('put', `/admin/users/${id}/mesa`, adminToken).send({ pollingPlace: 'Punto central' })).status).toBe(400);
    const admin = (await conToken('get', '/admin/users', adminToken)).body.users.find((u) => u.username === ADMIN.username);
    expect((await conToken('put', `/admin/users/${admin.id}/mesa`, adminToken).send({ pollingPlace: PUESTO })).status).toBe(404);
    const auditoria = await eventos('JURADO_MESA_CHANGED', ADMIN.username);
    expect(auditoria.map((e) => e.metadata.votingTable)).toEqual(expect.arrayContaining(['Mesa 2', null]));
  });
});

// Los scripts de terminal que piden una contraseña: crearAdmin.js (el primer
// administrador, como lo usan los scripts de arranque) y cambiarContrasena.js.
// Se ejecutan de verdad, con lo que se escribe en la terminal llegando por la
// entrada estándar.
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const RUN_ID = `CITEST_CA_${Date.now()}`;
const FUERTE = 'k7#Pq2!mZ9vL-Tr4v3s';

// Corre el script con las líneas dadas como entrada; devuelve código y salida.
function correr(script, args, lineas) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], { env: process.env });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    hijo.on('close', (code) => resolve({ code, salida }));
    hijo.stdin.end(lineas.map((l) => `${l}\n`).join(''));
  });
}
const crearAdmin = (args, lineas) => correr('crearAdmin.js', args, lineas);
const cambiarContrasena = (args, lineas) => correr('cambiarContrasena.js', args, lineas);

const existe = async (username) => (await pool.query('SELECT 1 FROM admins WHERE username = $1', [username])).rows.length === 1;

afterAll(async () => {
  await pool.query('DELETE FROM admins WHERE username LIKE $1', [`${RUN_ID}%`]);
  await pool.end();
});

it('una contraseña débil se rechaza con el motivo y se vuelve a pedir; con una segura, crea el administrador', async () => {
  const usuario = `${RUN_ID}_a`;
  const { code, salida } = await crearAdmin([usuario, 'admin'], ['1234567890', FUERTE, FUERTE]);
  expect(code).toBe(0);
  expect(salida).toMatch(/La contraseña no es segura: tiene menos de 12 caracteres/);
  expect(salida).toMatch(/Listo: se creó el administrador/);
  expect(salida).not.toContain(FUERTE);
  expect(await existe(usuario)).toBe(true);
});

it('si la repetición no coincide, la vuelve a pedir', async () => {
  const usuario = `${RUN_ID}_b`;
  const { code, salida } = await crearAdmin([usuario, 'admin'], [FUERTE, 'otra-cosa-distinta', FUERTE, FUERTE]);
  expect(code).toBe(0);
  expect(salida).toMatch(/Las contraseñas no coinciden/);
  expect(await existe(usuario)).toBe(true);
});

it('después de tres contraseñas débiles, termina con error y no crea nada', async () => {
  const usuario = `${RUN_ID}_c`;
  const { code, salida } = await crearAdmin([usuario, 'admin'], ['Admin2026!', `${usuario}#Xy9!`, 'P@ssw0rd1234', FUERTE, FUERTE]);
  expect(code).toBe(1);
  expect(salida).toMatch(/contiene el nombre de usuario/);
  expect(salida).toMatch(/no se creó el administrador: 3 intentos sin una contraseña segura/);
  expect(await existe(usuario)).toBe(false);
});

it('sin entrada (por ejemplo, sin terminal), no crea nada', async () => {
  const usuario = `${RUN_ID}_d`;
  const { code, salida } = await crearAdmin([usuario, 'admin'], []);
  expect(code).toBe(1);
  expect(salida).toMatch(/no se recibió ninguna contraseña/);
  expect(await existe(usuario)).toBe(false);
});

describe('cambiarContrasena.js', () => {
  const usuario = `${RUN_ID}_e`;
  const hashDe = async () => (await pool.query('SELECT password_hash FROM admins WHERE username = $1', [usuario])).rows[0].password_hash;

  beforeAll(async () => {
    // Una cuenta con una contraseña débil, como las creadas antes de la política.
    await pool.query("INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'admin')", [usuario, await bcrypt.hash('1234567890', 4)]);
  });

  it('reemplaza la contraseña débil por una segura, después de rechazar otra débil', async () => {
    const { code, salida } = await cambiarContrasena([usuario], ['Admin2026!', FUERTE, FUERTE]);
    expect(code).toBe(0);
    expect(salida).toMatch(/La contraseña no es segura/);
    expect(salida).toMatch(`Listo: se cambió la contraseña de "${usuario}"`);
    expect(await bcrypt.compare(FUERTE, await hashDe())).toBe(true);
    const { rows } = await pool.query("SELECT metadata FROM audit_log WHERE event_type = 'ADMIN_PASSWORD_CHANGED' AND metadata ->> 'username' = $1", [usuario]);
    expect(rows).toHaveLength(1);
  });

  it('con un usuario que no existe, o sin contraseña segura, no cambia nada', async () => {
    expect((await cambiarContrasena([`${RUN_ID}_nadie`], [FUERTE, FUERTE])).salida).toMatch(/no existe el usuario/);
    const antes = await hashDe();
    const { code, salida } = await cambiarContrasena([usuario], ['corta', 'Admin2026!', 'qwerty123ABC!']);
    expect(code).toBe(1);
    expect(salida).toMatch(/no se cambió la contraseña: 3 intentos/);
    expect(await hashDe()).toBe(antes);
  });
});

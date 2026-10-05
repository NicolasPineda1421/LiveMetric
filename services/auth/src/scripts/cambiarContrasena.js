// Cambia la contraseña de una cuenta del panel (administrador, auditor o
// jurado) desde la línea de comandos: para reemplazar una contraseña débil
// o perdida. Quien puede correrlo ya controla la instalación (necesita
// entrar al contenedor de auth), igual que con crearAdmin.js.
//
// Uso, con el stack levantado y desde la raíz del repo:
//   docker compose exec auth-service node src/scripts/cambiarContrasena.js [usuario]
// Con el contenedor global, lo mismo con:
//   ./scripts/contenedor.sh admin [usuario]
// Sin usuario, muestra las cuentas y pregunta cuál (si hay un solo
// administrador, lo propone). Si todavía no hay ningún administrador, crea
// el primero, con crearAdmin.js.
//
// Misma política y mismos reintentos que crearAdmin.js; la contraseña se
// pide sin mostrarla y dos veces, y el cambio queda en la auditoría.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '..', '.env') });
const path = require('path');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { recordAuditEvent } = require('../audit');
const { createHiddenPrompter, pedirContrasenaSegura, INTENTOS } = require('./terminal');

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const ROLES = { admin: 'administrador', auditor: 'auditor', jurado: 'jurado' };

// Sin usuario en la línea de comandos: muestra las cuentas (rows) y
// pregunta cuál. Devuelve el usuario elegido, que existe.
async function elegirCuenta(prompter, rows) {
  const admins = rows.filter((r) => r.role === 'admin');
  console.log('Cuentas del panel:');
  for (const r of rows) console.log(`  ${r.username} (${Object.hasOwn(ROLES, r.role) ? ROLES[r.role] : r.role})`);
  const propuesto = admins.length === 1 ? admins[0].username : '';
  for (let intento = 1; intento <= INTENTOS; intento += 1) {
    const respuesta = await prompter.ask(
      propuesto ? `¿A qué cuenta le cambias la contraseña? [${propuesto}]: ` : '¿A qué cuenta le cambias la contraseña?: ',
      { hidden: false }
    );
    if (typeof respuesta !== 'string') fail('no se recibió ningún usuario.');
    const elegido = respuesta.trim() || propuesto;
    if (rows.some((r) => r.username === elegido)) return elegido;
    console.error(`  No hay ninguna cuenta "${elegido}". Escribe uno de los usuarios de la lista.`);
  }
  return fail(`no se cambió ninguna contraseña: ${INTENTOS} intentos sin un usuario de la lista.`);
}

(async () => {
  let username = (process.argv[2] || '').trim();
  const cuentas = await pool.query(
    `SELECT username, role FROM admins ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'auditor' THEN 1 ELSE 2 END, username`
  );
  if (!username && !cuentas.rows.some((r) => r.role === 'admin')) {
    // Todavía no hay administrador: lo que hace falta es crear el primero.
    // (El lector de la terminal todavía no se creó: lo que se escriba es
    // para crearAdmin.js.)
    await pool.end();
    console.log('Esta instalación todavía no tiene ningún administrador: se crea el primero.');
    const crear = spawnSync(process.execPath, [path.join(__dirname, 'crearAdmin.js'), '--si-no-hay'], { stdio: 'inherit' });
    process.exit(crear.status ?? 1);
  }
  const prompter = createHiddenPrompter();
  if (!username) username = await elegirCuenta(prompter, cuentas.rows);
  const { rows } = await pool.query('SELECT id, role FROM admins WHERE username = $1', [username]);
  if (rows.length === 0) fail(`no existe el usuario "${username}".`);

  const aceptada = await pedirContrasenaSegura(prompter, username, fail);
  prompter.close();
  if (aceptada === null) fail(`no se cambió la contraseña: ${INTENTOS} intentos sin una contraseña segura.`);

  try {
    await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(aceptada, 12), rows[0].id]);
    await recordAuditEvent({
      eventType: 'ADMIN_PASSWORD_CHANGED',
      actorType: 'system',
      actorRef: 'cambiarContrasena.js',
      metadata: { username, role: rows[0].role, via: 'script' },
    });
    console.log(`Listo: se cambió la contraseña de "${username}".`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error('Falló el script:', err.message);
  process.exit(1);
});

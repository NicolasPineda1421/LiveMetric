// Cambia la contraseña de una cuenta del panel (administrador, auditor o
// jurado) desde la línea de comandos: para reemplazar una contraseña débil
// o perdida. Quien puede correrlo ya controla la instalación (necesita
// entrar al contenedor de auth), igual que con crearAdmin.js.
//
// Uso, con el stack levantado y desde la raíz del repo:
//   docker compose exec auth-service node src/scripts/cambiarContrasena.js <usuario>
// Con el contenedor global:
//   docker exec -it livemetric-global docker compose exec auth-service node src/scripts/cambiarContrasena.js <usuario>
//
// Misma política y mismos reintentos que crearAdmin.js; la contraseña se
// pide sin mostrarla y dos veces, y el cambio queda en la auditoría.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '..', '.env') });
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { recordAuditEvent } = require('../audit');
const { createHiddenPrompter, pedirContrasenaSegura, INTENTOS } = require('./terminal');

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

(async () => {
  const username = (process.argv[2] || '').trim();
  if (!username) fail('indica el usuario: cambiarContrasena.js <usuario>');
  const { rows } = await pool.query('SELECT id, role FROM admins WHERE username = $1', [username]);
  if (rows.length === 0) fail(`no existe el usuario "${username}".`);

  const prompter = createHiddenPrompter();
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

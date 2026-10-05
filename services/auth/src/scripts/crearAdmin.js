// Crea un administrador (o auditor) desde la línea de comandos. Es la forma
// de crear el PRIMERO en una base nueva: db/init.sql no trae ningún
// administrador ni ninguna credencial. Los siguientes se pueden crear desde
// la pestaña "Usuarios" del panel.
//
// Uso, con el stack levantado y desde la raíz del repo:
//   docker compose run --rm auth-service node src/scripts/crearAdmin.js <usuario> [admin|auditor]
//   docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay
// Con --si-no-hay no hace nada si ya existe algún administrador, y si no,
// pide también el usuario: es lo que ofrecen start.sh, start.bat y
// contenedor.sh al terminar de levantar una instalación nueva.
//
// La contraseña se pide por teclado, sin mostrarla, y dos veces: nunca pasa
// por la línea de comandos, el historial de la shell ni ningún archivo.
// Misma política que POST /admin/users (../politicaContrasena.js): usuario
// de 3 a 50 caracteres y una contraseña que no sea fácil de adivinar; bcrypt
// con costo 12, y queda en la auditoría. Si el usuario o la contraseña no
// sirven, dice por qué y los vuelve a pedir, hasta INTENTOS veces: un
// arranque no termina con una contraseña débil ni sin administrador por un
// error de tipeo.
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
  const args = process.argv.slice(2);
  const onlyIfNone = args[0] === '--si-no-hay';
  const prompter = createHiddenPrompter();

  let [username = '', role = 'admin'] = onlyIfNone ? [] : args;
  if (onlyIfNone) {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM admins WHERE role = 'admin'");
    if (rows[0].n > 0) {
      console.log(`Ya hay ${rows[0].n} administrador(es): no hace falta crear uno.`);
      prompter.close();
      await pool.end();
      return;
    }
    console.log('Esta instalación todavía no tiene ningún administrador: creemos el primero.');
  }
  if (!['admin', 'auditor'].includes(role)) fail('el rol debe ser "admin" o "auditor".');

  // Usuario: en --si-no-hay se pide acá; por argumento, solo se valida.
  for (let intento = 1; (username || '').trim().length < 3 || username.trim().length > 50; intento += 1) {
    if (!onlyIfNone || intento > INTENTOS) {
      fail('indica un nombre de usuario de 3 a 50 caracteres: crearAdmin.js <usuario> [admin|auditor]');
    }
    if (intento > 1) console.error('  El usuario debe tener de 3 a 50 caracteres.');
    username = await prompter.ask('Usuario (3 a 50 caracteres): ', { hidden: false });
    if (typeof username !== 'string') fail('no se recibió ningún usuario: no se creó el administrador.');
  }
  username = username.trim();

  const aceptada = await pedirContrasenaSegura(prompter, username, fail);
  prompter.close();
  if (aceptada === null) fail(`no se creó el administrador: ${INTENTOS} intentos sin una contraseña segura.`);

  try {
    const created = await pool.query(
      'INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [username, await bcrypt.hash(aceptada, 12), role],
    );
    await recordAuditEvent({
      eventType: 'ADMIN_USER_CREATED',
      actorType: 'system',
      actorRef: 'crearAdmin.js',
      metadata: { newAdminUsername: username, role, via: 'script' },
    });
    console.log(`Listo: se creó el ${role === 'auditor' ? 'auditor' : 'administrador'} "${username}" (id ${created.rows[0].id}).`);
  } catch (err) {
    if (err.code === '23505') fail(`ya existe un usuario "${username}".`);
    throw err;
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error('Falló el script:', err.message);
  process.exit(1);
});

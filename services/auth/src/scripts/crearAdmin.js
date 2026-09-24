// Crea un administrador (o auditor) desde la línea de comandos. Es la forma
// de crear el PRIMERO en una base nueva: db/init.sql no trae ningún
// administrador ni ninguna credencial. Los siguientes se pueden crear desde
// la pestaña "Usuarios" del panel.
//
// Uso, con el stack levantado y desde la raíz del repo:
//   docker compose run --rm auth-service node src/scripts/crearAdmin.js <usuario> [admin|auditor]
//
// La contraseña se pide por teclado, sin mostrarla, y dos veces: nunca pasa
// por la línea de comandos, el historial de la shell ni ningún archivo.
// Misma política que POST /admin/users: usuario de 3 a 50 caracteres,
// contraseña de 10 a 128, bcrypt con costo 12, y queda en la auditoría.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '..', '.env') });
const readline = require('readline');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { recordAuditEvent } = require('../audit');

// Lee respuestas sin hacer eco de lo que se escribe. Un único lector con
// cola de líneas (y no un readline por pregunta): si la entrada llega por
// tubería, las dos líneas llegan juntas y un segundo lector perdería la
// que ya consumió el primero.
function createHiddenPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let muted = false;
  rl._writeToOutput = (text) => {
    if (!muted) rl.output.write(text);
  };
  const received = [];
  const waiting = [];
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : received.push(line)));
  rl.on('close', () => waiting.splice(0).forEach((deliver) => deliver(null)));
  return {
    ask(question) {
      process.stdout.write(question);
      muted = true;
      return new Promise((resolve) => {
        const deliver = (line) => {
          muted = false;
          process.stdout.write('\n');
          resolve(line);
        };
        if (received.length) deliver(received.shift());
        else waiting.push(deliver);
      });
    },
    close: () => rl.close(),
  };
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

(async () => {
  const [username = '', role = 'admin'] = process.argv.slice(2);
  if (username.trim().length < 3 || username.trim().length > 50) {
    fail('indica un nombre de usuario de 3 a 50 caracteres: crearAdmin.js <usuario> [admin|auditor]');
  }
  if (!['admin', 'auditor'].includes(role)) fail('el rol debe ser "admin" o "auditor".');

  const prompter = createHiddenPrompter();
  const password = await prompter.ask(`Contraseña para "${username.trim()}" (mínimo 10 caracteres): `);
  if (password === null) fail('no se recibió ninguna contraseña.');
  if (password.length < 10 || password.length > 128) fail('la contraseña debe tener entre 10 y 128 caracteres.');
  if ((await prompter.ask('Repítela: ')) !== password) fail('las contraseñas no coinciden.');
  prompter.close();

  try {
    const created = await pool.query(
      'INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [username.trim(), await bcrypt.hash(password, 12), role],
    );
    await recordAuditEvent({
      eventType: 'ADMIN_USER_CREATED',
      actorType: 'system',
      actorRef: 'crearAdmin.js',
      metadata: { newAdminUsername: username.trim(), role, via: 'script' },
    });
    console.log(`Listo: se creó el ${role === 'auditor' ? 'auditor' : 'administrador'} "${username.trim()}" (id ${created.rows[0].id}).`);
  } catch (err) {
    if (err.code === '23505') fail(`ya existe un usuario "${username.trim()}".`);
    throw err;
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error('Falló el script:', err.message);
  process.exit(1);
});

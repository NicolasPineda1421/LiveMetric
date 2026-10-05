// Lo que comparten los scripts que piden una contraseña en la terminal
// (crearAdmin.js y cambiarContrasena.js): leerla sin mostrarla, y pedir una
// que cumpla la política (../politicaContrasena.js), con reintentos.
const crypto = require('crypto');
const readline = require('readline');
const { evaluarContrasena, mensajeContrasenaDebil, MINIMO_CONTRASENA } = require('../politicaContrasena');

const INTENTOS = 3;

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
    ask(question, { hidden = true } = {}) {
      process.stdout.write(question);
      muted = hidden;
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

// Compara en tiempo constante. Aquí nadie puede medir tiempos (es la misma
// persona escribiendo dos veces en su terminal), pero es la forma correcta
// de comparar secretos y no cuesta nada.
function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Pide la contraseña y su repetición hasta que una cumpla la política y
// coincidan, a lo sumo INTENTOS veces, diciendo cada vez por qué no sirvió.
// Devuelve la contraseña aceptada, o null si se agotaron los intentos. Sin
// entrada (sin terminal, o se cortó), llama a fail con el motivo.
async function pedirContrasenaSegura(prompter, username, fail) {
  console.log(
    `La contraseña necesita al menos ${MINIMO_CONTRASENA} caracteres con tres tipos entre minúsculas, mayúsculas,\n` +
      'números y símbolos (o una frase de 16 caracteres o más), y no puede ser común, tener secuencias\n' +
      'como 123456 o qwerty, ni contener el usuario.'
  );
  for (let intento = 1; intento <= INTENTOS; intento += 1) {
    const propuesta = await prompter.ask(`Contraseña para "${username}": `);
    if (typeof propuesta !== 'string') fail('no se recibió ninguna contraseña.');
    const problemas = evaluarContrasena(propuesta, { username });
    if (problemas.length > 0) {
      console.error(`  ${mensajeContrasenaDebil(problemas)}`);
      continue;
    }
    const repetida = await prompter.ask('Repítela: ');
    if (typeof repetida !== 'string') fail('no se recibió la contraseña repetida.');
    if (!sameSecret(repetida, propuesta)) {
      console.error('  Las contraseñas no coinciden.');
      continue;
    }
    return propuesta;
  }
  return null;
}

module.exports = { createHiddenPrompter, pedirContrasenaSegura, INTENTOS };

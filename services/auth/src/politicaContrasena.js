// Política de contraseñas de las cuentas del panel (administrador, auditor y
// jurado). La aplican el primer administrador que crean los scripts de
// arranque (scripts/crearAdmin.js) y la pestaña Usuarios (POST /admin/users).
//
// El administrador entra solo con su contraseña, así que no alcanza con el
// largo: "1234567890" o "Admin2026!" cumplían los 10 caracteres de antes. Se
// pide:
//   - de 12 a 128 caracteres;
//   - al menos tres tipos entre minúsculas, mayúsculas, números y símbolos,
//     o una frase de 16 caracteres o más con al menos dos tipos;
//   - que no sea una contraseña común, ni una palabra común con números o
//     símbolos alrededor ("P@ssw0rd123", "Livemetric2026!");
//   - que no tenga secuencias fáciles (123456, abcdef, qwerty) ni un mismo
//     carácter repetido cuatro veces;
//   - que no contenga el nombre de usuario.
// Devuelve la lista de problemas en español; vacía, si la contraseña sirve.
const MINIMO = 12;
const MAXIMO = 128;
const FRASE = 16;

// Contraseñas y palabras base muy usadas (en minúsculas, sin tildes). Una
// palabra de esta lista con solo números o símbolos alrededor no sirve.
const COMUNES = new Set([
  'password', 'passw', 'pass', 'contrasena', 'contrasenia', 'clave', 'secreto', 'secreta',
  'admin', 'administrador', 'administrator', 'root', 'usuario', 'user', 'login', 'acceso',
  'livemetric', 'votacion', 'votaciones', 'elecciones', 'eleccion', 'voto', 'escrutinio',
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'abc', 'abcd', 'test', 'prueba',
  'welcome', 'bienvenido', 'bienvenida', 'hola', 'holamundo', 'iloveyou', 'teamo', 'love', 'amor',
  'colombia', 'bogota', 'uniminuto', 'universidad', 'monkey', 'dragon', 'master', 'shadow',
  'sunshine', 'princess', 'football', 'futbol', 'baseball', 'letmein', 'trustno1', 'superman',
  'batman', 'starwars', 'changeme', 'cambiame', 'default', 'temporal', 'nueva', 'nuevo',
]);

// Lo que la gente cambia por letras ("P@ssw0rd" = "password").
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i' };

const sinTildes = (texto) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function clasesDeCaracteres(password) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(sinTildes(password))).length;
}

// La palabra que queda al sacar números y símbolos de los bordes, y esa
// misma sin "leet": "#Admin2026!" -> "admin"; "P@ssw0rd1234" -> "p@ssw0rd"
// -> "password". También es común si no tiene ni una letra ("1234567890").
const sinBordes = (texto) => texto.replace(/^[^a-z]+|[^a-z]+$/g, '');
const desLeet = (texto) => [...texto].map((c) => (Object.hasOwn(LEET, c) ? LEET[c] : c)).join(''); // eslint-disable-line security/detect-object-injection -- la clave se comprobó con Object.hasOwn

function esComun(password) {
  const base = sinTildes(password).toLowerCase();
  if (!/[a-z]/.test(base)) return true;
  return [base, sinBordes(base), desLeet(sinBordes(base)), sinBordes(desLeet(base))].some((c) => COMUNES.has(c));
}

const FILAS_TECLADO = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

// Seis o más caracteres seguidos en orden (abcdef, 123456, 987654) o de una
// fila del teclado (qwerty, asdfgh), o un mismo carácter cuatro veces seguidas.
function tieneSecuencia(password) {
  const t = sinTildes(password).toLowerCase();
  if (/(.)\1{3}/.test(t)) return true;
  let subida = 1;
  let bajada = 1;
  for (let i = 1; i < t.length; i += 1) {
    const paso = t.charCodeAt(i) - t.charCodeAt(i - 1);
    subida = paso === 1 ? subida + 1 : 1;
    bajada = paso === -1 ? bajada + 1 : 1;
    if (subida >= 6 || bajada >= 6) return true;
  }
  return FILAS_TECLADO.some((fila) => {
    const atras = [...fila].reverse().join('');
    for (let i = 0; i + 6 <= fila.length; i += 1) {
      if (t.includes(fila.slice(i, i + 6)) || t.includes(atras.slice(i, i + 6))) return true;
    }
    return false;
  });
}

function evaluarContrasena(password, { username = '' } = {}) {
  if (typeof password !== 'string' || password.length === 0) return ['escribe una contraseña'];
  const problemas = [];
  if (password.length < MINIMO) problemas.push(`tiene menos de ${MINIMO} caracteres`);
  if (password.length > MAXIMO) problemas.push(`tiene más de ${MAXIMO} caracteres`);
  const clases = clasesDeCaracteres(password);
  if (password.length < FRASE ? clases < 3 : clases < 2) {
    problemas.push(
      'combina al menos tres de estos: minúsculas, mayúsculas, números y símbolos ' +
        `(o usa una frase de ${FRASE} caracteres o más)`
    );
  }
  if (esComun(password)) problemas.push('es una contraseña común, o una palabra común con números o símbolos');
  if (tieneSecuencia(password)) problemas.push('tiene una secuencia fácil de adivinar (como 123456, abcdef o qwerty) o un carácter repetido');
  const usuario = sinTildes(String(username).trim()).toLowerCase();
  if (usuario.length >= 3 && sinTildes(password).toLowerCase().includes(usuario)) {
    problemas.push('contiene el nombre de usuario');
  }
  return problemas;
}

// Un solo mensaje, para la API y la terminal.
function mensajeContrasenaDebil(problemas) {
  return `La contraseña no es segura: ${problemas.join('; ')}.`;
}

module.exports = { evaluarContrasena, mensajeContrasenaDebil, MINIMO_CONTRASENA: MINIMO, MAXIMO_CONTRASENA: MAXIMO };

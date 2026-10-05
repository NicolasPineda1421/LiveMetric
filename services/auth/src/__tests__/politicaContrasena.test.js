// Política de contraseñas de las cuentas del panel (politicaContrasena.js).
const { evaluarContrasena, mensajeContrasenaDebil } = require('../politicaContrasena');

const evaluar = (password, username) => evaluarContrasena(password, { username });

describe('Contraseñas que no sirven', () => {
  it.each([
    ['1234567890', 'secuencia, sin letras'],
    ['Admin2026!', 'corta y una palabra común con números'],
    ['corto1A!', 'menos de 12 caracteres'],
    ['P@ssw0rd1234', '"password" con letras cambiadas por números'],
    ['Livemetric2026!', 'el nombre del sistema con números'],
    ['#Uniminuto2026', 'una palabra común con números y símbolos alrededor'],
    ['qwerty123ABC!', 'una fila del teclado'],
    ['Zx-abcdefgh-9', 'letras en orden'],
    ['aaaaBBBB1111!!', 'un carácter repetido'],
    ['solominusculaslarga', 'un solo tipo de carácter, aunque sea larga'],
  ])('%s (%s)', (password) => {
    expect(evaluar(password)).not.toEqual([]);
  });

  it('una que contiene el nombre de usuario, sin importar mayúsculas ni tildes', () => {
    expect(evaluar('NicolasPineda#2026', 'nicolás')).toContain('contiene el nombre de usuario');
    expect(evaluar('NicolasPineda#2026', 'ana')).toEqual([]);
  });

  it('dice todos los motivos, en un mensaje', () => {
    const problemas = evaluar('1234567890');
    expect(problemas).toEqual(expect.arrayContaining(['tiene menos de 12 caracteres']));
    expect(problemas.length).toBeGreaterThanOrEqual(3);
    expect(mensajeContrasenaDebil(['uno', 'dos'])).toBe('La contraseña no es segura: uno; dos.');
  });

  it('una vacía, o que no es texto', () => {
    expect(evaluar('')).toEqual(['escribe una contraseña']);
    expect(evaluar(undefined)).toEqual(['escribe una contraseña']);
    expect(evaluar('x'.repeat(129))).toContain('tiene más de 128 caracteres');
  });
});

describe('Contraseñas que sirven', () => {
  it.each([
    ['k7#Pq2!mZ9vL', 'tres tipos, sin palabras ni secuencias'],
    ['Tr4v3s1a-Gr1s!', 'palabras no comunes con números y símbolos'],
    ['Ventana-Roja-Lago', 'frase de 16 caracteres o más con dos tipos'],
    ['esta es mi frase larga 2026', 'frase con espacios y números'],
  ])('%s (%s)', (password) => {
    expect(evaluar(password, 'admin')).toEqual([]);
  });
});

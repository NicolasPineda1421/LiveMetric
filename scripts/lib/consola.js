// LiveMetric - Presentacion en consola compartida por los scripts Node de
// scripts/lib (pipeline-resumen.js y esperar-contenedores.js): colores,
// simbolos de estado y utilidades de texto, iguales en Linux y en Windows.

'use strict';

const TTY = Boolean(process.stdout.isTTY);
const CON_COLOR = TTY && !process.env.NO_COLOR;
const pintar = (codigo) => (texto) => (CON_COLOR ? `\x1b[${codigo}m${texto}\x1b[0m` : texto);

// La consola clasica de Windows (conhost, la de cmd.exe fuera de Windows
// Terminal) no tiene glifos para ✔/✘/⚠ y muestra cuadraditos; √ y × si
// estan en sus fuentes.
const CONSOLA_CLASICA = process.platform === 'win32' && !process.env.WT_SESSION;
const SIMBOLO = CONSOLA_CLASICA
  ? { ok: '√', aviso: '!', falla: '×', omitido: '-', paso: '>', espera: 'o' }
  : { ok: '✔', aviso: '⚠', falla: '✘', omitido: '○', paso: '▸', espera: '◌' };
const CUADROS_SPINNER = CONSOLA_CLASICA ? ['|', '/', '-', '\\'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const verde = pintar('32');
const rojo = pintar('31');
const amarillo = pintar('33');
const azul = pintar('34');
const gris = pintar('2');
const negrita = pintar('1');
const COLOR_ESTADO = { ok: verde, aviso: amarillo, falla: rojo, omitido: gris };

const ANCHO = Math.max(60, (process.stdout.columns || 100) - 2);

const escribir = (linea = '') => process.stdout.write(`${linea}\n`);
const rellenar = (texto, ancho) => (texto.length >= ancho ? `${texto} ` : texto.padEnd(ancho));
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const duracion = (segundos) =>
  segundos < 60 ? `${segundos} s` : `${Math.floor(segundos / 60)} min${segundos % 60 ? ` ${segundos % 60} s` : ''}`;

module.exports = {
  TTY,
  SIMBOLO,
  CUADROS_SPINNER,
  COLOR_ESTADO,
  ANCHO,
  verde,
  rojo,
  amarillo,
  azul,
  gris,
  negrita,
  escribir,
  rellenar,
  plural,
  duracion,
};

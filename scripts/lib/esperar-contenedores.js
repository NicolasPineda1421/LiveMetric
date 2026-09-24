#!/usr/bin/env node
// LiveMetric - Espera a que TODOS los contenedores del stack (los de
// "docker compose ps") esten sanos, mostrando el estado de cada uno en vivo.
// Lo usan scripts/start.sh y scripts/start.bat despues de "docker compose
// up -d": sin esto, el script terminaba con los contenedores todavia en
// "health: starting" y no se sabia si iban a quedar bien.
//
// "Sano" es: corriendo y con su healthcheck en "healthy" (o corriendo, si
// la imagen no define healthcheck, como el proxy "postgres").
//
// No hay limite de tiempo mientras los contenedores sigan arrancando. Solo
// se deja de esperar si alguno queda en un estado de falla (unhealthy,
// reiniciandose en bucle o detenido) durante mas de FALLA_MAX_SEGUNDOS
// seguidos: eso no se arregla esperando. En ese caso muestra por que (la
// salida de su ultimo healthcheck, o sus ultimas lineas de log) y termina
// con codigo 1.
//
// Uso (desde la raiz del repo): node scripts/lib/esperar-contenedores.js

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const {
  TTY,
  SIMBOLO,
  CUADROS_SPINNER,
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
} = require('./consola');

const FALLA_MAX_SEGUNDOS = 180;
const CONSULTA_CADA_MS = 1500;
const DIBUJO_CADA_MS = 150;
const ERRORES_DOCKER_MAX = 10;

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Estado de cada contenedor, clasificado en: listo | arrancando | falla.
function consultar() {
  const ids = docker(['compose', 'ps', '-a', '-q']).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  return JSON.parse(docker(['inspect', ...ids]))
    .map((c) => {
      const estado = c.State;
      const salud = estado.Health && estado.Health.Status;
      const checks = (estado.Health && estado.Health.Log) || [];
      let tipo;
      let texto;
      if (estado.Status === 'running' && (!salud || salud === 'healthy')) {
        tipo = 'listo';
        texto = salud ? 'sano (healthy)' : 'en marcha (no define healthcheck)';
      } else if (estado.Status === 'running' && salud === 'starting') {
        tipo = 'arrancando';
        texto = 'arrancando (health: starting)';
      } else if (estado.Status === 'running') {
        tipo = 'falla';
        texto = 'unhealthy: su healthcheck falla';
      } else if (estado.Status === 'created') {
        tipo = 'arrancando';
        texto = 'creado, todavía no arrancó';
      } else if (estado.Status === 'restarting') {
        tipo = 'falla';
        texto = `reiniciándose en bucle (salió con código ${estado.ExitCode})`;
      } else {
        tipo = 'falla';
        texto = `detenido (${estado.Status}, código de salida ${estado.ExitCode})`;
      }
      return {
        nombre: c.Name.replace(/^\//, ''),
        tipo,
        texto,
        ultimoCheck: checks.length ? checks[checks.length - 1].Output : '',
      };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

const MARCA = {
  listo: () => verde(SIMBOLO.ok),
  arrancando: () => amarillo(SIMBOLO.espera),
  falla: () => rojo(SIMBOLO.falla),
};
const COLOR_TEXTO = { listo: (t) => t, arrancando: amarillo, falla: rojo };

function lineasDeEstado(contenedores) {
  const ancho = Math.max(...contenedores.map((c) => c.nombre.length)) + 3;
  return contenedores.map((c) => `     ${MARCA[c.tipo]()} ${rellenar(c.nombre, ancho)}${COLOR_TEXTO[c.tipo](c.texto)}`);
}

// En una terminal el bloque se redibuja en el mismo lugar; redirigido a un
// archivo, solo se escribe cuando algo cambia.
let lineasDibujadas = 0;
let ultimoDibujo = '';
function dibujar(lineas) {
  const texto = lineas.join('\n');
  if (TTY) {
    if (lineasDibujadas) process.stdout.write(`\x1b[${lineasDibujadas}F\x1b[J`);
    process.stdout.write(`${texto}\n`);
    lineasDibujadas = lineas.length;
  } else if (texto !== ultimoDibujo) {
    process.stdout.write(`${texto}\n`);
  }
  ultimoDibujo = texto;
}

function motivoDeFalla(c) {
  let motivo = c.ultimoCheck.trim();
  if (!motivo) {
    // "docker logs" devuelve por stderr lo que el contenedor escribio en su
    // stderr (donde van casi todos los errores): hay que leer los dos.
    const r = spawnSync('docker', ['logs', '--tail', '8', c.nombre], { encoding: 'utf8' });
    motivo = `${r.stdout || ''}${r.stderr || ''}`;
  }
  // Un contenedor que se reinicia en bucle repite el mismo error en cada
  // vuelta: alcanza con verlo una vez.
  return [...new Set(motivo.split('\n').map((l) => l.trim()).filter(Boolean))].slice(-8);
}

const inicio = Date.now();
const fallandoDesde = new Map();
let contenedores = null;
let erroresDocker = 0;
let cuadro = 0;

function segundos() {
  return Math.round((Date.now() - inicio) / 1000);
}

function terminar(codigo, lineasFinales) {
  clearInterval(temporizadorConsulta);
  clearInterval(temporizadorDibujo);
  dibujar(lineasFinales);
  process.exitCode = codigo;
}

function actualizar() {
  try {
    contenedores = consultar();
    erroresDocker = 0;
  } catch (e) {
    erroresDocker += 1;
    if (erroresDocker >= ERRORES_DOCKER_MAX) {
      terminar(1, [`   ${rojo(`${SIMBOLO.falla} No se pudo consultar el estado de los contenedores:`)}`, `     ${gris(String(e.stderr || e.message).trim())}`]);
    }
    return;
  }

  if (!contenedores.length) {
    terminar(1, [`   ${rojo(`${SIMBOLO.falla} docker compose no tiene ningún contenedor creado.`)}`]);
    return;
  }

  const ahora = Date.now();
  for (const c of contenedores) {
    if (c.tipo !== 'falla') fallandoDesde.delete(c.nombre);
    else if (!fallandoDesde.has(c.nombre)) fallandoDesde.set(c.nombre, ahora);
  }

  const listos = contenedores.filter((c) => c.tipo === 'listo').length;
  if (listos === contenedores.length) {
    terminar(0, [
      `   ${verde(negrita(`${SIMBOLO.ok} Los ${contenedores.length} contenedores están sanos`))} ${gris(`(tardaron ${duracion(segundos())})`)}`,
      ...lineasDeEstado(contenedores),
    ]);
    return;
  }

  const rendidos = contenedores.filter(
    (c) => fallandoDesde.has(c.nombre) && ahora - fallandoDesde.get(c.nombre) >= FALLA_MAX_SEGUNDOS * 1000,
  );
  if (rendidos.length) {
    // Se explica cada contenedor en falla, no solo los que ya superaron el
    // limite: suele ser la misma causa (ej. la base no responde).
    const enFalla = contenedores.filter((c) => c.tipo === 'falla');
    const lineas = [
      `   ${rojo(negrita(`${SIMBOLO.falla} ${plural(enFalla.length, 'contenedor no queda sano', 'contenedores no quedan sanos')}`))} ${gris(`(se esperó ${duracion(FALLA_MAX_SEGUNDOS)} seguidos en falla)`)}`,
      ...lineasDeEstado(contenedores),
    ];
    for (const c of enFalla) {
      lineas.push('', `     ${rojo(c.nombre)} ${gris('— por qué:')}`);
      for (const l of motivoDeFalla(c)) lineas.push(`       ${gris(l)}`);
      lineas.push(`       ${gris(`→ Log completo: docker logs ${c.nombre}`)}`);
    }
    terminar(1, lineas);
  }
}

function lineasEnCurso() {
  if (!contenedores) return [`   ${azul(CUADROS_SPINNER[cuadro % CUADROS_SPINNER.length])} Consultando el estado de los contenedores...`];
  const listos = contenedores.filter((c) => c.tipo === 'listo').length;
  const encabezado = `   ${azul(CUADROS_SPINNER[cuadro % CUADROS_SPINNER.length])} Esperando a que todos estén sanos: ${negrita(`${listos}/${contenedores.length}`)} listos ${gris(`(${duracion(segundos())})`)}`;
  // Redirigido a un archivo, el encabezado sin spinner ni segundos: si no,
  // "cambiaria" en cada consulta y se repetiria el bloque entero.
  return [TTY ? encabezado : `   Esperando a que todos estén sanos: ${listos}/${contenedores.length} listos`, ...lineasDeEstado(contenedores)];
}

const temporizadorConsulta = setInterval(actualizar, CONSULTA_CADA_MS);
const temporizadorDibujo = setInterval(() => {
  cuadro += 1;
  dibujar(lineasEnCurso());
}, TTY ? DIBUJO_CADA_MS : CONSULTA_CADA_MS);
actualizar();
if (process.exitCode === undefined) dibujar(lineasEnCurso());

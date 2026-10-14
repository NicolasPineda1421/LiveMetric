// LiveMetric - globalTeardown de Jest: borra el contenedor de la base
// desechable que levantó jest-db-setup.js para esta corrida de pruebas.

'use strict';

const { execFileSync } = require('child_process');

module.exports = async function detenerBaseDePruebas() {
  const nombre = process.env.LIVEMETRIC_DB_PRUEBAS;
  if (!nombre) return;
  try {
    // Con -v: los datos de Postgres van en un volumen anónimo (la imagen
    // declara VOLUME), y "docker rm -f" sin -v lo dejaba suelto en cada
    // corrida, una base entera por vez.
    execFileSync('docker', ['rm', '-f', '-v', nombre], { stdio: 'ignore' });
  } catch {
    // Si ya no existe (se corrió con --rm y se detuvo), no hay nada que borrar.
  }
};

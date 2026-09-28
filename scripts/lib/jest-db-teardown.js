// LiveMetric - globalTeardown de Jest: borra el contenedor de la base
// desechable que levantó jest-db-setup.js para esta corrida de pruebas.

'use strict';

const { execFileSync } = require('child_process');

module.exports = async function detenerBaseDePruebas() {
  const nombre = process.env.LIVEMETRIC_DB_PRUEBAS;
  if (!nombre) return;
  try {
    execFileSync('docker', ['rm', '-f', nombre], { stdio: 'ignore' });
  } catch {
    // Si ya no existe (se corrió con --rm y se detuvo), no hay nada que borrar.
  }
};

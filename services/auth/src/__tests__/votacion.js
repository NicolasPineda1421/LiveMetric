// Elecciones a medida para las pruebas de auth (por ejemplo, la fecha que se
// propone para el vencimiento del PIN es el cierre de la última elección
// programada): se abren con esto y se borran al terminar.
const pool = require('../db');

async function abrirVotacion(titulo, { desdeMin = -60, hastaMin = 120, status = 'active' } = {}) {
  const r = await pool.query(
    `INSERT INTO elections (title, status, scheduled_start, scheduled_end)
     VALUES ($1, $2, now() + make_interval(mins => $3), now() + make_interval(mins => $4)) RETURNING id`,
    [titulo, status, desdeMin, hastaMin]
  );
  return r.rows[0].id;
}

async function cerrarVotacion(id) {
  await pool.query('DELETE FROM elections WHERE id = $1', [id]);
}

module.exports = { abrirVotacion, cerrarVotacion };

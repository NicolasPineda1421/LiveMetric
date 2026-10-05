// Elecciones a medida para las pruebas de auth (por ejemplo, para ver que el
// PIN sirve haya o no una votación, y que su vencimiento no depende de
// ella): se abren con esto y se borran al terminar.
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

// Mesas de votación: crearlas, renombrarlas y eliminarlas desde la pestaña
// "Puestos" (rutas /admin/mesas en app.js).
//
// Una mesa existe en el padrón cuando algún votante la tiene, escrita en su
// fila y cifrada como el puesto. Las que se crean aquí, todavía sin
// votantes, van en mesas_votacion (migración 010); lugaresDelPadron muestra
// las dos juntas. Las reglas:
//  - Crear: el puesto tiene que existir, y la mesa no (escrita de cualquier
//    forma: "1" y "Mesa 1" son la misma, ver lugares.js).
//  - Renombrar: cambia la mesa de sus votantes y de sus jurados, en una sola
//    transacción. No con una votación en curso: los votos guardan la mesa
//    con la que se emitieron, y el acta quedaría partida entre los dos
//    nombres. Los votos y las actas anteriores conservan el nombre de
//    entonces. No puede quedar igual a otra mesa del puesto: eso juntaría dos
//    mesas en una.
//  - Eliminar: solo una mesa sin votantes y sin jurados.
const { encryptField, decryptField } = require('./voterCrypto');
const { normalizarPuesto, normalizarMesa, mismoPuesto, mismaMesa } = require('./lugares');

// El puesto de "lugares" (de lugaresDelPadron) y su mesa, escritos de
// cualquier forma; mesa es undefined si el puesto no la tiene.
function buscarMesa(lugares, pollingPlace, votingTable) {
  const puesto = lugares.find((p) => mismoPuesto(p.pollingPlace, pollingPlace));
  return { puesto, mesa: puesto?.mesas.find((m) => mismaMesa(m.nombre, votingTable)) };
}

// ¿Hay alguna elección recibiendo votos? (Voting los acepta solo en las que
// están "active", dentro de su horario.)
async function hayVotacionEnCurso(pool) {
  const { rows } = await pool.query("SELECT 1 FROM elections WHERE status = 'active' LIMIT 1");
  return rows.length > 0;
}

// Los ids de los votantes (activos o no) y de los jurados con esta mesa de
// este puesto, escrita de cualquier forma.
async function quienesTienenLaMesa(client, pollingPlace, votingTable) {
  const [votantes, jurados] = await Promise.all([
    client.query('SELECT id, polling_place, voting_table FROM voters'),
    client.query("SELECT id, polling_place, voting_table FROM admins WHERE role = 'jurado' AND voting_table IS NOT NULL"),
  ]);
  const tiene = (fila) => mismoPuesto(decryptField(fila.polling_place), pollingPlace)
    && mismaMesa(decryptField(fila.voting_table), votingTable);
  return { votantes: votantes.rows.filter(tiene).map((f) => f.id), jurados: jurados.rows.filter(tiene).map((f) => f.id) };
}

// Renombra la mesa en una transacción: sus votantes, sus jurados y su fila
// de mesas_votacion, si la tiene. Devuelve cuántos votantes y jurados cambió.
async function renombrarMesa(pool, { pollingPlace, votingTable, nombre }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { votantes, jurados } = await quienesTienenLaMesa(client, pollingPlace, votingTable);
    const cifrada = encryptField(nombre);
    if (votantes.length > 0) await client.query('UPDATE voters SET voting_table = $1 WHERE id = ANY($2)', [cifrada, votantes]);
    if (jurados.length > 0) await client.query('UPDATE admins SET voting_table = $1 WHERE id = ANY($2)', [cifrada, jurados]);
    await client.query(
      'UPDATE mesas_votacion SET nombre = $1, clave = $2, updated_at = now() WHERE puesto_clave = $3 AND clave = $4',
      [nombre, normalizarMesa(nombre), normalizarPuesto(pollingPlace), normalizarMesa(votingTable)]
    );
    await client.query('COMMIT');
    return { votantes: votantes.length, jurados: jurados.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { buscarMesa, hayVotacionEnCurso, renombrarMesa };

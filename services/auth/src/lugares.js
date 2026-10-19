// Puesto y mesa de votación: se escriben a mano en el padrón, y al crear un
// jurado se eligen de él. Para no depender de cómo se escribieron, se
// comparan sin distinguir mayúsculas, tildes ni espacios de más, y "1",
// "Mesa 1" y "mesa  1" son la misma mesa. Un jurado sin mesa (null) es de
// todo su puesto.
const { decryptField } = require('./voterCrypto');

function normalizarPuesto(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// "Mesa 1", "mesa 1", "MESA N° 1", "Mesa No. 1", "Mesa #1" y "1" -> "1".
// "mesa" tiene que ser una palabra suelta: "Mesanorte" queda como está.
function normalizarMesa(texto) {
  const t = normalizarPuesto(texto);
  if (!/^mesa(?![a-z])/.test(t)) return t;
  return t
    .slice(4)
    .trim()
    .replace(/^(?:nro|no|n)(?=[\s.º°#\d])/, '')
    .replace(/^[\s.º°#]+/, '');
}

const mismoPuesto = (a, b) => normalizarPuesto(a) === normalizarPuesto(b);
const mismaMesa = (a, b) => normalizarMesa(a) === normalizarMesa(b);

// ¿El jurado { pollingPlace, votingTable } puede autorizar a este votante?
// Con votingTable null, el jurado es de todo el puesto.
function juradoCubre(jurado, votante) {
  if (!mismoPuesto(jurado.pollingPlace, votante.pollingPlace)) return false;
  return jurado.votingTable === null || jurado.votingTable === undefined || mismaMesa(jurado.votingTable, votante.votingTable);
}

const enOrden = (a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });

// La ubicación de un puesto, de su fila en puestos_votacion (migración 009).
const ubicacionDeFila = (fila) => ({
  id: fila.id,
  pais: fila.pais,
  codigoMunicipio: fila.codigo_municipio,
  departamento: fila.departamento,
  municipio: fila.municipio,
  localidad: fila.localidad,
  zona: fila.zona,
});

// Los puestos del padrón (votantes activos), cada uno con sus mesas tal
// como están escritas en él, cuántos votantes tiene y su ubicación (null si
// todavía no la tiene). Si el mismo puesto o mesa aparece escrito de dos
// formas, queda una sola. Las mesas creadas en "Puestos" (mesas_votacion,
// migración 010) se suman a las de su puesto, aunque todavía no tengan
// votantes. Con { todos: true } están también los puestos con ubicación que
// ya no tienen votantes.
//
// Cada puesto trae sus mesas dos veces: "votingTables", solo los nombres
// (para elegir una), y "mesas", con cuántos votantes tiene cada una.
async function lugaresDelPadron(pool, { todos = false } = {}) {
  const [padron, ubicaciones, registradas] = await Promise.all([
    pool.query('SELECT polling_place, voting_table, count(*)::int AS votantes FROM voters WHERE is_active GROUP BY polling_place, voting_table'),
    pool.query('SELECT * FROM puestos_votacion'),
    pool.query('SELECT puesto_clave, nombre, clave FROM mesas_votacion'),
  ]);
  const ubicacionDe = new Map(ubicaciones.rows.map((fila) => [fila.clave, fila]));
  const puestos = new Map();
  for (const fila of padron.rows) {
    const puesto = decryptField(fila.polling_place);
    const mesa = decryptField(fila.voting_table);
    const clave = normalizarPuesto(puesto);
    if (!puestos.has(clave)) puestos.set(clave, { pollingPlace: puesto, mesas: new Map(), votantes: 0 });
    const actual = puestos.get(clave);
    actual.votantes += fila.votantes;
    const claveMesa = normalizarMesa(mesa);
    if (!actual.mesas.has(claveMesa)) actual.mesas.set(claveMesa, { nombre: mesa, votantes: 0 });
    actual.mesas.get(claveMesa).votantes += fila.votantes;
  }
  if (todos) {
    for (const fila of ubicaciones.rows) {
      if (!puestos.has(fila.clave)) puestos.set(fila.clave, { pollingPlace: fila.nombre, mesas: new Map(), votantes: 0 });
    }
  }
  // Una mesa creada a mano en un puesto que ya no figura (sin votantes ni
  // ubicación) no se muestra: vuelve a aparecer si el puesto vuelve.
  for (const fila of registradas.rows) {
    const puesto = puestos.get(fila.puesto_clave);
    if (puesto && !puesto.mesas.has(fila.clave)) puesto.mesas.set(fila.clave, { nombre: fila.nombre, votantes: 0 });
  }
  return [...puestos.entries()]
    .map(([clave, p]) => {
      const mesas = [...p.mesas.values()].sort((a, b) => enOrden(a.nombre, b.nombre));
      return {
        pollingPlace: p.pollingPlace,
        votingTables: mesas.map((m) => m.nombre),
        mesas,
        voters: p.votantes,
        ubicacion: ubicacionDe.has(clave) ? ubicacionDeFila(ubicacionDe.get(clave)) : null,
      };
    })
    .sort((a, b) => enOrden(a.pollingPlace, b.pollingPlace));
}

// Cuántos jurados tiene cada mesa de cada puesto ("puesto|mesa", ambos
// normalizados), y cuántos son de todo un puesto ("puesto|*").
async function juradosPorLugar(pool) {
  const { rows } = await pool.query("SELECT polling_place, voting_table FROM admins WHERE role = 'jurado'");
  const cuenta = new Map();
  for (const fila of rows) {
    const puesto = normalizarPuesto(decryptField(fila.polling_place));
    const llave = `${puesto}|${fila.voting_table ? normalizarMesa(decryptField(fila.voting_table)) : '*'}`;
    cuenta.set(llave, (cuenta.get(llave) || 0) + 1);
  }
  return cuenta;
}

// El puesto (y la mesa, si se pidió una) tal como figuran en el padrón, o el
// motivo por el que no se encontró: 'padron_vacio', 'puesto' o 'mesa'.
function ubicarEnPadron(lugares, pollingPlace, votingTable) {
  if (lugares.length === 0) return { error: 'padron_vacio' };
  const puesto = lugares.find((p) => mismoPuesto(p.pollingPlace, pollingPlace));
  if (!puesto) return { error: 'puesto' };
  if (!votingTable) return { pollingPlace: puesto.pollingPlace, votingTable: null };
  const mesa = puesto.votingTables.find((m) => mismaMesa(m, votingTable));
  if (!mesa) return { error: 'mesa' };
  return { pollingPlace: puesto.pollingPlace, votingTable: mesa };
}

// Puesto y mesa de un votante nuevo, tal como ya figuran en el padrón si
// están escritos de otra forma ("puesto central", "1"). Si son nuevos, se
// anotan en "lugares" (la lista de lugaresDelPadron, que cambia): así los
// siguientes votantes del mismo pedido quedan en ese puesto y esa mesa
// aunque los escriban distinto.
function lugarCanonico(lugares, pollingPlace, votingTable) {
  let puesto = lugares.find((p) => mismoPuesto(p.pollingPlace, pollingPlace));
  if (!puesto) {
    puesto = { pollingPlace, votingTables: [], ubicacion: null };
    lugares.push(puesto);
  }
  let mesa = puesto.votingTables.find((m) => mismaMesa(m, votingTable));
  if (!mesa) {
    mesa = votingTable;
    puesto.votingTables.push(mesa);
  }
  return { pollingPlace: puesto.pollingPlace, votingTable: mesa };
}

module.exports = {
  normalizarPuesto, normalizarMesa, mismoPuesto, mismaMesa, juradoCubre, lugaresDelPadron, juradosPorLugar, ubicarEnPadron, lugarCanonico,
  ubicacionDeFila,
};

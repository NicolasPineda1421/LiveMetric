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

// Los puestos del padrón (votantes activos), cada uno con sus mesas, tal
// como están escritos en él. Si el mismo puesto o mesa aparece escrito de
// dos formas, queda una sola.
async function lugaresDelPadron(pool) {
  const { rows } = await pool.query('SELECT DISTINCT polling_place, voting_table FROM voters WHERE is_active');
  const puestos = new Map();
  for (const fila of rows) {
    const puesto = decryptField(fila.polling_place);
    const mesa = decryptField(fila.voting_table);
    const clave = normalizarPuesto(puesto);
    if (!puestos.has(clave)) puestos.set(clave, { pollingPlace: puesto, mesas: new Map() });
    const mesas = puestos.get(clave).mesas;
    if (!mesas.has(normalizarMesa(mesa))) mesas.set(normalizarMesa(mesa), mesa);
  }
  return [...puestos.values()]
    .map((p) => ({ pollingPlace: p.pollingPlace, votingTables: [...p.mesas.values()].sort(enOrden) }))
    .sort((a, b) => enOrden(a.pollingPlace, b.pollingPlace));
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

module.exports = { normalizarPuesto, normalizarMesa, mismoPuesto, mismaMesa, juradoCubre, lugaresDelPadron, ubicarEnPadron };

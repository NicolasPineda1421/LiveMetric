// Cómo se agrupa la participación (GET /metrics/participation): por puesto,
// por mesa de cada puesto, o por la ubicación del puesto (departamento,
// municipio o zona urbana o rural, de la tabla puestos_votacion; ver la
// migración 009). Funciones puras: app.js hace las consultas.

const AGRUPACIONES = ['polling_place', 'voting_table', 'departamento', 'municipio', 'zona'];
const SIN_UBICACION = 'Sin ubicación';
const BOGOTA = '11001';

// El nombre del puesto como lo identifica auth-service (lugares.js): sin
// mayúsculas, tildes ni espacios de más. Es la "clave" de puestos_votacion.
const clavePuesto = (texto) => String(texto ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

// El grupo de un puesto y una mesa. Por mesa, con el puesto delante: la
// "Mesa 1" de dos puestos son dos mesas distintas.
function grupoDe(agrupacion, puesto, mesa, ubicaciones) {
  if (agrupacion === 'polling_place') return puesto;
  if (agrupacion === 'voting_table') return `${puesto} · ${mesa}`;
  const u = ubicaciones.get(clavePuesto(puesto));
  if (!u) return SIN_UBICACION;
  if (agrupacion === 'departamento') return u.departamento;
  if (agrupacion === 'municipio') return u.codigo_municipio === BOGOTA ? u.municipio : `${u.municipio} (${u.departamento})`;
  return u.zona === 'rural' ? 'Rural' : 'Urbana';
}

// filasPadron: [{ puesto, mesa, registered }] (ya descifradas); filasVotos:
// [{ puesto, mesa, votesCast }]; ubicaciones: Map(clave -> fila de
// puestos_votacion). Devuelve los grupos en orden alfabético, con "Sin
// ubicación" al final.
function agruparParticipacion(agrupacion, filasPadron, filasVotos, ubicaciones) {
  const grupos = new Map();
  const sumar = (puesto, mesa, campo, n) => {
    const nombre = grupoDe(agrupacion, puesto, mesa, ubicaciones);
    const actual = grupos.get(nombre) || { group: nombre, registered: 0, votesCast: 0 };
    actual[campo] += n; // eslint-disable-line security/detect-object-injection -- campo es 'registered' o 'votesCast', fijo en este archivo
    grupos.set(nombre, actual);
  };
  for (const f of filasPadron) sumar(f.puesto, f.mesa, 'registered', f.registered);
  for (const f of filasVotos) sumar(f.puesto, f.mesa, 'votesCast', f.votesCast);
  return [...grupos.values()].sort((a, b) => Number(a.group === SIN_UBICACION) - Number(b.group === SIN_UBICACION)
    || a.group.localeCompare(b.group, 'es', { numeric: true, sensitivity: 'base' }));
}

module.exports = { AGRUPACIONES, SIN_UBICACION, clavePuesto, grupoDe, agruparParticipacion };

// La ubicación de los puestos de los votantes de un pedido (POST
// /admin/voters y /admin/voters/bulk). Todo puesto necesita su ubicación:
//  - Un puesto que todavía no la tiene (nuevo, o de antes de la migración
//    009) la recibe de las filas que la traen, en cualquier orden: las demás
//    filas del mismo puesto pueden no traerla, o traer la misma.
//  - Un puesto que ya la tiene no la cambia por una carga: si una fila dice
//    otra, es un error (¿otro puesto con el mismo nombre?). Se cambia en la
//    pestaña "Puestos".
// El panel aplica estas mismas reglas antes de mandar un archivo
// (services/frontend/src/utils/padronArchivo.js).
const { traeUbicacion, resolverUbicacion, mismaUbicacion, describirUbicacion } = require('./divipola');
const { normalizarPuesto } = require('./lugares');

const mismoLugar = (a, b) => a.codigoMunicipio === b.codigoMunicipio && a.zona === b.zona;

// filas: [{ puesto, datos }], donde puesto es el objeto de lugaresDelPadron
// (o el que agregó lugarCanonico) y datos lo que mandó ese votante.
// Devuelve { error: 'Votante 3: …' } o { nuevas: [{ puesto, ubicacion }] }.
function ubicarPuestosDelPedido(filas) {
  const nuevas = new Map();
  for (const [i, { puesto, datos }] of filas.entries()) {
    if (!traeUbicacion(datos)) continue;
    const { ubicacion, motivos } = resolverUbicacion(datos);
    if (motivos) return { error: `Votante ${i + 1}: ${motivos.join('; ')}.` };
    if (puesto.ubicacion) {
      if (!mismaUbicacion(puesto.ubicacion, ubicacion)) {
        return {
          error: `Votante ${i + 1}: el puesto «${puesto.pollingPlace}» está en ${describirUbicacion(puesto.ubicacion)}, y aquí dice `
            + `${describirUbicacion(ubicacion)}. Si es otro puesto, dale otro nombre; si la ubicación está mal, corrígela en la pestaña «Puestos».`,
        };
      }
      continue;
    }
    const anterior = nuevas.get(puesto);
    // Una fila puede traer la localidad y otra no: vale la que la trae.
    if (!anterior || (anterior.localidad === null && mismoLugar(anterior, ubicacion))) nuevas.set(puesto, ubicacion);
    else if (!mismaUbicacion(anterior, ubicacion)) {
      return {
        error: `Votante ${i + 1}: el puesto «${puesto.pollingPlace}» está en ${describirUbicacion(anterior)} en otra fila, y aquí dice `
          + `${describirUbicacion(ubicacion)}. Si son dos puestos distintos, dales nombres distintos.`,
      };
    }
  }
  for (const [i, { puesto }] of filas.entries()) {
    if (!puesto.ubicacion && !nuevas.has(puesto)) {
      return {
        error: `Votante ${i + 1}: el puesto «${puesto.pollingPlace}» todavía no tiene ubicación: indica su departamento, su municipio y su zona (urbana o rural).`,
      };
    }
  }
  return { nuevas: [...nuevas.entries()].map(([puesto, ubicacion]) => ({ puesto, ubicacion })) };
}

// Guarda la ubicación de los puestos nuevos, dentro de la transacción de la
// carga. Si otro administrador la guardó un instante antes, queda la suya.
async function guardarUbicaciones(client, nuevas, adminId) {
  for (const { puesto, ubicacion: u } of nuevas) {
    await client.query(
      `INSERT INTO puestos_votacion (nombre, clave, pais, codigo_municipio, departamento, municipio, localidad, zona, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (clave) DO NOTHING`,
      [puesto.pollingPlace, normalizarPuesto(puesto.pollingPlace), u.pais, u.codigoMunicipio, u.departamento, u.municipio, u.localidad, u.zona, adminId]
    );
  }
}

module.exports = { ubicarPuestosDelPedido, guardarUbicaciones };

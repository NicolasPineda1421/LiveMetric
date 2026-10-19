// La ubicación de los puestos de las pruebas: todo puesto necesita una (ver
// puestos.js), y en todos los archivos es la misma, porque comparten la base.
const UBICACION = { departamento: 'Boyacá', municipio: 'Tunja', zona: 'urbana' };
const conUbicacion = (voters) => voters.map((v) => ({ ...UBICACION, ...v }));
// Dónde vive un jurado de esos puestos (migración 011): mismo municipio, y
// los puestos de las pruebas no tienen localidad, así que queda cerca.
const VIVE_CERCA = { departamento: 'Boyacá', municipio: 'Tunja' };

module.exports = { UBICACION, conUbicacion, VIVE_CERCA };

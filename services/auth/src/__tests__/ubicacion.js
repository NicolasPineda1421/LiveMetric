// La ubicación de los puestos de las pruebas: todo puesto necesita una (ver
// puestos.js), y en todos los archivos es la misma, porque comparten la base.
const UBICACION = { departamento: 'Boyacá', municipio: 'Tunja', zona: 'urbana' };
const conUbicacion = (voters) => voters.map((v) => ({ ...UBICACION, ...v }));

module.exports = { UBICACION, conUbicacion };

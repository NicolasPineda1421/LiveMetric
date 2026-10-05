// Cuánto vale el PIN de un votante: PIN_VIGENCIA_HORAS (en el .env), contadas
// desde que se genera. Sin definir, 24 horas; como máximo, 90 días.
const HORA_MS = 60 * 60 * 1000;
const VIGENCIA_POR_DEFECTO_HORAS = 24;
const VIGENCIA_MAXIMA_HORAS = 90 * 24;

// Las horas de vigencia, o null si el valor no es un entero de 1 al máximo.
function leerHorasDeVigencia(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return VIGENCIA_POR_DEFECTO_HORAS;
  const horas = Number(valor);
  return Number.isInteger(horas) && horas >= 1 && horas <= VIGENCIA_MAXIMA_HORAS ? horas : null;
}

// El vencimiento de un PIN generado en "desde" (ahora, si no se indica).
const vencimientoDelPin = (horas, desde = Date.now()) => new Date(desde + horas * HORA_MS);

module.exports = { leerHorasDeVigencia, vencimientoDelPin, VIGENCIA_POR_DEFECTO_HORAS, VIGENCIA_MAXIMA_HORAS };

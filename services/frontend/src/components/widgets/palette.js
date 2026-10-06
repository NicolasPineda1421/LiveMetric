// Paleta categórica validada para modo oscuro (orden fijo, nunca ciclada;
// ver skill de dataviz: CVD Delta E >= 8, normal-vision >= 15 en pares
// adyacentes). Es la que se usa en pantalla (LiveMetric no tiene modo claro
// en su UI normal).
export const CATEGORICAL = [
  '#3987e5', // 1 azul
  '#d95926', // 2 naranja
  '#199e70', // 3 aqua
  '#c98500', // 4 amarillo
  '#d55181', // 5 magenta
  '#008300', // 6 verde
  '#9085e9', // 7 violeta
  '#e66767', // 8 rojo
];

// Misma paleta, columna "Light" de la skill de dataviz: mismo orden e
// identidad de hue por índice, recalibrada para la superficie blanca del
// PDF exportado en vez de la superficie oscura de la UI (los tonos oscuros
// pierden contraste sobre blanco).
export const CATEGORICAL_LIGHT = [
  '#2a78d6', // 1 azul
  '#eb6834', // 2 naranja
  '#1baf7a', // 3 aqua
  '#eda100', // 4 amarillo
  '#e87ba4', // 5 magenta
  '#008300', // 6 verde
  '#4a3aa7', // 7 violeta
  '#e34948', // 8 rojo
];

// Métricas de una sola serie (evolución en el tiempo, participación) usan el
// azul de acento de la UI, que es también el primer color de la paleta
// categórica (validada sobre la superficie de los widgets, #1c2128).
export const SEQUENTIAL_ACCENT = '#3987e5';

// Tinta secundaria y grilla: las mismas variables que el resto del panel
// (--color-text-muted y --color-border en styles.css).
export const MUTED_INK = '#98a1ab';
export const GRIDLINE = '#272d35';

// Equivalentes para el PDF exportado (fondo blanco): tinta primaria/muted y
// línea de grilla de la tabla "Chart chrome & ink" (columna Light) de la
// skill de dataviz. En impreso, las marcas de una sola serie van en tinta
// oscura en vez de color.
export const PRINT_INK = '#0b0b0b';
export const PRINT_MUTED_INK = '#52514e';
export const PRINT_GRIDLINE = '#e1e0d9';

// Más de 8 categorías: se pliegan a "Otros" en vez de generar un noveno color.
export function foldToOther(items, limit = 8) {
  if (items.length <= limit) return items;
  const head = items.slice(0, limit - 1);
  const restTotal = items.slice(limit - 1).reduce((sum, i) => sum + (i.value || 0), 0);
  return [...head, { name: 'Otros', value: restTotal }];
}

export function colorAt(index, light = false) {
  const set = light ? CATEGORICAL_LIGHT : CATEGORICAL;
  return set[index % set.length];
}

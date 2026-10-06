// Cómo se dibuja un gráfico de barras según cuántas categorías tiene y lo
// largos que son sus nombres. Pocas y cortas (las opciones de una
// elección): columnas. Muchas o largas (los puestos de un padrón grande,
// las mesas, los municipios): barras horizontales, de mayor a menor, con el
// nombre a la izquierda (recortado si no entra; completo al pasar el
// mouse) y el valor al final de cada barra. En pantalla, si no entran todas
// en el widget, se desplazan; en el PDF van las de mayor valor y una nota.

export const MAXIMO_COLUMNAS = 6;
export const LARGO_MAXIMO_EN_COLUMNA = 20;
export const ALTO_FILA = 26; // px por barra horizontal
export const FILAS_EN_PDF = 15;
const PX_POR_LETRA = 6.6; // a 11 px, la fuente de los ejes (algo de más: mayúsculas y tildes)

// Recorta al final, salvo el de una mesa ("Colegio Central · Mesa 2"):
// ahí se recorta el puesto y la mesa queda.
export function recortar(texto, maximo) {
  const t = String(texto ?? '');
  if (t.length <= maximo) return t;
  const separador = t.lastIndexOf(' · ');
  const final = separador > 0 ? t.slice(separador) : '';
  if (final && final.length < maximo - 4) return `${recortar(t.slice(0, separador), maximo - final.length)}${final}`;
  return `${t.slice(0, Math.max(1, maximo - 1)).trimEnd()}…`;
}

// "1.234", "45,5%"
export function formatearValor(valor, unidad) {
  const texto = (Number(valor) || 0).toLocaleString('es-CO', { maximumFractionDigits: 1 });
  return unidad === '%' ? `${texto}%` : texto;
}

export function disposicionDeBarras(items, { printMode = false } = {}) {
  const largo = Math.max(0, ...items.map((i) => String(i.name ?? '').length));
  if (items.length <= MAXIMO_COLUMNAS && largo <= LARGO_MAXIMO_EN_COLUMNA) {
    return { horizontal: false, filas: items, ocultas: 0 };
  }
  const ordenadas = [...items].sort((a, b) => (b.value || 0) - (a.value || 0)
    || String(a.name).localeCompare(String(b.name), 'es', { numeric: true }));
  const filas = printMode ? ordenadas.slice(0, FILAS_EN_PDF) : ordenadas;
  const anchoEtiquetas = Math.round(Math.min(180, Math.max(72, largo * PX_POR_LETRA)));
  return {
    horizontal: true,
    filas,
    ocultas: ordenadas.length - filas.length,
    anchoEtiquetas,
    letras: Math.floor(anchoEtiquetas / PX_POR_LETRA),
    alto: filas.length * ALTO_FILA + 16,
  };
}

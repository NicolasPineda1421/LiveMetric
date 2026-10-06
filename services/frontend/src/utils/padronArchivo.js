// Carga del padrón desde un archivo o desde celdas copiadas de una hoja de
// cálculo. Lee el texto (CSV con coma, punto y coma o tabulaciones),
// reconoce las columnas y valida cada fila con las mismas reglas que el
// servicio (POST /admin/voters), para mostrar qué corregir ANTES de cargar
// nada. También arma la plantilla y la lista de PIN para descargar.
// Funciones puras: no tocan la pantalla.
import { clavePuesto, crearUbicador, describirUbicacion, mismaUbicacion, traeUbicacion } from './ubicacion.js';

export const MAXIMO_BYTES = 10 * 1024 * 1024;
export const MAXIMO_VOTANTES = 50000;
// Votantes por pedido: el servicio genera el PIN de cada uno con bcrypt
// (unos 80 ms cada uno), y cada lote tiene que terminar mucho antes de que
// nginx corte la espera (60 s), también en una PC lenta.
export const TAMANO_LOTE = 100;
export const SEGUNDOS_POR_VOTANTE = 0.08;

const SEPARADORES = { ';': 'punto y coma', ',': 'coma', '\t': 'tabulación' };
export const nombreSeparador = (separador) => SEPARADORES[separador] || separador; // eslint-disable-line security/detect-object-injection -- separador sale de detectarSeparador

// Excel guarda "CSV UTF-8" o, con "CSV (delimitado por comas)", en la
// codificación de Windows (las tildes y la ñ en windows-1252). Se prueba
// UTF-8 estricto y, si no es válido, windows-1252.
export function decodificarTexto(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// El de la primera línea con más apariciones: tabulación (celdas copiadas
// de una hoja de cálculo), punto y coma (el CSV de Excel en español, que usa
// la coma para los decimales) o coma.
export function detectarSeparador(texto) {
  const primera = texto.replace(/^\uFEFF/, '').split(/\r?\n/).find((linea) => linea.trim() !== '') || '';
  const contar = (caracter) => primera.split(caracter).length - 1;
  if (contar('\t') > 0) return '\t';
  return contar(',') > contar(';') ? ',' : ';';
}

// CSV (RFC 4180): celdas entre comillas, con el separador, saltos de línea
// o comillas dobladas ("") adentro.
export function leerFilas(texto, separador) {
  const filas = [];
  let fila = [];
  let celda = '';
  let entreComillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto.charAt(i);
    if (entreComillas) {
      if (c !== '"') celda += c;
      else if (texto.charAt(i + 1) === '"') { celda += '"'; i += 1; } else entreComillas = false;
    } else if (c === '"' && celda === '') {
      entreComillas = true;
    } else if (c === separador) {
      fila.push(celda);
      celda = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto.charAt(i + 1) === '\n') i += 1;
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
    } else {
      celda += c;
    }
  }
  if (celda !== '' || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas;
}

// "N° de Documento" -> "n de documento": sin tildes, mayúsculas ni signos.
const simplificar = (texto) => String(texto ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const espacios = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim();

// Cómo puede llamarse cada columna en el encabezado.
const ENCABEZADOS = {
  cedula: ['cedula', 'cedula de ciudadania', 'cc', 'c c', 'documento', 'documento de identidad', 'numero de documento',
    'no documento', 'no de documento', 'nro documento', 'n documento', 'n de documento', 'identificacion', 'numero de identificacion'],
  nombre: ['nombre', 'nombre completo', 'nombres y apellidos', 'nombre y apellidos', 'nombre y apellido', 'votante'],
  nombres: ['nombres'],
  apellidos: ['apellidos', 'apellido'],
  puesto: ['puesto', 'puesto de votacion', 'puesto votacion', 'lugar', 'lugar de votacion', 'sede'],
  mesa: ['mesa', 'mesa de votacion', 'numero de mesa', 'no mesa', 'nro mesa', 'n mesa'],
  asistido: ['asistido', 'asistida', 'voto asistido', 'requiere asistencia', 'asistencia'],
  // La ubicación del puesto (hace falta solo si el puesto todavía no la tiene).
  pais: ['pais'],
  departamento: ['departamento', 'depto', 'dpto', 'departamento del puesto'],
  municipio: ['municipio', 'ciudad', 'ciudad o municipio', 'municipio o ciudad', 'municipio del puesto'],
  localidad: ['localidad', 'comuna', 'localidad o comuna', 'comuna o localidad', 'corregimiento'],
  zona: ['zona', 'area', 'urbana o rural', 'zona urbana o rural', 'tipo de zona', 'zona del puesto'],
};
const CAMPO_DE = new Map(Object.entries(ENCABEZADOS).flatMap(([campo, nombres]) => nombres.map((n) => [n, campo])));

// Las celdas de Excel con números de miles: "1.234.567" o "1 234 567".
function limpiarCedula(texto) {
  const t = espacios(texto);
  // Sin la expresión ^\d{1,3}([.,\s]\d{3})+$, que el análisis marca como
  // insegura (repetición anidada): se parte por el separador y se mira cada grupo.
  const grupos = t.split(/[.,\s]/);
  const deMiles = grupos.length > 1 && /^\d{1,3}$/.test(grupos[0]) && grupos.slice(1).every((g) => /^\d{3}$/.test(g));
  return deMiles ? grupos.join('') : t;
}

const SI = new Set(['si', 's', 'x', '1', 'true', 'verdadero', 'yes', 'y']);
const NO = new Set(['', 'no', 'n', '0', 'false', 'falso']);
function leerAsistido(texto) {
  const t = simplificar(texto);
  if (SI.has(t)) return true;
  if (NO.has(t)) return false;
  return null;
}

// Las mismas reglas que el servicio. Devuelve los motivos de error (vacío
// si la fila sirve) y la fila ya normalizada.
function validarFila({ cedula: cedulaCruda, nombre, puesto, mesa, asistido }) {
  const motivos = [];
  const cedula = limpiarCedula(cedulaCruda);
  if (/^\d[\d.,]*e\+\d+$/i.test(cedula)) {
    motivos.push('Excel guardó la cédula en notación científica (1,23E+09): dale formato de texto a esa columna y vuelve a guardar el archivo');
  } else if (cedula === '') {
    motivos.push('falta la cédula');
  } else if (!/^[0-9A-Za-z-]{5,20}$/.test(cedula)) {
    motivos.push('la cédula debe tener de 5 a 20 letras, números o guiones');
  }
  const fullName = espacios(nombre);
  if (fullName === '') motivos.push('falta el nombre');
  else if (fullName.length < 3) motivos.push('el nombre debe tener 3 caracteres o más');
  else if (fullName.length > 200) motivos.push('el nombre tiene más de 200 caracteres');
  const pollingPlace = espacios(puesto);
  if (pollingPlace === '') motivos.push('falta el puesto');
  else if (pollingPlace.length < 2) motivos.push('el puesto debe tener 2 caracteres o más');
  else if (pollingPlace.length > 150) motivos.push('el puesto tiene más de 150 caracteres');
  const votingTable = espacios(mesa);
  if (votingTable === '') motivos.push('falta la mesa');
  else if (votingTable.length > 50) motivos.push('la mesa tiene más de 50 caracteres');
  const assisted = leerAsistido(asistido);
  if (assisted === null) motivos.push('en voto asistido escribe sí o no');
  return { motivos, votante: { cedula, fullName, pollingPlace, votingTable, assisted: assisted === true } };
}

// Si la columna i del encabezado es una de las que se usan: la primera con
// cada nombre conocido.
const columnaUsada = (campos, i) => campos.at(i) !== null && campos.indexOf(campos.at(i)) === i;

const NOMBRE_COLUMNA = { cedula: 'la cédula', nombre: 'el nombre', puesto: 'el puesto', mesa: 'la mesa' };

// El orden de la plantilla, y el de las columnas sin encabezados.
const COLUMNAS_DE_LA_PLANTILLA = ['cedula', 'nombre', 'puesto', 'mesa', 'asistido', 'pais', 'departamento', 'municipio', 'localidad', 'zona'];
export const ORDEN_SIN_ENCABEZADOS = '4 columnas (cédula, nombre, puesto y mesa), 5 (y voto asistido) o 10 '
  + '(y la ubicación del puesto: país, departamento, municipio, localidad y zona)';

// La ubicación del puesto de cada fila, con las reglas del servicio
// (services/auth/src/puestos.js): un puesto que ya la tiene no la necesita
// (y si una fila dice otra, es un error); uno que no la tiene la toma de las
// filas que la traen, en cualquier orden, y si ninguna la trae, sus filas no
// se pueden cargar. Cada votante queda con "ubicacion" (la de su puesto) y
// "ubicacionNueva" (si hay que mandarla: el puesto todavía no la tiene).
function ubicarPuestos(leidas, { catalogo, puestos = [] }) {
  const ubicador = crearUbicador(catalogo);
  const existentes = new Map(puestos.map((p) => [clavePuesto(p.pollingPlace), p]));
  const nuevas = new Map();
  const conPuesto = leidas.filter((l) => l.votante.pollingPlace);
  for (const l of conPuesto) {
    if (!traeUbicacion(l.datosUbicacion)) continue;
    const clave = clavePuesto(l.votante.pollingPlace);
    const { ubicacion, motivos } = ubicador.resolver(l.datosUbicacion);
    if (motivos) {
      l.motivos.push(...motivos);
      l.ubicacionMal = true;
      continue;
    }
    const existente = existentes.get(clave);
    if (existente?.ubicacion) {
      if (!mismaUbicacion(existente.ubicacion, ubicacion)) {
        l.motivos.push(`el puesto «${existente.pollingPlace}» ya está en ${describirUbicacion(existente.ubicacion)}, y esta fila dice `
          + `${describirUbicacion(ubicacion)}: si es otro puesto, dale otro nombre; si la ubicación está mal, corrígela en la pestaña «Puestos»`);
        l.ubicacionMal = true;
      }
      continue;
    }
    const anterior = nuevas.get(clave);
    const mismoLugar = anterior && anterior.ubicacion.codigoMunicipio === ubicacion.codigoMunicipio && anterior.ubicacion.zona === ubicacion.zona;
    if (!anterior || (anterior.ubicacion.localidad === null && mismoLugar)) nuevas.set(clave, { ubicacion, fila: l.numero });
    else if (!mismaUbicacion(anterior.ubicacion, ubicacion)) {
      l.motivos.push(`el puesto está en ${describirUbicacion(anterior.ubicacion)} en la fila ${anterior.fila}, y esta fila dice `
        + `${describirUbicacion(ubicacion)}: si son dos puestos distintos, dales nombres distintos`);
      l.ubicacionMal = true;
    }
  }
  for (const l of conPuesto) {
    const clave = clavePuesto(l.votante.pollingPlace);
    const existente = existentes.get(clave);
    if (existente?.ubicacion) {
      l.votante.ubicacion = existente.ubicacion;
      l.votante.ubicacionNueva = false;
    } else if (nuevas.has(clave)) {
      l.votante.ubicacion = nuevas.get(clave).ubicacion;
      l.votante.ubicacionNueva = true;
    } else if (!l.ubicacionMal) {
      l.motivos.push(existente
        ? `el puesto «${existente.pollingPlace}» todavía no tiene ubicación: agrega su departamento, su municipio y su zona (urbana o rural) en alguna de sus filas, o pónsela en la pestaña «Puestos»`
        : 'el puesto es nuevo: falta su ubicación (departamento, municipio y zona urbana o rural) en alguna de sus filas');
    }
  }
}

// Del texto completo (archivo o celdas pegadas) a los votantes que se
// pueden cargar, las filas con errores y las cédulas repetidas. "fila" es el
// número de fila como se ve en la hoja de cálculo (el encabezado es la 1).
// contexto: { catalogo, puestos }, el catálogo del DANE y los puestos que ya
// existen (con su ubicación o sin ella), para revisar la ubicación de cada
// puesto como el servicio (ver ubicarPuestos). Sin catálogo no se revisa.
export function interpretarPadron(texto, contexto = {}) {
  const separador = detectarSeparador(texto);
  // Las filas en blanco no cuentan, pero sí ocupan su número.
  const filas = leerFilas(texto.replace(/^\uFEFF/, ''), separador)
    .map((celdas, i) => ({ numero: i + 1, celdas }))
    .filter(({ celdas }) => celdas.some((c) => c.trim() !== ''));
  const resultado = { separador, encabezados: null, ignoradas: [], votantes: [], errores: [], repetidas: [], error: null };
  if (filas.length === 0) return { ...resultado, error: 'No hay ningún votante: el archivo o el texto está vacío.' };

  // Encabezados: la primera fila con datos, si al menos dos de sus celdas
  // son nombres de columna conocidos. Si no, las columnas van en orden.
  const primera = filas[0];
  const campos = primera.celdas.map((c) => CAMPO_DE.get(simplificar(c)) || null);
  const conEncabezados = campos.filter(Boolean).length >= 2;
  const columna = new Map();
  if (conEncabezados) {
    campos.forEach((campo, i) => { if (campo && !columna.has(campo)) columna.set(campo, i); });
    const faltan = ['cedula', 'puesto', 'mesa'].filter((c) => !columna.has(c));
    if (!columna.has('nombre') && !columna.has('nombres') && !columna.has('apellidos')) faltan.splice(1, 0, 'nombre');
    if (faltan.length > 0) {
      return {
        ...resultado,
        error: `Falta la columna de ${faltan.map((c) => NOMBRE_COLUMNA[c]).join(', ')}. ` // eslint-disable-line security/detect-object-injection -- c es una de las claves fijas de arriba
          + `La primera fila dice: ${primera.celdas.map(espacios).filter(Boolean).join(', ')}.`,
      };
    }
    resultado.encabezados = [];
    primera.celdas.forEach((c, i) => {
      if (espacios(c) !== '') (columnaUsada(campos, i) ? resultado.encabezados : resultado.ignoradas).push(espacios(c));
    });
  } else {
    // Sin encabezados, en el orden de la plantilla: las 4 o 5 primeras, o
    // las 10 con la ubicación del puesto.
    const columnas = primera.celdas.length - [...primera.celdas].reverse().findIndex((c) => c.trim() !== '');
    if (columnas < 4 || (columnas > 5 && columnas < 10)) {
      return {
        ...resultado,
        error: `Sin encabezados, cada fila lleva ${ORDEN_SIN_ENCABEZADOS}. `
          + 'Para usar otro orden, agrega una primera fila con los nombres de las columnas (por ejemplo: Cédula, Nombre, Puesto, Mesa, Departamento, Municipio, Zona).',
      };
    }
    COLUMNAS_DE_LA_PLANTILLA.forEach((campo, i) => columna.set(campo, i));
  }

  const celda = (celdas, campo) => (columna.has(campo) ? celdas[columna.get(campo)] ?? '' : '');
  const leidas = filas
    .filter(({ numero }) => !(conEncabezados && numero === primera.numero))
    .map(({ numero, celdas }) => {
      const nombre = columna.has('nombre')
        ? celda(celdas, 'nombre')
        : `${celda(celdas, 'nombres')} ${celda(celdas, 'apellidos')}`;
      const { motivos, votante } = validarFila({
        cedula: celda(celdas, 'cedula'),
        nombre,
        puesto: celda(celdas, 'puesto'),
        mesa: celda(celdas, 'mesa'),
        asistido: celda(celdas, 'asistido'),
      });
      const datosUbicacion = Object.fromEntries(['pais', 'departamento', 'municipio', 'localidad', 'zona'].map((campo) => [campo, celda(celdas, campo)]));
      return { numero, celdas, motivos, votante, datosUbicacion };
    });
  if (contexto.catalogo) ubicarPuestos(leidas, contexto);

  const vistas = new Map();
  for (const { numero, celdas, motivos, votante } of leidas) {
    if (motivos.length > 0) resultado.errores.push({ fila: numero, cedula: espacios(celda(celdas, 'cedula')), motivos });
    else if (vistas.has(votante.cedula)) resultado.repetidas.push({ fila: numero, cedula: votante.cedula, primera: vistas.get(votante.cedula) });
    else {
      vistas.set(votante.cedula, numero);
      resultado.votantes.push({ fila: numero, ...votante });
    }
  }
  if (resultado.votantes.length > MAXIMO_VOTANTES) {
    resultado.error = `Hay ${resultado.votantes.length.toLocaleString('es-CO')} votantes: el máximo por carga es `
      + `${MAXIMO_VOTANTES.toLocaleString('es-CO')}. Divide el archivo en partes y cárgalas una tras otra.`;
  }
  return resultado;
}

export function enLotes(lista, tamano = TAMANO_LOTE) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamano) lotes.push(lista.slice(i, i + tamano));
  return lotes;
}

// Cuántos votantes hay por puesto, para revisar de un vistazo que el
// archivo es el correcto, con su ubicación y si es nuevo (su ubicación
// sale del archivo). Como en el servicio, "Colegio Andino" y "colegio
// andino" son el mismo puesto: se cuenta junto, con la primera forma en
// que aparece.
export function contarPorPuesto(votantes) {
  const cuenta = new Map();
  for (const v of votantes) {
    const clave = clavePuesto(v.pollingPlace);
    const actual = cuenta.get(clave) || { puesto: v.pollingPlace, votantes: 0, ubicacion: v.ubicacion || null, nuevo: Boolean(v.ubicacionNueva) };
    cuenta.set(clave, { ...actual, votantes: actual.votantes + 1 });
  }
  return [...cuenta.values()].sort((a, b) => b.votantes - a.votantes || a.puesto.localeCompare(b.puesto, 'es'));
}

// Una celda que empieza con =, +, -, @ o un tabulador, Excel la toma como
// fórmula al abrir el CSV ("inyección de CSV"): un nombre como
// =HYPERLINK(...) se ejecutaría en la PC de quien abre la lista. Con un
// apóstrofo adelante queda como texto.
export function celdaSegura(valor) {
  const texto = String(valor ?? '');
  return /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
}

// Punto y coma (lo que Excel en español espera), con BOM para que reconozca
// el UTF-8 y con cada celda entre comillas si hace falta.
function csv(filas) {
  const celda = (valor) => {
    const texto = celdaSegura(valor);
    return /[;"\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  };
  return `\uFEFF${filas.map((fila) => fila.map(celda).join(';')).join('\r\n')}\r\n`;
}

// La ubicación del puesto basta en una de sus filas (en la segunda queda
// vacía), y no hace falta si el puesto ya la tiene.
export const plantillaCsv = () => csv([
  ['Cédula', 'Nombre completo', 'Puesto de votación', 'Mesa', 'Voto asistido', 'País', 'Departamento', 'Municipio', 'Localidad', 'Zona'],
  ['1000000001', 'Ana María Gómez', 'Colegio Central', 'Mesa 1', 'no', 'Colombia', 'Boyacá', 'Tunja', 'Centro', 'urbana'],
  ['1000000002', 'Luis Alberto Peña', 'Colegio Central', 'Mesa 2', 'sí', '', '', '', '', ''],
  ['1000000003', 'Rosa Elena Díaz', 'Escuela Vereda El Salitre', 'Mesa 1', 'no', 'Colombia', 'Cundinamarca', 'Chía', '', 'rural'],
]);

// Los PIN recién generados, para imprimirlos o repartirlos por mesa; "vence"
// es la fecha de cada uno, ya escrita como se quiere mostrar.
export const pinesCsv = (codigos) => csv([
  ['Cédula', 'Nombre', 'Puesto de votación', 'Mesa', 'PIN', 'Vence'],
  ...codigos.map((c) => [c.cedula, c.fullName || '', c.pollingPlace || '', c.votingTable || '', c.pin, c.vence || '']),
]);

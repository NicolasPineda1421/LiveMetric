// Ubicación de un puesto de votación: país, departamento, municipio,
// localidad y zona (urbana o rural). El departamento y el municipio salen de
// la Divipola del DANE (data/divipola.json): se guardan con su código y su
// nombre oficial, aunque se escriban sin tildes, en mayúsculas, con el
// nombre corto ("Cúcuta" por "San José de Cúcuta") o con el código. Por
// ahora los puestos son de Colombia.
// El panel recibe este mismo catálogo (catalogoParaElPanel) y aplica las
// mismas reglas antes de mandar nada (services/frontend/src/utils/ubicacion.js).
const datos = require('./data/divipola.json');

const PAIS = 'Colombia';
const ZONAS = ['urbana', 'rural'];
const BOGOTA = '11001';

// "Bogotá, D.C." -> "bogotadc": sin tildes, mayúsculas, espacios ni signos.
const compacto = (texto) => String(texto ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

// Un código del DANE escrito con o sin el cero inicial ("5", "05001"): solo
// dígitos, sin expresión regular (el análisis estático marca las que se aplican
// a lo que escribe el usuario).
const esCodigo = (texto, minimo, maximo) => texto.length >= minimo && texto.length <= maximo
  && [...texto].every((c) => c >= '0' && c <= '9');

const DEPARTAMENTOS = datos.departamentos.map(([codigo, nombre]) => ({ codigo, nombre }));
const MUNICIPIOS = datos.municipios.map(([codigo, nombre]) => ({ codigo, nombre, departamento: codigo.slice(0, 2) }));

// Otras formas comunes de escribirlos (ya compactas).
const ALIAS_DEPARTAMENTOS = {
  bogota: '11', bogotadc: '11', santafedebogota: '11', distritocapital: '11', bogotadistritocapital: '11',
  sanandres: '88', sanandresyprovidencia: '88', sanandresprovidenciaysantacatalina: '88', archipielagodesanandres: '88', sanandresislas: '88',
  valle: '76', guajira: '44', nortesantander: '54',
};
const ALIAS_MUNICIPIOS = {
  bogota: BOGOTA, bogotadc: BOGOTA, santafedebogota: BOGOTA, bogotadistritocapital: BOGOTA,
  cali: '76001', cucuta: '54001', cartagena: '13001', mompox: '13468', mompos: '13468', tolu: '70820', toluviejo: '70823',
  mariquita: '73443', ubate: '25843', since: '70742', buga: '76111', tumaco: '52835', guican: '15332', piendamo: '19548',
  sotara: '19760', manaure: '20443', ure: '23682', bajira: '27493', belendebajira: '27493', cantondesanpablo: '27135',
  carmendeviboral: '05148', carmendebolivar: '13244', villadeleiva: '15407', purisima: '23586', sanandresislas: '88001',
};

// Las 20 localidades de Bogotá: ahí la localidad tiene que ser una de ellas.
// En los demás municipios es texto libre (comuna, corregimiento…).
const LOCALIDADES = {
  [BOGOTA]: [
    'Usaquén', 'Chapinero', 'Santa Fe', 'San Cristóbal', 'Usme', 'Tunjuelito', 'Bosa', 'Kennedy', 'Fontibón', 'Engativá',
    'Suba', 'Barrios Unidos', 'Teusaquillo', 'Los Mártires', 'Antonio Nariño', 'Puente Aranda', 'La Candelaria',
    'Rafael Uribe Uribe', 'Ciudad Bolívar', 'Sumapaz',
  ],
};
const ALIAS_LOCALIDADES = { martires: 'Los Mártires', candelaria: 'La Candelaria', rafaeluribe: 'Rafael Uribe Uribe' };

const ZONA_DE = {
  urbana: 'urbana', urbano: 'urbana', u: 'urbana', cabecera: 'urbana', cabeceramunicipal: 'urbana', cascourbano: 'urbana',
  rural: 'rural', r: 'rural', ruraldisperso: 'rural', centropoblado: 'rural',
};
const PAIS_DE = { colombia: PAIS, co: PAIS, col: PAIS };

// Lo que el panel necesita para mostrar las listas y aplicar las mismas reglas.
const catalogoParaElPanel = () => ({
  pais: PAIS,
  zonas: ZONAS,
  departamentos: DEPARTAMENTOS,
  municipios: MUNICIPIOS,
  localidades: LOCALIDADES,
  alias: { departamentos: ALIAS_DEPARTAMENTOS, municipios: ALIAS_MUNICIPIOS, localidades: ALIAS_LOCALIDADES, zonas: ZONA_DE, paises: PAIS_DE },
});

const deUnObjeto = (objeto, clave) => (Object.hasOwn(objeto, clave) ? objeto[clave] : undefined); // eslint-disable-line security/detect-object-injection -- clave se busca solo entre las propias del objeto

function buscarDepartamento(texto) {
  const c = compacto(texto);
  if (!c) return null;
  const codigo = esCodigo(c, 1, 2) ? c.padStart(2, '0') : deUnObjeto(ALIAS_DEPARTAMENTOS, c);
  return DEPARTAMENTOS.find((d) => d.codigo === codigo || compacto(d.nombre) === c) || null;
}

// El municipio, dentro de su departamento: hay nombres repetidos (Armenia,
// Florencia, Albania…). Bogotá se acepta también con "Cundinamarca".
function buscarMunicipio(texto, departamento) {
  const c = compacto(texto);
  if (!c || !departamento) return null;
  const delDepartamento = MUNICIPIOS.filter((m) => m.departamento === departamento.codigo);
  const porCodigo = esCodigo(c, 4, 5) ? c.padStart(5, '0') : null;
  const exacto = delDepartamento.find((m) => m.codigo === porCodigo || compacto(m.nombre) === c);
  if (exacto) return exacto;
  const alias = deUnObjeto(ALIAS_MUNICIPIOS, c);
  if (alias === BOGOTA && departamento.codigo === '25') return MUNICIPIOS.find((m) => m.codigo === BOGOTA);
  return delDepartamento.find((m) => m.codigo === alias) || null;
}

function leerLocalidad(texto, municipio) {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim();
  if (!limpio) return { localidad: null };
  const lista = municipio && Object.hasOwn(LOCALIDADES, municipio.codigo) ? LOCALIDADES[municipio.codigo] : null;
  if (!lista) {
    return limpio.length >= 2 && limpio.length <= 80 ? { localidad: limpio } : { error: 'la localidad debe tener de 2 a 80 caracteres' };
  }
  const c = compacto(limpio);
  const encontrada = lista.find((l) => compacto(l) === c) || deUnObjeto(ALIAS_LOCALIDADES, c);
  return encontrada ? { localidad: encontrada } : { error: `«${limpio}» no es una de las 20 localidades de ${municipio.nombre}` };
}

const nombreDelDepartamento = (codigo) => DEPARTAMENTOS.find((d) => d.codigo === codigo)?.nombre;

// Si la fila trae algo de la ubicación del puesto (el país solo no cuenta:
// es siempre Colombia).
const traeUbicacion = (datosFila) => [datosFila?.departamento, datosFila?.municipio, datosFila?.localidad, datosFila?.zona]
  .some((valor) => String(valor ?? '').trim() !== '');

// De lo que se escribió a la ubicación oficial, o lo que hay que corregir.
// { ubicacion } o { motivos: [...] }.
function resolverUbicacion(datosFila) {
  const motivos = [];
  const pais = String(datosFila.pais ?? '').trim();
  if (pais && !deUnObjeto(PAIS_DE, compacto(pais))) motivos.push(`por ahora los puestos son de ${PAIS}, no de «${pais}»`);
  const departamentoTexto = String(datosFila.departamento ?? '').trim();
  const municipioTexto = String(datosFila.municipio ?? '').trim();
  const zonaTexto = String(datosFila.zona ?? '').trim();
  const departamento = buscarDepartamento(departamentoTexto);
  if (!departamentoTexto) motivos.push('falta el departamento');
  else if (!departamento) motivos.push(`«${departamentoTexto}» no es un departamento de ${PAIS}`);
  const municipio = buscarMunicipio(municipioTexto, departamento);
  if (!municipioTexto) motivos.push('falta el municipio');
  else if (departamento && !municipio) motivos.push(`no hay un municipio «${municipioTexto}» en ${departamento.nombre}`);
  const zona = deUnObjeto(ZONA_DE, compacto(zonaTexto));
  if (!zonaTexto) motivos.push('falta la zona (urbana o rural)');
  else if (!zona) motivos.push('en zona escribe urbana o rural');
  const { localidad, error } = leerLocalidad(datosFila.localidad, municipio);
  if (error) motivos.push(error);
  if (motivos.length > 0) return { motivos };
  return {
    ubicacion: {
      pais: PAIS,
      codigoMunicipio: municipio.codigo,
      departamento: nombreDelDepartamento(municipio.departamento),
      municipio: municipio.nombre,
      localidad,
      zona,
    },
  };
}

// ¿La ubicación que trae una fila es la que el puesto ya tiene? La
// localidad se compara solo si la fila la trae.
const mismaUbicacion = (actual, nueva) => actual.codigoMunicipio === nueva.codigoMunicipio
  && actual.zona === nueva.zona
  && (nueva.localidad === null || compacto(actual.localidad) === compacto(nueva.localidad));

// "Tunja (Boyacá), Centro, zona urbana"
function describirUbicacion(u) {
  const lugar = u.codigoMunicipio === BOGOTA ? u.municipio : `${u.municipio} (${u.departamento})`;
  return [lugar, u.localidad, `zona ${u.zona}`].filter(Boolean).join(', ');
}

module.exports = {
  PAIS, ZONAS, DEPARTAMENTOS, MUNICIPIOS, LOCALIDADES, compacto, buscarDepartamento, buscarMunicipio, leerLocalidad,
  traeUbicacion, resolverUbicacion, mismaUbicacion, describirUbicacion, catalogoParaElPanel,
};

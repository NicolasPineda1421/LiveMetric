// Ubicación de un puesto de votación (país, departamento, municipio,
// localidad y zona), con el catálogo del DANE que entrega el servicio
// (GET /admin/divipola) y las mismas reglas que services/auth/src/divipola.js:
// el panel muestra qué corregir antes de mandar nada, y el servicio vuelve a
// revisarlo todo.

// "Bogotá, D.C." -> "bogotadc": sin tildes, mayúsculas, espacios ni signos.
export const compacto = (texto) => String(texto ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

// Como el servicio identifica un puesto: sin mayúsculas, tildes ni espacios
// de más ("Colegio Andino" y "colegio  andino" son el mismo).
export const clavePuesto = (texto) => String(texto ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

// Un código del DANE escrito con o sin el cero inicial ("5", "05001"): solo
// dígitos, sin expresión regular, como en el servicio.
const esCodigo = (texto, minimo, maximo) => texto.length >= minimo && texto.length <= maximo
  && [...texto].every((c) => c >= '0' && c <= '9');

const BOGOTA = '11001';
const deUnObjeto = (objeto, clave) => (objeto && Object.hasOwn(objeto, clave) ? objeto[clave] : undefined); // eslint-disable-line security/detect-object-injection -- clave se busca solo entre las propias del objeto

// Si se escribió algo de la ubicación (el país solo no cuenta: es siempre Colombia).
export const traeUbicacion = (datos) => [datos?.departamento, datos?.municipio, datos?.localidad, datos?.zona]
  .some((valor) => String(valor ?? '').trim() !== '');

// "Tunja (Boyacá), Centro, zona urbana"
export function describirUbicacion(u) {
  if (!u) return '';
  const lugar = u.codigoMunicipio === BOGOTA ? u.municipio : `${u.municipio} (${u.departamento})`;
  return [lugar, u.localidad, `zona ${u.zona}`].filter(Boolean).join(', ');
}

// ¿La ubicación escrita es la que el puesto ya tiene? La localidad, solo si se escribió.
export const mismaUbicacion = (actual, nueva) => actual.codigoMunicipio === nueva.codigoMunicipio
  && actual.zona === nueva.zona
  && (nueva.localidad === null || compacto(actual.localidad) === compacto(nueva.localidad));

// Lo que hace falta mandar al servicio: los códigos del DANE.
export const ubicacionParaEnviar = (u) => ({
  pais: u.pais,
  departamento: u.codigoMunicipio.slice(0, 2),
  municipio: u.codigoMunicipio,
  localidad: u.localidad || '',
  zona: u.zona,
});

export function crearUbicador(catalogo) {
  const { pais, departamentos, municipios, localidades, alias } = catalogo;
  const nombreDepartamento = (codigo) => departamentos.find((d) => d.codigo === codigo)?.nombre;

  function buscarDepartamento(texto) {
    const c = compacto(texto);
    if (!c) return null;
    const codigo = esCodigo(c, 1, 2) ? c.padStart(2, '0') : deUnObjeto(alias.departamentos, c);
    return departamentos.find((d) => d.codigo === codigo || compacto(d.nombre) === c) || null;
  }

  // Dentro de su departamento: hay nombres repetidos. Bogotá vale también con Cundinamarca.
  function buscarMunicipio(texto, departamento) {
    const c = compacto(texto);
    if (!c || !departamento) return null;
    const delDepartamento = municipios.filter((m) => m.departamento === departamento.codigo);
    const porCodigo = esCodigo(c, 4, 5) ? c.padStart(5, '0') : null;
    const exacto = delDepartamento.find((m) => m.codigo === porCodigo || compacto(m.nombre) === c);
    if (exacto) return exacto;
    const otro = deUnObjeto(alias.municipios, c);
    if (otro === BOGOTA && departamento.codigo === '25') return municipios.find((m) => m.codigo === BOGOTA);
    return delDepartamento.find((m) => m.codigo === otro) || null;
  }

  function leerLocalidad(texto, municipio) {
    const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim();
    if (!limpio) return { localidad: null };
    const lista = municipio ? deUnObjeto(localidades, municipio.codigo) : null;
    if (!lista) {
      return limpio.length >= 2 && limpio.length <= 80 ? { localidad: limpio } : { error: 'la localidad debe tener de 2 a 80 caracteres' };
    }
    const c = compacto(limpio);
    const encontrada = lista.find((l) => compacto(l) === c) || deUnObjeto(alias.localidades, c);
    return encontrada ? { localidad: encontrada } : { error: `«${limpio}» no es una de las ${lista.length} localidades de ${municipio.nombre}` };
  }

  // { ubicacion } o { motivos: [...] }
  function resolver(datos) {
    const motivos = [];
    const paisTexto = String(datos.pais ?? '').trim();
    if (paisTexto && !deUnObjeto(alias.paises, compacto(paisTexto))) motivos.push(`por ahora los puestos son de ${pais}, no de «${paisTexto}»`);
    const departamentoTexto = String(datos.departamento ?? '').trim();
    const municipioTexto = String(datos.municipio ?? '').trim();
    const zonaTexto = String(datos.zona ?? '').trim();
    const departamento = buscarDepartamento(departamentoTexto);
    if (!departamentoTexto) motivos.push('falta el departamento');
    else if (!departamento) motivos.push(`«${departamentoTexto}» no es un departamento de ${pais}`);
    const municipio = buscarMunicipio(municipioTexto, departamento);
    if (!municipioTexto) motivos.push('falta el municipio');
    else if (departamento && !municipio) motivos.push(`no hay un municipio «${municipioTexto}» en ${departamento.nombre}`);
    const zona = deUnObjeto(alias.zonas, compacto(zonaTexto));
    if (!zonaTexto) motivos.push('falta la zona (urbana o rural)');
    else if (!zona) motivos.push('en zona escribe urbana o rural');
    const { localidad, error } = leerLocalidad(datos.localidad, municipio);
    if (error) motivos.push(error);
    if (motivos.length > 0) return { motivos };
    return {
      ubicacion: {
        pais, codigoMunicipio: municipio.codigo, departamento: nombreDepartamento(municipio.departamento), municipio: municipio.nombre, localidad, zona,
      },
    };
  }

  const municipiosDe = (codigoDepartamento) => municipios.filter((m) => m.departamento === codigoDepartamento);
  const localidadesDe = (codigoMunicipio) => deUnObjeto(localidades, codigoMunicipio) || null;

  return { resolver, municipiosDe, localidadesDe, departamentos, pais, zonas: catalogo.zonas };
}

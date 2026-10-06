// Ubicación de un puesto (divipola.js): de lo que se escribe a la Divipola
// del DANE, con las formas comunes de escribir cada lugar.
const {
  DEPARTAMENTOS, MUNICIPIOS, resolverUbicacion, mismaUbicacion, describirUbicacion, traeUbicacion, catalogoParaElPanel,
} = require('../divipola');

const lugar = (datos) => resolverUbicacion(datos).ubicacion;
const motivos = (datos) => resolverUbicacion(datos).motivos;

describe('El catálogo del DANE', () => {
  it('tiene los 32 departamentos y Bogotá, y los 1.122 municipios y áreas no municipalizadas, sin códigos repetidos', () => {
    expect(DEPARTAMENTOS).toHaveLength(33);
    expect(MUNICIPIOS).toHaveLength(1122);
    expect(new Set(MUNICIPIOS.map((m) => m.codigo)).size).toBe(1122);
    const departamentos = new Set(DEPARTAMENTOS.map((d) => d.codigo));
    expect(MUNICIPIOS.every((m) => departamentos.has(m.departamento) && /^\d{5}$/.test(m.codigo))).toBe(true);
  });

  it('el panel recibe el mismo catálogo, con las otras formas de escribir cada lugar', () => {
    const catalogo = catalogoParaElPanel();
    expect(catalogo.pais).toBe('Colombia');
    expect(catalogo.municipios).toHaveLength(1122);
    expect(catalogo.alias.municipios.cucuta).toBe('54001');
    expect(catalogo.localidades['11001']).toHaveLength(20);
  });
});

describe('De lo que se escribe a la ubicación oficial', () => {
  it('sin tildes, en mayúsculas o con el código del DANE', () => {
    const tunja = { pais: 'Colombia', codigoMunicipio: '15001', departamento: 'Boyacá', municipio: 'Tunja', localidad: null, zona: 'urbana' };
    expect(lugar({ departamento: 'boyaca', municipio: 'TUNJA', zona: 'Urbano' })).toEqual(tunja);
    expect(lugar({ departamento: '15', municipio: '15001', zona: 'u', pais: 'CO' })).toEqual(tunja);
  });

  it('con el nombre corto de uso común', () => {
    expect(lugar({ departamento: 'Norte de Santander', municipio: 'Cúcuta', zona: 'urbana' }).municipio).toBe('San José de Cúcuta');
    expect(lugar({ departamento: 'Valle', municipio: 'Cali', zona: 'urbana' })).toMatchObject({ departamento: 'Valle del Cauca', municipio: 'Santiago de Cali' });
    expect(lugar({ departamento: 'San Andrés', municipio: 'Providencia', zona: 'rural' }).codigoMunicipio).toBe('88564');
  });

  it('el municipio se busca en su departamento: hay nombres repetidos', () => {
    expect(lugar({ departamento: 'Quindío', municipio: 'Armenia', zona: 'urbana' }).codigoMunicipio).toBe('63001');
    expect(lugar({ departamento: 'Antioquia', municipio: 'Armenia', zona: 'rural' }).codigoMunicipio).toBe('05059');
    expect(motivos({ departamento: 'Antioquia', municipio: 'Tunja', zona: 'urbana' })).toEqual(['no hay un municipio «Tunja» en Antioquia']);
  });

  it('Bogotá, también si se escribe en Cundinamarca, con una de sus 20 localidades', () => {
    const bogota = lugar({ departamento: 'Cundinamarca', municipio: 'Bogotá D.C.', localidad: 'usaquen', zona: 'urbana' });
    expect(bogota).toMatchObject({ codigoMunicipio: '11001', departamento: 'Bogotá, D.C.', localidad: 'Usaquén' });
    expect(lugar({ departamento: 'Bogotá', municipio: 'Bogotá', localidad: 'Candelaria', zona: 'urbana' }).localidad).toBe('La Candelaria');
    expect(motivos({ departamento: 'Bogotá', municipio: 'Bogotá', localidad: 'Chapinerito', zona: 'urbana' }))
      .toEqual(['«Chapinerito» no es una de las 20 localidades de Bogotá, D.C.']);
  });

  it('en otros municipios, la localidad (comuna, corregimiento…) es libre y opcional', () => {
    expect(lugar({ departamento: 'Antioquia', municipio: 'Medellín', localidad: 'Comuna 14  El Poblado', zona: 'urbana' }).localidad).toBe('Comuna 14 El Poblado');
    expect(motivos({ departamento: 'Antioquia', municipio: 'Medellín', localidad: 'x', zona: 'urbana' })).toEqual(['la localidad debe tener de 2 a 80 caracteres']);
  });

  it('dice todo lo que falta o está mal', () => {
    expect(motivos({ pais: 'Perú', departamento: 'Antioqia', zona: 'mixta' })).toEqual([
      'por ahora los puestos son de Colombia, no de «Perú»',
      '«Antioqia» no es un departamento de Colombia',
      'falta el municipio',
      'en zona escribe urbana o rural',
    ]);
    expect(motivos({})).toEqual(['falta el departamento', 'falta el municipio', 'falta la zona (urbana o rural)']);
  });

  it('el país solo no es una ubicación; cualquier otro dato sí', () => {
    expect(traeUbicacion({ pais: 'Colombia' })).toBe(false);
    expect(traeUbicacion({ zona: ' rural ' })).toBe(true);
  });

  it('compara y describe una ubicación', () => {
    const centro = lugar({ departamento: 'Boyacá', municipio: 'Tunja', localidad: 'Centro', zona: 'urbana' });
    expect(mismaUbicacion(centro, lugar({ departamento: '15', municipio: 'tunja', zona: 'urbana' }))).toBe(true);
    expect(mismaUbicacion(centro, lugar({ departamento: '15', municipio: 'tunja', localidad: 'Norte', zona: 'urbana' }))).toBe(false);
    expect(mismaUbicacion(centro, lugar({ departamento: '15', municipio: 'tunja', zona: 'rural' }))).toBe(false);
    expect(describirUbicacion(centro)).toBe('Tunja (Boyacá), Centro, zona urbana');
    expect(describirUbicacion(lugar({ departamento: 'Bogotá', municipio: 'Bogotá', zona: 'urbana' }))).toBe('Bogotá, D.C., zona urbana');
  });
});

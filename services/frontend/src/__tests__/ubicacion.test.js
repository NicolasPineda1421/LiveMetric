// Ubicación de un puesto en el navegador (utils/ubicacion.js): las mismas
// reglas que el servicio (services/auth/src/__tests__/divipola.test.js).
import {
  clavePuesto, crearUbicador, cumpleUbicacion, describirUbicacion, mismaUbicacion, opcionesDeUbicacion, ubicacionParaEnviar,
} from '../utils/ubicacion.js';
import { CATALOGO, CHIA, TUNJA } from './catalogoDePrueba.js';

const { resolver, municipiosDe, localidadesDe } = crearUbicador(CATALOGO);
const lugar = (datos) => resolver(datos).ubicacion;

it('reconoce el departamento y el municipio sin tildes, con el código o con el nombre corto', () => {
  expect(lugar({ departamento: 'BOYACA', municipio: 'tunja', zona: 'Urbano' })).toEqual({
    pais: 'Colombia', codigoMunicipio: '15001', departamento: 'Boyacá', municipio: 'Tunja', localidad: null, zona: 'urbana',
  });
  expect(lugar({ departamento: '54', municipio: 'Cucuta', zona: 'u' }).municipio).toBe('San José de Cúcuta');
  expect(lugar({ departamento: 'Cundinamarca', municipio: 'Bogota D.C.', zona: 'urbana' }).codigoMunicipio).toBe('11001');
  expect(lugar({ departamento: 'Antioquia', municipio: 'Armenia', zona: 'rural' }).codigoMunicipio).toBe('05059');
});

it('dice qué falta o qué está mal, como el servicio', () => {
  expect(resolver({ pais: 'Perú', departamento: 'Antioqia', zona: 'mixta' }).motivos).toEqual([
    'por ahora los puestos son de Colombia, no de «Perú»',
    '«Antioqia» no es un departamento de Colombia',
    'falta el municipio',
    'en zona escribe urbana o rural',
  ]);
});

it('las listas del formulario: municipios de un departamento y localidades de Bogotá', () => {
  expect(municipiosDe('15').map((m) => m.nombre)).toEqual(['Tunja', 'Duitama']);
  expect(localidadesDe('11001')).toHaveLength(20);
  expect(localidadesDe('15001')).toBeNull();
});

it('compara, describe y prepara para mandar; identifica el puesto como el servicio', () => {
  const centro = lugar({ departamento: 'Boyacá', municipio: 'Tunja', localidad: 'Centro', zona: 'urbana' });
  expect(mismaUbicacion(centro, lugar({ departamento: '15', municipio: '15001', zona: 'urbana' }))).toBe(true);
  expect(describirUbicacion(centro)).toBe('Tunja (Boyacá), Centro, zona urbana');
  expect(ubicacionParaEnviar(centro)).toEqual({ pais: 'Colombia', departamento: '15', municipio: '15001', localidad: 'Centro', zona: 'urbana' });
  expect(clavePuesto('  Colegio   ANDINO ')).toBe(clavePuesto('colegio andino'));
  expect(clavePuesto('Sede A/B')).not.toBe(clavePuesto('Sede AB'));
});

describe('Filtrar por la ubicación del puesto', () => {
  const BOGOTA = { pais: 'Colombia', codigoMunicipio: '11001', departamento: 'Bogotá, D.C.', municipio: 'Bogotá, D.C.', localidad: 'Usaquén', zona: 'urbana' };
  const PUESTOS = [{ ubicacion: TUNJA }, { ubicacion: { ...CHIA, localidad: 'Vereda Fagua' } }, { ubicacion: BOGOTA }, { ubicacion: null }];

  it('cumple con cada filtro, y "sin ubicación" son los puestos que no la tienen', () => {
    expect(cumpleUbicacion(TUNJA, {})).toBe(true);
    expect(cumpleUbicacion(null, {})).toBe(true);
    expect(cumpleUbicacion(TUNJA, { departamento: '15', zona: 'urbana' })).toBe(true);
    expect(cumpleUbicacion(TUNJA, { municipio: '25175' })).toBe(false);
    expect(cumpleUbicacion(BOGOTA, { localidad: 'usaquen' })).toBe(true);
    expect(cumpleUbicacion(null, { departamento: '15' })).toBe(false);
    expect(cumpleUbicacion(null, { pais: 'sin_ubicacion' })).toBe(true);
    expect(cumpleUbicacion(TUNJA, { pais: 'sin_ubicacion' })).toBe(false);
  });

  it('las opciones salen de los puestos que hay, y cada una dentro de lo elegido', () => {
    const todas = opcionesDeUbicacion(PUESTOS, {});
    expect(todas.paises).toEqual(['Colombia']);
    expect(todas.hayPuestosSinUbicacion).toBe(true);
    expect(todas.departamentos.map((d) => d.nombre)).toEqual(['Bogotá, D.C.', 'Boyacá', 'Cundinamarca']);
    expect(todas.municipios.map((m) => m.nombre)).toEqual(['Bogotá, D.C.', 'Chía (Cundinamarca)', 'Tunja (Boyacá)']);
    expect(todas.localidades).toEqual(['Usaquén', 'Vereda Fagua']);
    const cundinamarca = opcionesDeUbicacion(PUESTOS, { departamento: '25' });
    expect(cundinamarca.municipios).toEqual([{ codigo: '25175', nombre: 'Chía' }]);
    expect(cundinamarca.localidades).toEqual(['Vereda Fagua']);
  });
});

// Una parte del catálogo del DANE que entrega GET /admin/divipola (con la
// misma forma que services/auth/src/divipola.js), y puestos que ya tienen su
// ubicación, para las pruebas del padrón y de los puestos.
const LOCALIDADES_BOGOTA = [
  'Usaquén', 'Chapinero', 'Santa Fe', 'San Cristóbal', 'Usme', 'Tunjuelito', 'Bosa', 'Kennedy', 'Fontibón', 'Engativá',
  'Suba', 'Barrios Unidos', 'Teusaquillo', 'Los Mártires', 'Antonio Nariño', 'Puente Aranda', 'La Candelaria',
  'Rafael Uribe Uribe', 'Ciudad Bolívar', 'Sumapaz',
];

export const CATALOGO = {
  pais: 'Colombia',
  zonas: ['urbana', 'rural'],
  departamentos: [
    { codigo: '05', nombre: 'Antioquia' }, { codigo: '11', nombre: 'Bogotá, D.C.' }, { codigo: '15', nombre: 'Boyacá' },
    { codigo: '25', nombre: 'Cundinamarca' }, { codigo: '54', nombre: 'Norte de Santander' }, { codigo: '63', nombre: 'Quindío' },
  ],
  municipios: [
    { codigo: '05001', nombre: 'Medellín', departamento: '05' }, { codigo: '05059', nombre: 'Armenia', departamento: '05' },
    { codigo: '11001', nombre: 'Bogotá, D.C.', departamento: '11' }, { codigo: '15001', nombre: 'Tunja', departamento: '15' },
    { codigo: '15238', nombre: 'Duitama', departamento: '15' }, { codigo: '25175', nombre: 'Chía', departamento: '25' },
    { codigo: '54001', nombre: 'San José de Cúcuta', departamento: '54' }, { codigo: '63001', nombre: 'Armenia', departamento: '63' },
  ],
  localidades: { 11001: LOCALIDADES_BOGOTA },
  alias: {
    departamentos: { bogota: '11', bogotadc: '11', valle: '76' },
    municipios: { bogota: '11001', bogotadc: '11001', cucuta: '54001' },
    localidades: { martires: 'Los Mártires', candelaria: 'La Candelaria', rafaeluribe: 'Rafael Uribe Uribe' },
    zonas: { urbana: 'urbana', urbano: 'urbana', u: 'urbana', rural: 'rural', r: 'rural' },
    paises: { colombia: 'Colombia', co: 'Colombia', col: 'Colombia' },
  },
};

export const TUNJA = { id: 1, pais: 'Colombia', codigoMunicipio: '15001', departamento: 'Boyacá', municipio: 'Tunja', localidad: null, zona: 'urbana' };
export const CHIA = { id: 2, pais: 'Colombia', codigoMunicipio: '25175', departamento: 'Cundinamarca', municipio: 'Chía', localidad: null, zona: 'rural' };

// Los puestos de las pruebas, ya con su ubicación (como los devuelve GET /admin/puestos).
export const PUESTOS = ['Sede', 'Sede Norte', 'Sede Sur', 'Colegio Central'].map((pollingPlace, i) => ({
  pollingPlace, votingTables: ['Mesa 1'], voters: 1, ubicacion: { ...(i % 2 ? CHIA : TUNJA), id: i + 1 },
}));

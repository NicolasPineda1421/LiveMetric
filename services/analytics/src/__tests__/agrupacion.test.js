// Cómo se agrupa la participación (agrupacion.js): por puesto, por mesa de
// cada puesto y por la ubicación del puesto.
const { agruparParticipacion, grupoDe, clavePuesto } = require('../agrupacion');

const UBICACIONES = new Map([
  ['colegio andino', { departamento: 'Boyacá', municipio: 'Tunja', codigo_municipio: '15001', zona: 'urbana' }],
  ['escuela el salitre', { departamento: 'Cundinamarca', municipio: 'Chía', codigo_municipio: '25175', zona: 'rural' }],
  ['puesto central', { departamento: 'Bogotá, D.C.', municipio: 'Bogotá, D.C.', codigo_municipio: '11001', zona: 'urbana' }],
]);

describe('El grupo de cada puesto y mesa', () => {
  it('por mesa, con el puesto delante: la "Mesa 1" de dos puestos son dos mesas', () => {
    expect(grupoDe('voting_table', 'Colegio Andino', 'Mesa 1', UBICACIONES)).toBe('Colegio Andino · Mesa 1');
    expect(grupoDe('voting_table', 'Escuela El Salitre', 'Mesa 1', UBICACIONES)).toBe('Escuela El Salitre · Mesa 1');
  });

  it('por departamento, municipio o zona, con la ubicación del puesto (el nombre, como lo identifica el padrón)', () => {
    expect(grupoDe('departamento', 'COLEGIO  ANDINO', 'Mesa 1', UBICACIONES)).toBe('Boyacá');
    expect(grupoDe('municipio', 'Colegio Andino', 'Mesa 1', UBICACIONES)).toBe('Tunja (Boyacá)');
    expect(grupoDe('municipio', 'Puesto Central', 'Mesa 1', UBICACIONES)).toBe('Bogotá, D.C.');
    expect(grupoDe('zona', 'Escuela El Salitre', 'Mesa 2', UBICACIONES)).toBe('Rural');
    expect(grupoDe('zona', 'Puesto Nuevo', 'Mesa 1', UBICACIONES)).toBe('Sin ubicación');
    expect(clavePuesto(' Escuela   El Salitre ')).toBe('escuela el salitre');
  });
});

it('suma registrados y votos por grupo, en orden alfabético y con "Sin ubicación" al final', () => {
  const padron = [
    { puesto: 'Colegio Andino', mesa: 'Mesa 1', registered: 30 },
    { puesto: 'Colegio Andino', mesa: 'Mesa 2', registered: 20 },
    { puesto: 'Escuela El Salitre', mesa: 'Mesa 1', registered: 10 },
    { puesto: 'Puesto Nuevo', mesa: 'Mesa 1', registered: 5 },
    { puesto: 'Puesto Central', mesa: 'Mesa 1', registered: 8 },
  ];
  const votos = [
    { puesto: 'Colegio Andino', mesa: 'Mesa 1', votesCast: 12 },
    { puesto: 'Escuela El Salitre', mesa: 'Mesa 1', votesCast: 4 },
  ];
  expect(agruparParticipacion('municipio', padron, votos, UBICACIONES)).toEqual([
    { group: 'Bogotá, D.C.', registered: 8, votesCast: 0 },
    { group: 'Chía (Cundinamarca)', registered: 10, votesCast: 4 },
    { group: 'Tunja (Boyacá)', registered: 50, votesCast: 12 },
    { group: 'Sin ubicación', registered: 5, votesCast: 0 },
  ]);
  expect(agruparParticipacion('zona', padron, votos, UBICACIONES).map((g) => g.group)).toEqual(['Rural', 'Urbana', 'Sin ubicación']);
  expect(agruparParticipacion('polling_place', padron, votos, UBICACIONES)[0]).toEqual({ group: 'Colegio Andino', registered: 50, votesCast: 12 });
});

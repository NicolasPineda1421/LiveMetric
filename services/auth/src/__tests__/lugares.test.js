// Comparación de puestos y mesas (lugares.js): lo que decide si un jurado
// puede autorizar a un votante asistido.
const { normalizarMesa, mismoPuesto, mismaMesa, juradoCubre, ubicarEnPadron, lugarCanonico } = require('../lugares');

describe('Puestos y mesas escritos de distintas formas', () => {
  it('el mismo puesto, sin importar mayúsculas, tildes ni espacios', () => {
    expect(mismoPuesto('Puesto Central', 'puesto  central ')).toBe(true);
    expect(mismoPuesto('Colegio San José', 'COLEGIO SAN JOSE')).toBe(true);
    expect(mismoPuesto('Puesto Central', 'Punto central')).toBe(false);
  });

  it('"1", "Mesa 1", "MESA N° 1" y "Mesa No. 1" son la misma mesa; la 1 y la 10, no', () => {
    for (const forma of ['1', 'Mesa 1', 'mesa  1', 'MESA N° 1', 'Mesa No. 1', 'Mesa #1', 'Mesa nro 1']) {
      expect(normalizarMesa(forma)).toBe('1');
    }
    expect(mismaMesa('Mesa 1', 'Mesa 10')).toBe(false);
    expect(mismaMesa('Mesa 1/2', 'mesa 1/2')).toBe(true);
    // Una mesa que no es un número también se compara entera.
    expect(mismaMesa('Mesa A', 'a')).toBe(true);
    expect(normalizarMesa('Mesanorte')).toBe('mesanorte');
  });
});

describe('juradoCubre', () => {
  const votante = { pollingPlace: 'Puesto Central', votingTable: 'Mesa 1' };

  it('el jurado de la mesa del votante, aunque esté escrita distinto', () => {
    expect(juradoCubre({ pollingPlace: 'puesto central', votingTable: '1' }, votante)).toBe(true);
    expect(juradoCubre({ pollingPlace: 'Puesto Central', votingTable: 'Mesa 2' }, votante)).toBe(false);
  });

  it('el jurado de todo el puesto (sin mesa) cubre todas sus mesas, pero no otro puesto', () => {
    expect(juradoCubre({ pollingPlace: 'Puesto Central', votingTable: null }, votante)).toBe(true);
    expect(juradoCubre({ pollingPlace: 'Puesto Central', votingTable: null }, { ...votante, votingTable: 'Mesa 7' })).toBe(true);
    expect(juradoCubre({ pollingPlace: 'Puesto Norte', votingTable: null }, votante)).toBe(false);
  });
});

describe('ubicarEnPadron', () => {
  const lugares = [
    { pollingPlace: 'Puesto Central', votingTables: ['Mesa 1', 'Mesa 2'] },
    { pollingPlace: 'Puesto Norte', votingTables: ['Mesa 1'] },
  ];

  it('devuelve el puesto y la mesa tal como figuran en el padrón', () => {
    expect(ubicarEnPadron(lugares, 'puesto central', '1')).toEqual({ pollingPlace: 'Puesto Central', votingTable: 'Mesa 1' });
    expect(ubicarEnPadron(lugares, 'Puesto Norte', '')).toEqual({ pollingPlace: 'Puesto Norte', votingTable: null });
  });

  it('dice qué falta: el padrón, el puesto o la mesa', () => {
    expect(ubicarEnPadron([], 'Puesto Central', 'Mesa 1')).toEqual({ error: 'padron_vacio' });
    expect(ubicarEnPadron(lugares, 'Punto central', 'Mesa 1')).toEqual({ error: 'puesto' });
    expect(ubicarEnPadron(lugares, 'Puesto Norte', 'Mesa 2')).toEqual({ error: 'mesa' });
  });
});

describe('lugarCanonico (votantes nuevos)', () => {
  it('usa el puesto y la mesa como ya figuran, y anota los nuevos para los siguientes del mismo pedido', () => {
    const lugares = [{ pollingPlace: 'Puesto Central', votingTables: ['Mesa 1'] }];
    expect(lugarCanonico(lugares, 'puesto central', '1')).toEqual({ pollingPlace: 'Puesto Central', votingTable: 'Mesa 1' });
    expect(lugarCanonico(lugares, 'PUESTO CENTRAL', 'Mesa 2')).toEqual({ pollingPlace: 'Puesto Central', votingTable: 'Mesa 2' });
    expect(lugarCanonico(lugares, 'Puesto Central', '2')).toEqual({ pollingPlace: 'Puesto Central', votingTable: 'Mesa 2' });
    expect(lugarCanonico(lugares, 'Sede Norte', '3')).toEqual({ pollingPlace: 'Sede Norte', votingTable: '3' });
    expect(lugarCanonico(lugares, 'sede norte', 'Mesa 3')).toEqual({ pollingPlace: 'Sede Norte', votingTable: '3' });
    expect(lugares).toHaveLength(2);
  });
});

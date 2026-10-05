// Lectura del padrón desde un archivo o desde celdas pegadas
// (utils/padronArchivo.js): lo que se valida antes de cargar nada.
import {
  celdaSegura, contarPorPuesto, decodificarTexto, detectarSeparador, enLotes, interpretarPadron, leerFilas, pinesCsv, plantillaCsv,
} from '../utils/padronArchivo.js';

const cedulas = (resultado) => resultado.votantes.map((v) => v.cedula);

describe('Leer el texto', () => {
  it('reconoce el separador: tabulación (celdas pegadas), punto y coma (Excel en español) o coma', () => {
    expect(detectarSeparador('1000000001\tAna\tSede\t1')).toBe('\t');
    expect(detectarSeparador('Cédula;Nombre;Puesto;Mesa\n1;"Pérez, Ana";S;1')).toBe(';');
    expect(detectarSeparador('cedula,nombre,puesto,mesa')).toBe(',');
  });

  it('respeta las comillas: el separador, las comillas dobladas y los saltos de línea adentro de una celda', () => {
    expect(leerFilas('a;"b;c";"dijo ""hola"""\r\n"varias\nlíneas";x\r\n', ';')).toEqual([
      ['a', 'b;c', 'dijo "hola"'],
      ['varias\nlíneas', 'x'],
    ]);
  });

  it('un archivo de Excel en UTF-8 o en la codificación de Windows se lee con sus tildes', () => {
    const utf8 = new TextEncoder().encode('Peña;José');
    const windows1252 = Uint8Array.from([0x50, 0x65, 0xf1, 0x61, 0x3b, 0x4a, 0x6f, 0x73, 0xe9]);
    expect(decodificarTexto(utf8)).toBe('Peña;José');
    expect(decodificarTexto(windows1252)).toBe('Peña;José');
  });
});

describe('Columnas', () => {
  it('con encabezados, en cualquier orden y con otros nombres, e informa las columnas que no se usan', () => {
    const r = interpretarPadron('Mesa;N° de documento;Correo;Puesto de votación;Nombres y apellidos\nMesa 2;1000000001;a@b.co;Sede Norte;Ana Gómez\n');
    expect(r.error).toBeNull();
    expect(r.encabezados).toEqual(['Mesa', 'N° de documento', 'Puesto de votación', 'Nombres y apellidos']);
    expect(r.ignoradas).toEqual(['Correo']);
    expect(r.votantes).toEqual([
      { fila: 2, cedula: '1000000001', fullName: 'Ana Gómez', pollingPlace: 'Sede Norte', votingTable: 'Mesa 2', assisted: false },
    ]);
  });

  it('une las columnas de nombres y de apellidos', () => {
    const r = interpretarPadron('cedula,nombres,apellidos,puesto,mesa\n1000000001,Ana María,Gómez Ruiz,Sede,1');
    expect(r.votantes[0].fullName).toBe('Ana María Gómez Ruiz');
  });

  it('sin encabezados: cédula, nombre, puesto, mesa y, si está, voto asistido', () => {
    const r = interpretarPadron('1000000001\tAna Gómez\tSede\tMesa 1\tsí\n1000000002\tLuis Peña\tSede\tMesa 1\n');
    expect(r.encabezados).toBeNull();
    expect(r.votantes.map((v) => v.assisted)).toEqual([true, false]);
  });

  it('dice qué columna falta, o que faltan columnas', () => {
    expect(interpretarPadron('Cédula;Nombre;Puesto\n1;a;b').error).toBe('Falta la columna de la mesa. La primera fila dice: Cédula, Nombre, Puesto.');
    expect(interpretarPadron('1000000001;Ana Gómez;Sede').error).toMatch(/^Cada fila necesita al menos 4 columnas/);
    expect(interpretarPadron('\n  \n').error).toBe('No hay ningún votante: el archivo o el texto está vacío.');
  });
});

describe('Cada fila', () => {
  it('limpia lo que dejan las hojas de cálculo: espacios, y la cédula con puntos de miles', () => {
    const r = interpretarPadron('1.000.000.001;  Ana   Gómez ; Sede  Norte ;1\n52 123 456;Luis;Sede;2');
    expect(r.votantes[0]).toMatchObject({ cedula: '1000000001', fullName: 'Ana Gómez', pollingPlace: 'Sede Norte' });
    expect(r.votantes[1].cedula).toBe('52123456');
  });

  it('las filas con errores dicen su número y qué corregir, y no se cargan', () => {
    const r = interpretarPadron([
      'Cédula;Nombre;Puesto;Mesa;Voto asistido',
      '1000000001;Ana Gómez;Sede;1;no',
      '12;Lu;Sede;;tal vez',
      '',
      '1,00000E+09;Pedro Ruiz;Sede;1;',
      '1000000003;Marta Díaz;Sede;2;x',
    ].join('\n'));
    expect(cedulas(r)).toEqual(['1000000001', '1000000003']);
    expect(r.errores).toEqual([
      { fila: 3, cedula: '12', motivos: ['la cédula debe tener de 5 a 20 letras, números o guiones', 'el nombre debe tener 3 caracteres o más', 'falta la mesa', 'en voto asistido escribe sí o no'] },
      { fila: 5, cedula: '1,00000E+09', motivos: [expect.stringMatching(/^Excel guardó la cédula en notación científica/)] },
    ]);
    expect(r.votantes[1]).toMatchObject({ fila: 6, assisted: true });
  });

  it('una cédula repetida en el archivo se carga una vez, y se dice en qué fila estaba', () => {
    const r = interpretarPadron('1000000001;Ana Gómez;Sede;1\n1000000002;Luis Peña;Sede;1\n1000000001;Ana G.;Sede;2');
    expect(cedulas(r)).toEqual(['1000000001', '1000000002']);
    expect(r.repetidas).toEqual([{ fila: 3, cedula: '1000000001', primera: 1 }]);
  });
});

describe('Lotes y resumen', () => {
  it('parte la lista en lotes y cuenta los votantes de cada puesto', () => {
    expect(enLotes([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    const r = interpretarPadron('1000000001;Ana;Sede B;1\n1000000002;Luis;Sede Á;1\n1000000003;Eva;sede a;1');
    expect(contarPorPuesto(r.votantes)).toEqual([{ puesto: 'Sede Á', votantes: 2 }, { puesto: 'Sede B', votantes: 1 }]);
  });
});

describe('Archivos para descargar', () => {
  it('la plantilla se puede volver a cargar tal cual', () => {
    const r = interpretarPadron(plantillaCsv());
    expect(r.error).toBeNull();
    expect(r.votantes.map((v) => [v.cedula, v.assisted])).toEqual([['1000000001', false], ['1000000002', true]]);
  });

  it('la lista de PIN neutraliza las celdas que Excel tomaría como fórmulas', () => {
    expect(celdaSegura('=HYPERLINK("http://x")')).toBe('\'=HYPERLINK("http://x")');
    expect(celdaSegura('+57')).toBe("'+57");
    expect(celdaSegura('Ana Gómez')).toBe('Ana Gómez');
    const texto = pinesCsv([{ cedula: '1000000001', pin: '012345', fullName: '@Ana; "la jefa"', pollingPlace: 'Sede', votingTable: 'Mesa 1' }], '5 oct, 18:00');
    expect(texto.startsWith('\uFEFFCédula;Nombre;Puesto de votación;Mesa;PIN;Vence\r\n')).toBe(true);
    expect(texto).toContain('1000000001;"\'@Ana; ""la jefa""";Sede;Mesa 1;012345;5 oct, 18:00');
  });
});

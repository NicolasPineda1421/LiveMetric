// Lectura del padrón desde un archivo o desde celdas pegadas
// (utils/padronArchivo.js): lo que se valida antes de cargar nada.
import {
  celdaSegura, contarPorPuesto, decodificarTexto, detectarSeparador, enLotes, interpretarPadron, leerFilas, pinesCsv, plantillaCsv,
} from '../utils/padronArchivo.js';
import { CATALOGO, CHIA, TUNJA } from './catalogoDePrueba.js';

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
    expect(interpretarPadron('1000000001;Ana Gómez;Sede').error).toMatch(/^Sin encabezados, cada fila lleva 4 columnas \(cédula, nombre, puesto y mesa\), 5 .* o 10 /);
    expect(interpretarPadron('1;Ana Gómez;Sede;1;no;Colombia;Boyacá').error).toMatch(/^Sin encabezados/);
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

describe('Ubicación de los puestos', () => {
  const CONTEXTO = { catalogo: CATALOGO, puestos: [{ pollingPlace: 'Sede Norte', ubicacion: TUNJA }, { pollingPlace: 'Puesto Viejo', ubicacion: null }] };
  const leer = (lineas) => interpretarPadron(['Cédula;Nombre;Puesto;Mesa;Departamento;Municipio;Localidad;Zona', ...lineas].join('\n'), CONTEXTO);
  const motivosDe = (r, fila) => r.errores.find((e) => e.fila === fila)?.motivos;

  it('un puesto que ya la tiene no la necesita; uno nuevo la toma de cualquiera de sus filas', () => {
    const r = leer([
      '1000000001;Ana Gómez;sede norte;1;;;;',
      '1000000002;Luis Peña;Escuela Nueva;1;;;;',
      '1000000003;Eva Ruiz;ESCUELA NUEVA;1;Cundinamarca;Chia;;R',
      '1000000004;Rosa Díaz;Escuela Nueva;2;Cundinamarca;Chía;Vereda Fagua;rural',
    ]);
    expect(r.errores).toEqual([]);
    expect(r.votantes[0]).toMatchObject({ ubicacion: TUNJA, ubicacionNueva: false });
    // La localidad la trae otra fila del mismo puesto, y vale para todas.
    const escuela = { ...CHIA, localidad: 'Vereda Fagua' };
    delete escuela.id;
    expect(r.votantes.slice(1).map((v) => [v.ubicacion, v.ubicacionNueva])).toEqual(Array(3).fill([escuela, true]));
  });

  it('sin ubicación en ninguna de sus filas, las de un puesto nuevo o sin ubicación no se cargan', () => {
    const r = leer(['1000000001;Ana Gómez;Escuela Nueva;1;;;;', '1000000002;Luis Peña;Puesto Viejo;1;;;;']);
    expect(r.votantes).toEqual([]);
    expect(motivosDe(r, 2)).toEqual(['el puesto es nuevo: falta su ubicación (departamento, municipio y zona urbana o rural) en alguna de sus filas']);
    expect(motivosDe(r, 3)[0]).toMatch(/^el puesto «Puesto Viejo» todavía no tiene ubicación: agrega su departamento/);
  });

  it('dice qué está mal en la ubicación, y si no es la que el puesto ya tiene o la de otra fila', () => {
    const r = leer([
      '1000000001;Ana Gómez;Escuela Nueva;1;Boyacá;Medellín;;urbana',
      '1000000002;Luis Peña;Sede Norte;1;Boyacá;Duitama;;urbana',
      '1000000003;Eva Ruiz;Colegio Sur;1;Bogotá;Bogotá;Chapinerito;urbana',
      '1000000004;Rosa Díaz;Colegio Este;1;Boyacá;Tunja;;urbana',
      '1000000005;Juan Mora;Colegio Este;1;Boyacá;Tunja;;rural',
    ]);
    expect(motivosDe(r, 2)).toEqual(['no hay un municipio «Medellín» en Boyacá']);
    expect(motivosDe(r, 3)[0]).toMatch(/^el puesto «Sede Norte» ya está en Tunja \(Boyacá\), zona urbana, y esta fila dice Duitama \(Boyacá\), zona urbana/);
    expect(motivosDe(r, 4)).toEqual(['«Chapinerito» no es una de las 20 localidades de Bogotá, D.C.']);
    expect(motivosDe(r, 6)[0]).toMatch(/^el puesto está en Tunja \(Boyacá\), zona urbana en la fila 5, y esta fila dice Tunja \(Boyacá\), zona rural/);
    expect(r.votantes.map((v) => v.cedula)).toEqual(['1000000004']);
  });

  it('sin encabezados, con las 10 columnas de la plantilla', () => {
    const r = interpretarPadron('1000000001\tAna Gómez\tEscuela Nueva\tMesa 1\tsí\tColombia\tBogotá\tBogotá\tCandelaria\turbana', CONTEXTO);
    expect(r.errores).toEqual([]);
    expect(r.votantes[0]).toMatchObject({ assisted: true, ubicacion: { codigoMunicipio: '11001', localidad: 'La Candelaria', zona: 'urbana' } });
  });
});

describe('Lotes y resumen', () => {
  it('parte la lista en lotes y cuenta los votantes de cada puesto', () => {
    expect(enLotes([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    const r = interpretarPadron('1000000001;Ana;Sede B;1\n1000000002;Luis;Sede Á;1\n1000000003;Eva;sede a;1');
    expect(contarPorPuesto(r.votantes)).toEqual([
      { puesto: 'Sede Á', votantes: 2, ubicacion: null, nuevo: false },
      { puesto: 'Sede B', votantes: 1, ubicacion: null, nuevo: false },
    ]);
  });
});

describe('Archivos para descargar', () => {
  it('la plantilla se puede volver a cargar tal cual: sus dos puestos se registran con su ubicación', () => {
    const r = interpretarPadron(plantillaCsv(), { catalogo: CATALOGO, puestos: [] });
    expect(r.error).toBeNull();
    expect(r.errores).toEqual([]);
    expect(r.votantes.map((v) => [v.cedula, v.assisted])).toEqual([['1000000001', false], ['1000000002', true], ['1000000003', false]]);
    expect(contarPorPuesto(r.votantes).map((p) => [p.puesto, p.votantes, p.nuevo, p.ubicacion.municipio])).toEqual([
      ['Colegio Central', 2, true, 'Tunja'],
      ['Escuela Vereda El Salitre', 1, true, 'Chía'],
    ]);
  });

  it('la lista de PIN neutraliza las celdas que Excel tomaría como fórmulas', () => {
    expect(celdaSegura('=HYPERLINK("http://x")')).toBe('\'=HYPERLINK("http://x")');
    expect(celdaSegura('+57')).toBe("'+57");
    expect(celdaSegura('Ana Gómez')).toBe('Ana Gómez');
    const texto = pinesCsv([{ cedula: '1000000001', pin: '012345', fullName: '@Ana; "la jefa"', pollingPlace: 'Sede', votingTable: 'Mesa 1', vence: '5 oct, 18:00' }]);
    expect(texto.startsWith('\uFEFFCédula;Nombre;Puesto de votación;Mesa;PIN;Vence\r\n')).toBe(true);
    expect(texto).toContain('1000000001;"\'@Ana; ""la jefa""";Sede;Mesa 1;012345;5 oct, 18:00');
  });
});

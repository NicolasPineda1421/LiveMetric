// Carga masiva del padrón desde la pestaña Padrón (CargaPadron.jsx): la
// revisión antes de cargar, los lotes, los PIN para descargar y lo que pasa
// si algo se corta a mitad de camino.
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminDashboard from '../pages/AdminDashboard.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';
import { CATALOGO, PUESTOS } from './catalogoDePrueba.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const SESION = { role: 'admin', token: 'jwt-admin', username: 'admin' };
const TAB = String.fromCharCode(9);
const fila = (...celdas) => celdas.join(TAB);

// Lo que el servicio responde a un lote: todos nuevos, con su PIN.
const respuesta = (votantes, extra = {}) => ({
  inserted: votantes.length,
  duplicates: [],
  accessCodes: votantes.map((v, i) => ({ ...v, pin: String(100000 + i) })),
  pinExpiresAt: '2026-10-20T23:00:00.000Z',
  ...extra,
});

// Los archivos que el panel descarga: el nombre y el texto.
let descargas;
beforeEach(() => {
  reiniciarApiFalsa(api);
  api.listVoters.mockResolvedValue({ voters: [], total: 0, registered: 0 });
  api.listPuestos.mockResolvedValue({ puestos: PUESTOS });
  api.getDivipola.mockResolvedValue(CATALOGO);
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  descargas = [];
  window.URL.createObjectURL = jest.fn((blob) => {
    descargas.push({ blob });
    return 'blob:descarga';
  });
  window.URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function guardarNombre() {
    descargas[descargas.length - 1].nombre = this.download;
  });
});

afterEach(() => jest.restoreAllMocks());

const textoDe = (blob) => new Promise((resolver) => {
  const lector = new FileReader();
  lector.onload = () => resolver(lector.result);
  lector.readAsText(blob);
});

async function abrirCarga() {
  const usuario = userEvent.setup({ applyAccept: false });
  render(<AdminDashboard session={SESION} onLogout={jest.fn()} />);
  await usuario.click(screen.getByRole('button', { name: 'Padrón' }));
  await usuario.click(screen.getByRole('button', { name: 'Varios desde un archivo o Excel' }));
  // Con el catálogo del DANE y los puestos ya traídos se puede revisar.
  await screen.findByText('Elegir un archivo CSV');
  return usuario;
}

async function pegar(usuario, lineas) {
  await usuario.click(screen.getByLabelText('O pegar las celdas copiadas de la hoja de cálculo'));
  await usuario.paste(lineas.join('\n'));
  await usuario.click(screen.getByRole('button', { name: 'Revisar' }));
}

describe('Revisar antes de cargar', () => {
  it('las celdas pegadas: muestra qué se carga y qué filas corregir, y carga solo las que sirven', async () => {
    api.addVoters.mockImplementation((_token, votantes) => Promise.resolve(respuesta(votantes)));
    api.listVoters.mockResolvedValue({ voters: [], total: 0, registered: 0, pinVigenciaHoras: 24 });
    const usuario = await abrirCarga();
    await pegar(usuario, [
      fila('Cédula', 'Nombre', 'Puesto', 'Mesa', 'Voto asistido'),
      fila('1000000001', 'Ana Gómez', 'Sede Norte', 'Mesa 1', 'no'),
      fila('1000000002', 'Luis Peña', 'Sede Norte', '', ''),
      fila('1000000003', 'Eva Ruiz', 'Sede Sur', 'Mesa 2', 'sí'),
    ]);

    expect(screen.getByText('2 votantes listos')).toBeInTheDocument();
    expect(screen.getByText(/después de generarlo, haya o no una elección/).closest('.carga-padron')).not.toBeNull();
    expect(screen.getByText(/1 con voto asistido/)).toBeInTheDocument();
    expect(screen.getByText('1 fila tiene errores: no se cargan')).toBeInTheDocument();
    const errores = screen.getByText('Filas con errores').closest('details');
    expect(within(errores).getByText('falta la mesa').closest('tr')).toHaveTextContent('31000000002');

    await usuario.click(screen.getByRole('button', { name: 'Cargar 2 votantes al padrón' }));
    expect(api.addVoters).toHaveBeenCalledWith('jwt-admin', [
      { cedula: '1000000001', fullName: 'Ana Gómez', pollingPlace: 'Sede Norte', votingTable: 'Mesa 1', assisted: false },
      { cedula: '1000000003', fullName: 'Eva Ruiz', pollingPlace: 'Sede Sur', votingTable: 'Mesa 2', assisted: true },
    ], 'archivo');
    expect(await screen.findByText('Se agregaron 2 votantes al padrón. 1 fila con errores no se cargó.')).toBeInTheDocument();
    const pines = screen.getByText('PIN de acceso generados').closest('.panel');
    expect(within(pines).getByText('Eva Ruiz').closest('tr')).toHaveTextContent('Sede Sur — Mesa 2100001');
    expect(api.listVoters).toHaveBeenCalledTimes(2); // recargó el padrón al terminar
  });

  it('dice qué columna falta, sin pasar a la revisión', async () => {
    const usuario = await abrirCarga();
    await pegar(usuario, [fila('Cédula', 'Nombre', 'Puesto'), fila('1000000001', 'Ana Gómez', 'Sede')]);
    expect(screen.getByText('Falta la columna de la mesa. La primera fila dice: Cédula, Nombre, Puesto.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cargar/ })).not.toBeInTheDocument();
  });

  it('lee un CSV de Excel en la codificación de Windows; un libro .xlsx se rechaza diciendo cómo guardarlo', async () => {
    const usuario = await abrirCarga();
    const entrada = screen.getByLabelText(/Elegir un archivo CSV/);
    await usuario.upload(entrada, new File([new Uint8Array([0x78, 0x2e, 0x78, 0x6c, 0x73, 0x78])], 'padron.xlsx'));
    expect(screen.getByText(/Ese es un libro de Excel o de LibreOffice: guárdalo como CSV/)).toBeInTheDocument();

    // "1000000001;José Peña;Sede;1" en windows-1252: é = E9, ñ = F1.
    const bytes = [...'1000000001;Jos'].map((c) => c.charCodeAt(0))
      .concat([0xe9, 0x20, 0x50, 0x65, 0xf1, 0x61], [...';Sede;1\r\n'].map((c) => c.charCodeAt(0)));
    await usuario.upload(entrada, new File([new Uint8Array(bytes)], 'padron.csv', { type: 'text/csv' }));
    expect(await screen.findByText('padron.csv')).toBeInTheDocument();
    expect(screen.getByText('José Peña')).toBeInTheDocument();
  });

  it('descarga la plantilla, que se puede volver a cargar tal cual', async () => {
    const usuario = await abrirCarga();
    await usuario.click(screen.getByRole('button', { name: 'Descargar la plantilla (CSV)' }));
    expect(descargas[0].nombre).toBe('plantilla-padron.csv');
    expect(await textoDe(descargas[0].blob)).toMatch(/^Cédula;Nombre completo;Puesto de votación;Mesa;Voto asistido;País;Departamento;Municipio;Localidad;Zona\r\n/);
  });
});

describe('Ubicación de los puestos', () => {
  it('un puesto nuevo toma la ubicación de una de sus filas, y se manda con cada votante de ese puesto', async () => {
    api.addVoters.mockImplementation((_t, lote) => Promise.resolve(respuesta(lote)));
    const usuario = await abrirCarga();
    await pegar(usuario, [
      fila('Cédula', 'Nombre', 'Puesto', 'Mesa', 'Departamento', 'Ciudad', 'Localidad', 'Zona'),
      fila('1000000001', 'Ana Gómez', 'escuela nueva', 'Mesa 1', '', '', '', ''),
      fila('1000000002', 'Luis Peña', 'Escuela Nueva', 'Mesa 1', 'Bogotá', 'bogota', 'candelaria', 'urbano'),
      fila('1000000003', 'Eva Ruiz', 'Sede', 'Mesa 1', '', '', '', ''),
    ]);

    expect(screen.getByText('2 puestos, 1 se registra con la ubicación del archivo')).toBeInTheDocument();
    const tabla = screen.getByText('Puestos y su ubicación').closest('details');
    expect(within(tabla).getByText('escuela nueva').closest('tr')).toHaveTextContent('Bogotá, D.C., La Candelaria, zona urbana2Se registra');
    expect(within(tabla).getByText('Sede').closest('tr')).toHaveTextContent('Tunja (Boyacá), zona urbana1Ya registrado');

    await usuario.click(screen.getByRole('button', { name: 'Cargar 3 votantes al padrón' }));
    const bogota = { pais: 'Colombia', departamento: '11', municipio: '11001', localidad: 'La Candelaria', zona: 'urbana' };
    expect(api.addVoters).toHaveBeenCalledWith('jwt-admin', [
      { cedula: '1000000001', fullName: 'Ana Gómez', pollingPlace: 'escuela nueva', votingTable: 'Mesa 1', assisted: false, ...bogota },
      { cedula: '1000000002', fullName: 'Luis Peña', pollingPlace: 'Escuela Nueva', votingTable: 'Mesa 1', assisted: false, ...bogota },
      { cedula: '1000000003', fullName: 'Eva Ruiz', pollingPlace: 'Sede', votingTable: 'Mesa 1', assisted: false },
    ], 'archivo');
    await screen.findByText('Se agregaron 3 votantes al padrón.');
    // Al abrir el Padrón y la carga, y otra vez cada uno después de cargar: los puestos nuevos ya tienen ubicación.
    expect(api.listPuestos).toHaveBeenCalledTimes(4);
  });

  it('las filas de un puesto sin ubicación, o con una que no existe o que no es la suya, no se cargan', async () => {
    const usuario = await abrirCarga();
    await pegar(usuario, [
      fila('Cédula', 'Nombre', 'Puesto', 'Mesa', 'Departamento', 'Municipio', 'Zona'),
      fila('1000000001', 'Ana Gómez', 'Puesto Sin Datos', 'Mesa 1', '', '', ''),
      fila('1000000002', 'Luis Peña', 'Otro Puesto', 'Mesa 1', 'Boyacá', 'Medellín', 'urbana'),
      fila('1000000003', 'Eva Ruiz', 'Sede', 'Mesa 1', 'Boyacá', 'Duitama', 'urbana'),
      fila('1000000004', 'Rosa Díaz', 'Sede', 'Mesa 1', 'Boyacá', 'Tunja', 'urbana'),
    ]);

    expect(screen.getByText('1 votante listo')).toBeInTheDocument();
    const errores = screen.getByText('Filas con errores').closest('details');
    expect(within(errores).getByText(/^el puesto es nuevo: falta su ubicación/).closest('tr')).toHaveTextContent(/^21000000001/);
    expect(within(errores).getByText('no hay un municipio «Medellín» en Boyacá')).toBeInTheDocument();
    expect(within(errores).getByText(/^el puesto «Sede» ya está en Tunja \(Boyacá\), zona urbana, y esta fila dice Duitama \(Boyacá\), zona urbana/)).toBeInTheDocument();
  });
});

describe('Cargar en lotes', () => {
  // n votantes de la mesa 1, sin encabezados: la fila i es la del votante i.
  const votantes = (n) => Array.from({ length: n }, (_, i) => fila(`${2000000000 + i}`, `Votante ${i}`, 'Sede', 'Mesa 1'));

  it('de a 100, cada PIN con el vencimiento de su lote; suma los repetidos y deja descargar todos los PIN', async () => {
    api.addVoters
      .mockImplementationOnce((_t, lote) => Promise.resolve(respuesta(lote)))
      .mockImplementationOnce((_t, lote) => Promise.resolve(respuesta(lote.slice(2), {
        duplicates: lote.slice(0, 2).map((v) => v.cedula),
        pinExpiresAt: '2026-10-20T23:05:00.000Z',
      })));
    const usuario = await abrirCarga();
    await pegar(usuario, votantes(150));
    await usuario.click(screen.getByRole('button', { name: 'Cargar 150 votantes al padrón' }));

    expect(await screen.findByText('Se agregaron 148 votantes al padrón. 2 ya estaban y no se modificaron.')).toBeInTheDocument();
    expect(api.addVoters.mock.calls.map((c) => c[1].length)).toEqual([100, 50]);
    expect(api.addVoters.mock.calls.map((c) => c[2])).toEqual(['archivo', 'archivo']);
    expect(screen.getByText('PIN de acceso generados').closest('.panel')).toHaveTextContent(/Vencen entre el .+ y el /);
    expect(screen.getByText('Y 98 más: están todos en el archivo para descargar.')).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Descargar los 148 PIN (CSV)' }));
    expect(descargas[0].nombre).toMatch(/^pin-padron-[\d-]+\.csv$/);
    const lineas = (await textoDe(descargas[0].blob)).trim().split('\r\n');
    expect(lineas).toHaveLength(149);
    expect(lineas[1]).toMatch(/^2000000000;Votante 0;Sede;Mesa 1;100000;.+/);
    expect(lineas[1].split(';')[5]).not.toBe(lineas[148].split(';')[5]); // el último lote vence 5 minutos después
  });

  it('si un lote falla, dice desde qué fila, y los PIN de los lotes ya cargados siguen ahí', async () => {
    api.addVoters
      .mockImplementationOnce((_t, lote) => Promise.resolve(respuesta(lote)))
      .mockRejectedValueOnce(new Error('Error interno del servidor'));
    const usuario = await abrirCarga();
    await pegar(usuario, votantes(150));
    await usuario.click(screen.getByRole('button', { name: 'Cargar 150 votantes al padrón' }));

    expect(await screen.findByText(/La carga se detuvo en el lote que empieza en la fila 101: Error interno del servidor/)).toBeInTheDocument();
    expect(screen.getByText('Se agregaron 100 votantes al padrón.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar los 100 PIN (CSV)' })).toBeInTheDocument();
  });

  it('con el límite de operaciones (429) espera a que se renueve el cupo y reintenta el mismo lote', async () => {
    api.addVoters
      .mockRejectedValueOnce(Object.assign(new Error('Error 429'), { status: 429, retryAfter: 1 }))
      .mockImplementationOnce((_t, lote) => Promise.resolve(respuesta(lote)));
    const usuario = await abrirCarga();
    await pegar(usuario, votantes(3));
    await usuario.click(screen.getByRole('button', { name: 'Cargar 3 votantes al padrón' }));
    expect(await screen.findByText(/Pausa por el límite de operaciones del panel: sigue en 1 s/)).toBeInTheDocument();
    expect(await screen.findByText('Se agregaron 3 votantes al padrón.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(api.addVoters.mock.calls[1][1]).toEqual(api.addVoters.mock.calls[0][1]);
  });

  it('mientras carga, salir de la pestaña pregunta antes; y «Detener» corta después del lote en curso', async () => {
    let terminarLote;
    api.addVoters.mockImplementationOnce((_t, lote) => new Promise((resolver) => { terminarLote = () => resolver(respuesta(lote)); }));
    const usuario = await abrirCarga();
    await pegar(usuario, votantes(150));
    await usuario.click(screen.getByRole('button', { name: 'Cargar 150 votantes al padrón' }));
    expect(screen.getByRole('status')).toHaveTextContent('Cargando: 0 de 150 votantes.');

    window.confirm.mockReturnValueOnce(false);
    await usuario.click(screen.getByRole('button', { name: 'Auditoría' }));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringMatching(/^Se está cargando el padrón/));
    expect(screen.getByRole('status')).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Detener después de este lote' }));
    await act(async () => terminarLote());
    expect(await screen.findByText('Se agregaron 100 votantes al padrón. Carga detenida: 50 quedaron sin cargar.')).toBeInTheDocument();
    expect(api.addVoters).toHaveBeenCalledTimes(1);
  });
});

describe('Los dos modos', () => {
  it('volver a «Uno por uno» no borra los PIN recién cargados', async () => {
    api.addVoters.mockImplementation((_t, lote) => Promise.resolve(respuesta(lote)));
    const usuario = await abrirCarga();
    await pegar(usuario, [fila('1000000001', 'Ana Gómez', 'Sede', 'Mesa 1')]);
    await usuario.click(screen.getByRole('button', { name: 'Cargar 1 votante al padrón' }));
    await screen.findByText('Se agregó 1 votante al padrón.');
    await usuario.click(screen.getByRole('button', { name: 'Uno por uno' }));
    expect(screen.getByRole('button', { name: 'Descargar el PIN (CSV)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Cédula')).toBeInTheDocument();
  });
});

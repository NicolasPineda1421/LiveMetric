// Pestaña "Puestos" (PuestosTab.jsx): la ubicación de cada puesto, los que
// todavía no la tienen, corregirla y quitar un puesto sin votantes.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminDashboard from '../pages/AdminDashboard.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';
import { CATALOGO, CHIA, TUNJA } from './catalogoDePrueba.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const SESION = { role: 'admin', token: 'jwt-admin', username: 'admin' };
const mesas = (...lista) => lista.map(([nombre, votantes, jurados = 0]) => ({ nombre, votantes, jurados }));
const PUESTOS = [
  {
    pollingPlace: 'Colegio Central', votingTables: ['Mesa 1', 'Mesa 2', 'Mesa 3'], voters: 120, ubicacion: { ...TUNJA, localidad: 'Centro' },
    mesas: mesas(['Mesa 1', 80, 1], ['Mesa 2', 40], ['Mesa 3', 0]),
  },
  { pollingPlace: 'Escuela El Salitre', votingTables: ['Mesa 1'], voters: 35, ubicacion: CHIA, mesas: mesas(['Mesa 1', 35]) },
  { pollingPlace: 'Puesto Antiguo', votingTables: ['Mesa 1'], voters: 8, ubicacion: null, mesas: mesas(['Mesa 1', 8]) },
  { pollingPlace: 'Puesto Cerrado', votingTables: [], voters: 0, ubicacion: { ...TUNJA, id: 9 }, mesas: [] },
];

beforeEach(() => {
  reiniciarApiFalsa(api);
  api.listPuestos.mockResolvedValue({ puestos: PUESTOS });
  api.getDivipola.mockResolvedValue(CATALOGO);
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => jest.restoreAllMocks());

async function abrir() {
  const usuario = userEvent.setup();
  render(<AdminDashboard session={SESION} onLogout={jest.fn()} />);
  await usuario.click(screen.getByRole('button', { name: 'Puestos' }));
  await screen.findByText('Colegio Central');
  return usuario;
}
const filaDe = (puesto) => screen.getByText(puesto, { selector: 'td' }).closest('tr');

it('lista los puestos con su ubicación, primero los que no la tienen, y avisa cuántos faltan', async () => {
  await abrir();
  expect(screen.getByText('4 puestos en 2 municipios · 2 urbanos y 1 rural')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('1 puesto no tiene ubicación todavía: no se le pueden agregar votantes hasta que la tenga.');
  const filas = screen.getAllByRole('row').slice(1).map((f) => f.cells[0].textContent);
  expect(filas).toEqual(['Puesto Antiguo', 'Colegio Central', 'Puesto Cerrado', 'Escuela El Salitre']);
  expect(filaDe('Colegio Central')).toHaveTextContent('Colegio CentralBoyacáTunjaCentroUrbana3120');
  expect(filaDe('Puesto Antiguo')).toHaveTextContent('Sin ubicación');
  // Solo se puede quitar el que ya no tiene votantes.
  expect(within(filaDe('Colegio Central')).queryByRole('button', { name: 'Quitar' })).not.toBeInTheDocument();
  expect(within(filaDe('Puesto Cerrado')).getByRole('button', { name: 'Quitar' })).toBeInTheDocument();
});

it('filtra por país, departamento, municipio, localidad y zona, y dice cuántos se muestran', async () => {
  const usuario = await abrir();
  const filas = () => screen.getAllByRole('row').slice(1).map((f) => f.cells[0].textContent);
  await usuario.selectOptions(screen.getByLabelText('Departamento'), 'Boyacá');
  expect(filas()).toEqual(['Colegio Central', 'Puesto Cerrado']);
  await usuario.selectOptions(screen.getByLabelText('Localidad'), 'Centro');
  expect(filas()).toEqual(['Colegio Central']);
  expect(screen.getByText(/se muestran 1 puesto, con 120 votantes$/)).toBeInTheDocument();
  await usuario.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
  await usuario.selectOptions(screen.getByLabelText('Zona'), 'Rural');
  expect(filas()).toEqual(['Escuela El Salitre']);
  await usuario.selectOptions(screen.getByLabelText('País'), 'Sin ubicación');
  expect(filas()).toEqual(['Puesto Antiguo']);
});

it('le pone la ubicación a un puesto que no la tiene, con las listas del DANE', async () => {
  api.savePuestoUbicacion.mockResolvedValue({ pollingPlace: 'Puesto Antiguo', ubicacion: { ...TUNJA, localidad: 'Norte' } });
  const usuario = await abrir();
  await usuario.click(within(filaDe('Puesto Antiguo')).getByRole('button', { name: 'Poner ubicación' }));
  const formulario = screen.getByRole('form', { name: 'Ubicación de Puesto Antiguo' });
  await usuario.selectOptions(within(formulario).getByLabelText('Departamento'), 'Boyacá');
  expect(within(within(formulario).getByLabelText('Municipio')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Elige…', 'Duitama', 'Tunja']);
  await usuario.selectOptions(within(formulario).getByLabelText('Municipio'), 'Tunja');
  await usuario.type(within(formulario).getByLabelText('Localidad (opcional)'), ' Norte ');
  await usuario.selectOptions(within(formulario).getByLabelText('Zona'), 'Urbana');
  await usuario.click(within(formulario).getByRole('button', { name: 'Guardar ubicación' }));

  expect(api.savePuestoUbicacion).toHaveBeenCalledWith('jwt-admin', 'Puesto Antiguo', {
    pais: 'Colombia', departamento: '15', municipio: '15001', localidad: 'Norte', zona: 'urbana',
  });
  expect(await screen.findByText('Ubicación de «Puesto Antiguo» guardada: Tunja (Boyacá), Norte, zona urbana.')).toBeInTheDocument();
  expect(api.listPuestos).toHaveBeenCalledTimes(2);
});

it('al corregir una ubicación parte de la que tiene, y un error del servicio se muestra', async () => {
  api.savePuestoUbicacion.mockRejectedValue(new Error('No hay un municipio «x» en Boyacá.'));
  const usuario = await abrir();
  await usuario.click(within(filaDe('Colegio Central')).getByRole('button', { name: 'Cambiar ubicación' }));
  const formulario = screen.getByRole('form', { name: 'Ubicación de Colegio Central' });
  expect(within(formulario).getByLabelText('Municipio')).toHaveValue('15001');
  expect(within(formulario).getByLabelText('Localidad (opcional)')).toHaveValue('Centro');
  expect(within(formulario).getByText(/no cambia a los votantes ni los votos del puesto/)).toBeInTheDocument();
  await usuario.click(within(formulario).getByRole('button', { name: 'Guardar ubicación' }));
  expect(await screen.findByText('No hay un municipio «x» en Boyacá.')).toBeInTheDocument();
  await usuario.click(within(formulario).getByRole('button', { name: 'Cancelar' }));
  expect(screen.queryByRole('form', { name: 'Ubicación de Colegio Central' })).not.toBeInTheDocument();
});

it('quitar un puesto sin votantes pide confirmación', async () => {
  api.deletePuesto.mockResolvedValue(null);
  const usuario = await abrir();
  window.confirm.mockReturnValueOnce(false);
  await usuario.click(within(filaDe('Puesto Cerrado')).getByRole('button', { name: 'Quitar' }));
  expect(api.deletePuesto).not.toHaveBeenCalled();
  await usuario.click(within(filaDe('Puesto Cerrado')).getByRole('button', { name: 'Quitar' }));
  expect(api.deletePuesto).toHaveBeenCalledWith('jwt-admin', 9);
  expect(await screen.findByText('El puesto «Puesto Cerrado» fue quitado.')).toBeInTheDocument();
});

describe('Mesas de un puesto', () => {
  async function abrirMesas(puesto = 'Colegio Central') {
    const usuario = await abrir();
    await usuario.click(within(filaDe(puesto)).getByRole('button', { name: 'Mesas' }));
    return { usuario, panel: screen.getByRole('region', { name: `Mesas de ${puesto}` }) };
  }
  const filaDeMesa = (panel, mesa) => within(panel).getByText(mesa, { selector: 'td' }).closest('tr');

  it('muestra cada mesa con sus votantes y jurados, y solo deja eliminar las que no tienen ninguno', async () => {
    const { usuario, panel } = await abrirMesas();
    expect(within(filaDe('Colegio Central')).getByRole('button', { name: 'Mesas' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getAllByRole('row').slice(1).map((f) => [...f.cells].slice(0, 3).map((c) => c.textContent)))
      .toEqual([['Mesa 1', '80', '1'], ['Mesa 2', '40', '0'], ['Mesa 3', '0', '0']]);
    expect(within(filaDeMesa(panel, 'Mesa 1')).queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(within(filaDeMesa(panel, 'Mesa 2')).queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(within(filaDeMesa(panel, 'Mesa 3')).getByRole('button', { name: 'Eliminar' })).toBeInTheDocument();
    // El mismo botón las cierra; un puesto sin mesas lo dice.
    await usuario.click(within(filaDe('Colegio Central')).getByRole('button', { name: 'Mesas' }));
    expect(screen.queryByRole('region', { name: 'Mesas de Colegio Central' })).not.toBeInTheDocument();
    await usuario.click(within(filaDe('Puesto Cerrado')).getByRole('button', { name: 'Mesas' }));
    expect(screen.getByRole('region', { name: 'Mesas de Puesto Cerrado' })).toHaveTextContent('Este puesto todavía no tiene mesas.');
  });

  it('crea una mesa y vuelve a pedir los puestos', async () => {
    api.createMesa.mockResolvedValue({ pollingPlace: 'Colegio Central', votingTable: 'Mesa 4' });
    const { usuario, panel } = await abrirMesas();
    const crear = within(panel).getByRole('form', { name: 'Crear una mesa en Colegio Central' });
    expect(within(crear).getByRole('button', { name: 'Crear mesa' })).toBeDisabled();
    await usuario.type(within(crear).getByLabelText('Mesa nueva'), 'Mesa 4');
    await usuario.click(within(crear).getByRole('button', { name: 'Crear mesa' }));
    expect(api.createMesa).toHaveBeenCalledWith('jwt-admin', 'Colegio Central', 'Mesa 4');
    expect(await screen.findByText('Se creó la mesa «Mesa 4» en «Colegio Central»: ya se le pueden asignar votantes y jurados.')).toBeInTheDocument();
    expect(within(crear).getByLabelText('Mesa nueva')).toHaveValue('');
    expect(api.listPuestos).toHaveBeenCalledTimes(2);
  });

  it('renombra una mesa y dice en cuántos votantes y jurados la cambió', async () => {
    api.renameMesa.mockResolvedValue({ pollingPlace: 'Colegio Central', votingTable: 'Mesa A', votantes: 80, jurados: 1 });
    const { usuario, panel } = await abrirMesas();
    await usuario.click(within(filaDeMesa(panel, 'Mesa 1')).getByRole('button', { name: 'Renombrar' }));
    const formulario = within(panel).getByRole('form', { name: 'Renombrar Mesa 1' });
    const campo = within(formulario).getByLabelText('Nombre nuevo de «Mesa 1»');
    expect(campo).toHaveValue('Mesa 1');
    await usuario.clear(campo);
    await usuario.type(campo, 'Mesa A');
    await usuario.click(within(formulario).getByRole('button', { name: 'Guardar nombre' }));
    expect(api.renameMesa).toHaveBeenCalledWith('jwt-admin', 'Colegio Central', 'Mesa 1', 'Mesa A');
    expect(await screen.findByText('La mesa «Mesa 1» de «Colegio Central» ahora se llama «Mesa A»: se cambió en 80 votantes y 1 jurado.')).toBeInTheDocument();
    expect(within(panel).queryByRole('form', { name: 'Renombrar Mesa 1' })).not.toBeInTheDocument();
  });

  it('si el servicio no la renombra (por ejemplo, con una votación en curso), lo dice y el formulario sigue abierto', async () => {
    api.renameMesa.mockRejectedValue(new Error('Hay una votación en curso: renombra la mesa cuando termine.'));
    const { usuario, panel } = await abrirMesas();
    await usuario.click(within(filaDeMesa(panel, 'Mesa 2')).getByRole('button', { name: 'Renombrar' }));
    const formulario = within(panel).getByRole('form', { name: 'Renombrar Mesa 2' });
    await usuario.type(within(formulario).getByLabelText('Nombre nuevo de «Mesa 2»'), 'B');
    await usuario.click(within(formulario).getByRole('button', { name: 'Guardar nombre' }));
    expect(await screen.findByText('Hay una votación en curso: renombra la mesa cuando termine.')).toBeInTheDocument();
    expect(within(panel).getByRole('form', { name: 'Renombrar Mesa 2' })).toBeInTheDocument();
    await usuario.click(within(formulario).getByRole('button', { name: 'Cancelar' }));
    expect(within(panel).queryByRole('form', { name: 'Renombrar Mesa 2' })).not.toBeInTheDocument();
  });

  it('eliminar una mesa vacía pide confirmación', async () => {
    api.deleteMesa.mockResolvedValue(null);
    const { usuario, panel } = await abrirMesas();
    window.confirm.mockReturnValueOnce(false);
    await usuario.click(within(filaDeMesa(panel, 'Mesa 3')).getByRole('button', { name: 'Eliminar' }));
    expect(api.deleteMesa).not.toHaveBeenCalled();
    await usuario.click(within(filaDeMesa(panel, 'Mesa 3')).getByRole('button', { name: 'Eliminar' }));
    expect(api.deleteMesa).toHaveBeenCalledWith('jwt-admin', 'Colegio Central', 'Mesa 3');
    expect(await screen.findByText('Se eliminó la mesa «Mesa 3» de «Colegio Central».')).toBeInTheDocument();
  });
});

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
const PUESTOS = [
  { pollingPlace: 'Colegio Central', votingTables: ['Mesa 1', 'Mesa 2'], voters: 120, ubicacion: { ...TUNJA, localidad: 'Centro' } },
  { pollingPlace: 'Escuela El Salitre', votingTables: ['Mesa 1'], voters: 35, ubicacion: CHIA },
  { pollingPlace: 'Puesto Antiguo', votingTables: ['Mesa 1'], voters: 8, ubicacion: null },
  { pollingPlace: 'Puesto Cerrado', votingTables: [], voters: 0, ubicacion: { ...TUNJA, id: 9 } },
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
  expect(filaDe('Colegio Central')).toHaveTextContent('Colegio CentralBoyacáTunjaCentroUrbana2120');
  expect(filaDe('Puesto Antiguo')).toHaveTextContent('Sin ubicación');
  // Solo se puede quitar el que ya no tiene votantes.
  expect(within(filaDe('Colegio Central')).queryByRole('button', { name: 'Quitar' })).not.toBeInTheDocument();
  expect(within(filaDe('Puesto Cerrado')).getByRole('button', { name: 'Quitar' })).toBeInTheDocument();
});

it('filtra por departamento o por los que no tienen ubicación', async () => {
  const usuario = await abrir();
  await usuario.selectOptions(screen.getByLabelText('Mostrar'), 'Cundinamarca');
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(filaDe('Escuela El Salitre')).toBeInTheDocument();
  await usuario.selectOptions(screen.getByLabelText('Mostrar'), 'Sin ubicación');
  expect(screen.getAllByRole('row').slice(1).map((f) => f.cells[0].textContent)).toEqual(['Puesto Antiguo']);
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

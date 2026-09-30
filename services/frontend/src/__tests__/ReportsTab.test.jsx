// Editor de tableros del administrador: agregar, configurar y quitar
// widgets, dónde se ubica cada uno, y guardar o borrar el tablero.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReportsTab from '../pages/ReportsTab.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const SESION = { role: 'admin', token: 'jwt-admin', username: 'admin' };
const nombreDelTablero = () => screen.getByPlaceholderText('Nombre del tablero');
const campo = (etiqueta) => screen.getByText(etiqueta, { selector: 'label' }).nextElementSibling;
const guardado = () => (api.createDashboard.mock.calls[0] || api.updateDashboard.mock.calls[0])[3].widgets;

async function abrir({ tableros = [] } = {}) {
  api.listAllElections.mockResolvedValue([{ id: 3, title: 'Consejo', status: 'active' }]);
  api.listDashboards.mockResolvedValue({ dashboards: tableros });
  const usuario = userEvent.setup();
  render(<ReportsTab session={SESION} />);
  await usuario.selectOptions(await screen.findByRole('combobox'), '3');
  return usuario;
}

async function agregar(usuario, tipo, { fuente, titulo } = {}) {
  await usuario.click(screen.getByRole('button', { name: `+ ${tipo}` }));
  if (fuente) await usuario.selectOptions(campo('Fuente de datos'), fuente);
  if (titulo) {
    await usuario.clear(campo('Título del widget'));
    await usuario.type(campo('Título del widget'), titulo);
  }
  await usuario.click(screen.getByRole('button', { name: 'Agregar al tablero' }));
}

beforeEach(() => {
  reiniciarApiFalsa(api);
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => jest.restoreAllMocks());

it('arma un tablero nuevo y lo guarda con sus widgets y fuentes', async () => {
  api.createDashboard.mockResolvedValue({ id: 8 });
  const usuario = await abrir();
  await usuario.clear(nombreDelTablero());
  await usuario.type(nombreDelTablero(), 'Seguimiento');
  await agregar(usuario, 'Tarjeta KPI');
  await agregar(usuario, 'Tabla', { fuente: 'participation' });
  await usuario.click(screen.getByRole('button', { name: 'Guardar tablero' }));

  expect(api.createDashboard).toHaveBeenCalledWith('jwt-admin', '3', 'Seguimiento', expect.any(Object));
  expect(guardado()).toEqual([
    expect.objectContaining({ type: 'kpi', dataSource: 'results', title: 'Resultados', params: {} }),
    expect.objectContaining({ type: 'table', dataSource: 'participation', title: 'Participación por puesto/mesa', params: { groupBy: 'polling_place' } }),
  ]);
  expect(await screen.findByText('Tablero guardado correctamente.')).toBeInTheDocument();
  // Guardado, ya tiene id: aparecen exportar y borrar.
  expect(screen.getByRole('button', { name: 'Borrar tablero' })).toBeInTheDocument();
});

it('ubica cada widget nuevo al lado del anterior, o en una fila nueva si no cabe', async () => {
  api.createDashboard.mockResolvedValue({ id: 8 });
  const usuario = await abrir();
  await agregar(usuario, 'Tarjeta KPI'); // 3 columnas de 12
  await agregar(usuario, 'Tabla'); // 6 más: cabe en la misma fila
  await agregar(usuario, 'Gráfico de barras'); // 5 más ya no: fila nueva, debajo de todo
  await usuario.click(screen.getByRole('button', { name: 'Guardar tablero' }));

  expect(guardado().map((w) => w.grid)).toEqual([
    { x: 0, y: 0, w: 3, h: 2 },
    { x: 3, y: 0, w: 6, h: 4 },
    { x: 0, y: 4, w: 5, h: 4 },
  ]);
  const ids = guardado().map((w) => w.id);
  expect(new Set(ids).size).toBe(3);
});

it('el título sigue a la fuente elegida, salvo que se haya escrito a mano', async () => {
  const usuario = await abrir();
  await usuario.click(screen.getByRole('button', { name: '+ Gráfico de línea' }));
  expect(campo('Título del widget')).toHaveValue('Evolución de votos en el tiempo');
  await usuario.selectOptions(campo('Fuente de datos'), 'leadTimeline');
  expect(campo('Título del widget')).toHaveValue('Momento de definición');

  await usuario.clear(campo('Título del widget'));
  await usuario.type(campo('Título del widget'), 'Mi gráfico');
  await usuario.selectOptions(campo('Fuente de datos'), 'timeseries');
  expect(campo('Título del widget')).toHaveValue('Mi gráfico');
  // La evolución en el tiempo se puede agrupar por hora o por día.
  await usuario.selectOptions(campo('Agrupar por'), 'day');
  await usuario.click(screen.getByRole('button', { name: 'Agregar al tablero' }));

  api.createDashboard.mockResolvedValue({ id: 8 });
  await usuario.click(screen.getByRole('button', { name: 'Guardar tablero' }));
  expect(guardado()[0]).toMatchObject({ type: 'line', title: 'Mi gráfico', dataSource: 'timeseries', params: { interval: 'day' } });
});

it('cada tipo de widget ofrece solo las fuentes que sabe mostrar', async () => {
  const usuario = await abrir();
  await usuario.click(screen.getByRole('button', { name: '+ Gráfico de torta' }));
  const fuentes = within(campo('Fuente de datos')).getAllByRole('option').map((o) => o.value);
  expect(fuentes).toEqual(['results', 'participation', 'suspiciousAccess']);
  await usuario.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(screen.queryByText('Fuente de datos')).not.toBeInTheDocument();
});

it('abre un tablero guardado, lo edita y lo actualiza (no crea otro)', async () => {
  api.getDashboard.mockResolvedValue({
    id: 5,
    name: 'Cierre',
    layout: { widgets: [
      { id: 'a', type: 'kpi', title: 'Total', dataSource: 'results', params: {}, grid: { x: 0, y: 0, w: 3, h: 2 } },
      { id: 'b', type: 'table', title: 'Auditoría', dataSource: 'audit', params: {}, grid: { x: 3, y: 0, w: 6, h: 4 } },
    ] },
  });
  api.updateDashboard.mockResolvedValue({});
  const usuario = await abrir({ tableros: [{ id: 5, name: 'Cierre' }] });
  await screen.findByRole('option', { name: 'Cierre' });
  await usuario.selectOptions(screen.getAllByRole('combobox')[1], '5');
  await waitFor(() => expect(nombreDelTablero()).toHaveValue('Cierre'));

  // Cambia el título del primero y quita el segundo. Los botones ⚙ y ✕
  // están dentro del asa de arrastre del widget: con userEvent, el
  // mousedown/mouseup del clic llega a react-grid-layout, que en jsdom (sin
  // layout) no puede empezar el arrastre y falla al terminarlo. Un click
  // directo prueba lo mismo: qué hace cada botón.
  fireEvent.click(screen.getAllByTitle('Configurar')[0]);
  await usuario.clear(campo('Título del widget'));
  await usuario.type(campo('Título del widget'), 'Votos totales');
  await usuario.click(screen.getByRole('button', { name: 'Guardar cambios' }));
  fireEvent.click(screen.getAllByTitle('Quitar')[1]);
  await usuario.click(screen.getByRole('button', { name: 'Guardar tablero' }));

  expect(api.createDashboard).not.toHaveBeenCalled();
  expect(api.updateDashboard).toHaveBeenCalledWith('jwt-admin', 5, 'Cierre', expect.any(Object));
  expect(guardado()).toEqual([expect.objectContaining({ id: 'a', title: 'Votos totales', dataSource: 'results' })]);
});

it('borrar un tablero pide confirmación y, confirmado, vuelve a uno nuevo', async () => {
  api.getDashboard.mockResolvedValue({ id: 5, name: 'Cierre', layout: { widgets: [] } });
  api.deleteDashboard.mockResolvedValue(null);
  const usuario = await abrir({ tableros: [{ id: 5, name: 'Cierre' }] });
  await screen.findByRole('option', { name: 'Cierre' });
  await usuario.selectOptions(screen.getAllByRole('combobox')[1], '5');
  await waitFor(() => expect(nombreDelTablero()).toHaveValue('Cierre'));

  window.confirm.mockReturnValue(false);
  await usuario.click(screen.getByRole('button', { name: 'Borrar tablero' }));
  expect(window.confirm).toHaveBeenCalledWith('¿Borrar el tablero "Cierre"? No se puede deshacer.');
  expect(api.deleteDashboard).not.toHaveBeenCalled();

  window.confirm.mockReturnValue(true);
  await usuario.click(screen.getByRole('button', { name: 'Borrar tablero' }));
  expect(api.deleteDashboard).toHaveBeenCalledWith('jwt-admin', 5);
  await waitFor(() => expect(nombreDelTablero()).toHaveValue('Nuevo tablero'));
  expect(screen.queryByRole('button', { name: 'Borrar tablero' })).not.toBeInTheDocument();
});

it('si no se puede guardar, muestra el motivo', async () => {
  api.createDashboard.mockRejectedValue(new Error('El tablero supera el tamaño máximo'));
  const usuario = await abrir();
  await usuario.click(screen.getByRole('button', { name: 'Guardar tablero' }));
  expect(await screen.findByText('El tablero supera el tamaño máximo')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Guardar tablero' })).toBeEnabled();
});

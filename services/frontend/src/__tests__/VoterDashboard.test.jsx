// Papeleta del votante: qué elecciones ve, cómo vota, y qué nunca se le
// muestra (su historial no dice en qué elección ni por quién votó).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoterDashboard from '../pages/VoterDashboard.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const SESION = { role: 'voter', token: 'jwt-votante', pollingPlace: 'Puesto Central', votingTable: 'Mesa 3' };

const eleccion = (id, titulo, opciones) => ({
  id,
  title: titulo,
  scheduled_end: '2026-10-05T22:00:00Z',
  options: opciones.map((label, i) => ({ id: id * 10 + i, label })),
});

function mostrar({ elecciones = [], votos = [] } = {}) {
  api.listActiveElections.mockResolvedValue(elecciones);
  api.listMyVotes.mockResolvedValue({ votes: votos });
  return render(<VoterDashboard session={SESION} onLogout={jest.fn()} />);
}

beforeEach(() => reiniciarApiFalsa(api));

it('muestra las elecciones abiertas y el puesto y la mesa del votante', async () => {
  mostrar({ elecciones: [eleccion(1, 'Consejo estudiantil', ['Lista A', 'Lista B'])] });
  expect(await screen.findByText('Consejo estudiantil')).toBeInTheDocument();
  expect(screen.getByText('Lista A')).toBeInTheDocument();
  expect(screen.getByText('Puesto Central')).toBeInTheDocument();
  expect(screen.getByText('Mesa 3')).toBeInTheDocument();
});

it('no se puede emitir el voto sin elegir una opción', async () => {
  mostrar({ elecciones: [eleccion(1, 'Consejo estudiantil', ['Lista A', 'Lista B'])] });
  expect(await screen.findByRole('button', { name: 'Emitir voto' })).toBeDisabled();
});

it('vota por la opción elegida y confirma sin decir cuál fue', async () => {
  api.castVote.mockResolvedValue({ message: 'ok' });
  const usuario = userEvent.setup();
  mostrar({ elecciones: [eleccion(1, 'Consejo estudiantil', ['Lista A', 'Lista B'])] });

  await usuario.click(await screen.findByText('Lista B'));
  await usuario.click(screen.getByRole('button', { name: 'Emitir voto' }));

  expect(api.castVote).toHaveBeenCalledWith('jwt-votante', 1, 11);
  expect(await screen.findByText('Voto registrado')).toBeInTheDocument();
  expect(screen.queryByText('Lista B')).not.toBeInTheDocument();
});

it('si el servicio rechaza el voto, lo dice y deja la papeleta', async () => {
  api.castVote.mockRejectedValue(new Error('Ya votaste en esta elección'));
  const usuario = userEvent.setup();
  mostrar({ elecciones: [eleccion(1, 'Consejo estudiantil', ['Lista A'])] });

  await usuario.click(await screen.findByText('Lista A'));
  await usuario.click(screen.getByRole('button', { name: 'Emitir voto' }));

  expect(await screen.findByText('Ya votaste en esta elección')).toBeInTheDocument();
  expect(screen.queryByText('Voto registrado')).not.toBeInTheDocument();
});

it('en una elección donde ya votó no le vuelve a mostrar la papeleta', async () => {
  mostrar({
    elecciones: [eleccion(1, 'Consejo estudiantil', ['Lista A']), eleccion(2, 'Representante', ['Ana', 'Luis'])],
    votos: [{ electionId: 1, createdAt: '2026-10-05T14:00:00Z' }],
  });
  const tarjeta = (await screen.findByText('Consejo estudiantil')).closest('.ballot-card');
  expect(within(tarjeta).getByText('Ya emitiste tu voto en esta elección.')).toBeInTheDocument();
  expect(within(tarjeta).queryByText('Lista A')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Emitir voto' })).toHaveLength(1);
});

it('el historial confirma que votó, pero no en qué elección ni por quién', async () => {
  mostrar({
    elecciones: [eleccion(1, 'Consejo estudiantil', ['Lista A'])],
    votos: [{ electionId: 1, createdAt: '2026-10-05T14:00:00Z' }],
  });
  const historial = (await screen.findByText('Historial de tus votos')).closest('.panel');
  expect(within(historial).getByText('Voto emitido')).toBeInTheDocument();
  expect(historial).not.toHaveTextContent('Consejo estudiantil');
  expect(historial).not.toHaveTextContent('Lista A');
});

it('si falla el historial, igual muestra las elecciones', async () => {
  api.listActiveElections.mockResolvedValue([eleccion(1, 'Consejo estudiantil', ['Lista A'])]);
  api.listMyVotes.mockRejectedValue(new Error('caído'));
  render(<VoterDashboard session={SESION} onLogout={jest.fn()} />);
  expect(await screen.findByText('Consejo estudiantil')).toBeInTheDocument();
  expect(screen.queryByText('caído')).not.toBeInTheDocument();
});

it('el nombre de una opción con HTML se muestra como texto: no se interpreta (XSS)', async () => {
  const malicioso = '<img src=x onerror="window.__xss = true">';
  const { container } = mostrar({ elecciones: [eleccion(1, 'Consulta', [malicioso])] });
  expect(await screen.findByText(malicioso)).toBeInTheDocument();
  expect(container.querySelector('img[src="x"]')).toBeNull();
  expect(window.__xss).toBeUndefined();
});

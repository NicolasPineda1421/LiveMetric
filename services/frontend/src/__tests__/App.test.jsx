// La aplicación completa: qué pantalla le toca a cada rol y dónde queda la
// sesión (solo en memoria: nunca en el almacenamiento del navegador, que en
// un puesto de votación es un equipo compartido).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

async function ingresar(usuario, rol) {
  api.loginAdmin.mockResolvedValue({ token: `jwt-${rol}`, role: rol });
  await usuario.type(screen.getByLabelText('Usuario'), 'persona');
  await usuario.type(screen.getByLabelText('Contraseña'), 'clave');
  await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
}

const pestanas = () => screen.getAllByRole('button').filter((b) => b.classList.contains('tab')).map((b) => b.textContent);

beforeEach(() => {
  reiniciarApiFalsa(api);
  localStorage.clear();
  sessionStorage.clear();
});

it('sin sesión, muestra la pantalla de ingreso', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: 'Ingresar como administrador' })).toBeInTheDocument();
});

it('el administrador ve todas las pestañas de gestión', async () => {
  const usuario = userEvent.setup();
  render(<App />);
  await ingresar(usuario, 'admin');
  expect(await screen.findByText('Admin: persona')).toBeInTheDocument();
  expect(pestanas()).toEqual(['Resumen', 'Plantillas', 'Elecciones', 'Resultados', 'Reportes', 'Escrutinio', 'Usuarios', 'Padrón', 'Auditoría']);
});

it('el auditor solo ve resultados y reportes: ninguna pestaña de gestión', async () => {
  const usuario = userEvent.setup();
  render(<App />);
  await ingresar(usuario, 'auditor');
  expect(await screen.findByText('Auditor: persona')).toBeInTheDocument();
  expect(pestanas()).toEqual(['Resultados', 'Reportes']);
});

it('la sesión no se guarda en el navegador, y "Salir" la cierra', async () => {
  const usuario = userEvent.setup();
  render(<App />);
  await ingresar(usuario, 'admin');
  await screen.findByText('Admin: persona');
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(document.cookie).toBe('');

  await usuario.click(screen.getByRole('button', { name: 'Salir' }));
  expect(screen.getByRole('button', { name: 'Ingresar como administrador' })).toBeInTheDocument();
});

it('un votante entra a su papeleta', async () => {
  api.loginVoter.mockResolvedValue({ token: 'jwt-votante', pollingPlace: 'Puesto Central', votingTable: 'Mesa 1' });
  api.listActiveElections.mockResolvedValue([]);
  api.listMyVotes.mockResolvedValue({ votes: [] });
  const usuario = userEvent.setup();
  render(<App />);
  await usuario.click(screen.getByRole('button', { name: 'Votante' }));
  await usuario.type(screen.getByLabelText('Cédula'), '1000000001');
  await usuario.type(screen.getByLabelText('PIN de acceso'), '482913');
  await usuario.click(screen.getByRole('button', { name: 'Ingresar a votar' }));
  expect(await screen.findByText('No hay elecciones activas en este momento. Vuelve más tarde.')).toBeInTheDocument();
  expect(localStorage.length).toBe(0);
});

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
  await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador, auditor o jurado' }));
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

it('sin sesión, muestra la pantalla de ingreso: primero la de votantes', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: 'Ingresar a votar' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ingresar como administrador, auditor o jurado' })).toBeInTheDocument();
});

it('el administrador ve todas las pestañas de gestión', async () => {
  const usuario = userEvent.setup();
  render(<App />);
  await ingresar(usuario, 'admin');
  expect(await screen.findByText('Admin: persona')).toBeInTheDocument();
  expect(pestanas()).toEqual(['Resumen', 'Plantillas', 'Elecciones', 'Resultados', 'Reportes', 'Escrutinio', 'Usuarios', 'Padrón', 'Puestos', 'Auditoría']);
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
  expect(screen.getByRole('button', { name: 'Ingresar a votar' })).toBeInTheDocument();
});

it('un votante entra a su papeleta, con su PIN y el código de su autenticador', async () => {
  api.loginVoter.mockResolvedValue({ next: 'codigo', challenge: 'desafio' });
  api.verifyVoterCode.mockResolvedValue({ token: 'jwt-votante', pollingPlace: 'Puesto Central', votingTable: 'Mesa 1' });
  api.listActiveElections.mockResolvedValue([]);
  api.listMyVotes.mockResolvedValue({ votes: [] });
  const usuario = userEvent.setup();
  render(<App />);
  await usuario.type(screen.getByLabelText('Cédula'), '1000000001');
  await usuario.type(screen.getByLabelText('PIN de acceso'), '482913');
  await usuario.click(screen.getByRole('button', { name: 'Ingresar a votar' }));
  await usuario.type(screen.getByLabelText('Código de la app'), '123456');
  await usuario.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(await screen.findByText('No hay elecciones activas en este momento. Vuelve más tarde.')).toBeInTheDocument();
  expect(localStorage.length).toBe(0);
});

it('un jurado entra a su panel: su mesa y los votantes asistidos, sin pestañas de gestión', async () => {
  api.loginAdmin.mockResolvedValue({ next: 'codigo', challenge: 'desafio-j' });
  api.verifyAdminCode.mockResolvedValue({ token: 'jwt-jurado', role: 'jurado' });
  api.getJuradoMesa.mockResolvedValue({
    pollingPlace: 'Puesto Central',
    votingTable: 'Mesa 1',
    assistedVoters: [{ fullName: 'Rosa Pérez', cedulaEnd: '0042', votingTable: 'Mesa 1' }],
  });
  const usuario = userEvent.setup();
  render(<App />);
  await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador, auditor o jurado' }));
  await usuario.type(screen.getByLabelText('Usuario'), 'jurado.mesa1');
  await usuario.type(screen.getByLabelText('Contraseña'), 'clave');
  await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
  await usuario.type(screen.getByLabelText('Código de la app'), '123456');
  await usuario.click(screen.getByRole('button', { name: 'Entrar' }));

  expect(await screen.findByText('Jurado: jurado.mesa1')).toBeInTheDocument();
  expect(await screen.findByText('Puesto Central — Mesa 1')).toBeInTheDocument();
  expect(screen.getByText('Rosa Pérez')).toBeInTheDocument();
  expect(screen.getByText('···0042')).toBeInTheDocument();
  expect(pestanas()).toEqual([]);
});

it('un jurado de todo el puesto ve que puede autorizar en cualquier mesa, con la mesa de cada votante', async () => {
  api.loginAdmin.mockResolvedValue({ next: 'codigo', challenge: 'desafio-j' });
  api.verifyAdminCode.mockResolvedValue({ token: 'jwt-jurado', role: 'jurado' });
  api.getJuradoMesa.mockResolvedValue({
    pollingPlace: 'Puesto Central',
    votingTable: null,
    assistedVoters: [
      { fullName: 'Rosa Pérez', cedulaEnd: '0042', votingTable: 'Mesa 1' },
      { fullName: 'Luis Gómez', cedulaEnd: '0077', votingTable: 'Mesa 2' },
    ],
  });
  const usuario = userEvent.setup();
  render(<App />);
  await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador, auditor o jurado' }));
  await usuario.type(screen.getByLabelText('Usuario'), 'jurado.puesto');
  await usuario.type(screen.getByLabelText('Contraseña'), 'clave');
  await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
  await usuario.type(screen.getByLabelText('Código de la app'), '123456');
  await usuario.click(screen.getByRole('button', { name: 'Entrar' }));

  expect(await screen.findByText(/Puedes autorizar a los votantes asistidos de cualquier mesa de este puesto/)).toBeInTheDocument();
  expect(screen.getByText('Votantes asistidos de tu puesto (2)')).toBeInTheDocument();
  expect(screen.getByText('Luis Gómez').closest('tr')).toHaveTextContent('Mesa 2');
});

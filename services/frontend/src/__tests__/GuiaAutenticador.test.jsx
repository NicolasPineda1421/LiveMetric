// Guía paso a paso del autenticador (GuiaAutenticador.jsx): está en el
// ingreso de votantes, en el del personal y en el registro del autenticador;
// una pestaña por app, cada paso con su ilustración, y una ventana que se
// maneja con el teclado.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginScreen from '../pages/LoginScreen.jsx';
import SegundoFactor from '../components/SegundoFactor.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

beforeEach(() => reiniciarApiFalsa(api));

const ENLACE = 'Guía paso a paso: cómo entrar con el autenticador';
const guia = () => screen.getByRole('dialog', { name: 'Cómo entrar con el autenticador' });
const titulos = () => within(guia()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent.replace(/^\d+/, ''));

async function abrirDesdeElIngreso(usuario, { personal = false } = {}) {
  render(<LoginScreen onLogin={jest.fn()} />);
  if (personal) await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador, auditor o jurado' }));
  await usuario.click(screen.getByRole('button', { name: ENLACE }));
}

it('desde el ingreso de votantes: Microsoft primero, paso por paso y cada paso con su ilustración', async () => {
  const usuario = userEvent.setup();
  await abrirDesdeElIngreso(usuario);
  expect(guia()).toHaveTextContent('después de tu cédula y tu PIN');
  expect(within(guia()).getByRole('button', { name: 'Cerrar' })).toHaveFocus();
  expect(within(guia()).getByRole('tab', { name: 'Microsoft Authenticator' })).toHaveAttribute('aria-selected', 'true');
  expect(titulos()).toEqual([
    'Instala la app', 'Agrega una cuenta', 'Elige «Otra cuenta»', 'Escanea el código QR', 'Mira el código', 'Escríbelo en LiveMetric',
    'Las próximas veces', '¿El código no funciona?',
  ]);
  const ilustraciones = within(guia()).getAllByRole('img');
  expect(ilustraciones).toHaveLength(7);
  expect(ilustraciones[2]).toHaveAccessibleName('Los tipos de cuenta de Microsoft Authenticator, con «Otra cuenta» resaltada');
  expect(guia()).toHaveTextContent('Avisa al encargado de tu puesto de votación');
});

it('la pestaña de Google tiene sus propios pasos, y las flechas cambian de pestaña', async () => {
  const usuario = userEvent.setup();
  await abrirDesdeElIngreso(usuario);
  await usuario.click(within(guia()).getByRole('tab', { name: 'Google Authenticator' }));
  expect(titulos()).toContain('Elige «Escanear un código QR»');
  expect(guia()).toHaveTextContent('Ingresar una clave de configuración');
  expect(within(guia()).getByRole('tabpanel')).toHaveAccessibleName('Google Authenticator');

  await usuario.keyboard('{ArrowRight}');
  expect(within(guia()).getByRole('tab', { name: 'Microsoft Authenticator' })).toHaveFocus();
  expect(titulos()).toContain('Elige «Otra cuenta»');
});

it('se cierra con Escape, con «Cerrar» o tocando afuera, y el foco vuelve al enlace', async () => {
  const usuario = userEvent.setup();
  await abrirDesdeElIngreso(usuario);
  await usuario.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: ENLACE })).toHaveFocus();

  await usuario.click(screen.getByRole('button', { name: ENLACE }));
  await usuario.click(within(guia()).getByRole('button', { name: 'Cerrar' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  await usuario.click(screen.getByRole('button', { name: ENLACE }));
  await usuario.click(document.querySelector('.guia-fondo'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('mientras está abierta, el foco no sale de la ventana', async () => {
  const usuario = userEvent.setup();
  await abrirDesdeElIngreso(usuario);
  await usuario.tab({ shift: true });
  expect(within(guia()).getByRole('tab', { name: 'Microsoft Authenticator' })).toHaveFocus();
  await usuario.tab();
  expect(within(guia()).getByRole('button', { name: 'Cerrar' })).toHaveFocus();
});

it('desde el ingreso del personal, explica que el autenticador es del jurado', async () => {
  const usuario = userEvent.setup();
  await abrirDesdeElIngreso(usuario, { personal: true });
  expect(guia()).toHaveTextContent('El autenticador lo usa el jurado: el administrador y el auditor entran solo con su usuario y su contraseña.');
  expect(guia()).toHaveTextContent('Después de tu usuario y tu contraseña');
  expect(guia()).toHaveTextContent('Pide al administrador que restablezca tu autenticador');
});

it('también está al registrar el autenticador y al escribir el código', () => {
  const props = { loading: false, onCodigo: jest.fn(), onJurado: jest.fn(), onVolver: jest.fn() };
  const { unmount } = render(<SegundoFactor {...props} paso={{ next: 'registro', challenge: 'd', secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/LiveMetric?secret=JBSWY3DPEHPK3PXP', quien: 'votante' }} />);
  expect(screen.getByRole('button', { name: ENLACE })).toBeInTheDocument();
  unmount();
  render(<SegundoFactor {...props} paso={{ next: 'codigo', challenge: 'd', quien: 'jurado' }} />);
  expect(screen.getByRole('button', { name: ENLACE })).toBeInTheDocument();
});

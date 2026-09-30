// Pantalla de ingreso: administradores/auditores con usuario y contraseña,
// votantes con cédula y PIN.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginScreen from '../pages/LoginScreen.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

beforeEach(() => reiniciarApiFalsa(api));

describe('ingreso de administrador o auditor', () => {
  it('manda usuario y contraseña, y abre la sesión con el rol que devuelve el servicio', async () => {
    api.loginAdmin.mockResolvedValue({ token: 'jwt-auditor', role: 'auditor' });
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);

    await usuario.type(screen.getByLabelText('Usuario'), 'ana');
    await usuario.type(screen.getByLabelText('Contraseña'), 'clave-larga-123');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));

    expect(api.loginAdmin).toHaveBeenCalledWith('ana', 'clave-larga-123');
    expect(onLogin).toHaveBeenCalledWith({ role: 'auditor', token: 'jwt-auditor', username: 'ana' });
  });

  it('la contraseña no se ve en pantalla', () => {
    render(<LoginScreen onLogin={jest.fn()} />);
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password');
  });

  it('si el servicio rechaza el ingreso, muestra el motivo y no abre sesión', async () => {
    api.loginAdmin.mockRejectedValue(new Error('Usuario o contraseña incorrectos'));
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);

    await usuario.type(screen.getByLabelText('Usuario'), 'ana');
    await usuario.type(screen.getByLabelText('Contraseña'), 'equivocada');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));

    expect(await screen.findByText('Usuario o contraseña incorrectos')).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Ingresar como administrador' })).toBeEnabled();
  });

  it('mientras espera la respuesta, el botón queda deshabilitado (sin envíos dobles)', async () => {
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={jest.fn()} />);
    await usuario.type(screen.getByLabelText('Usuario'), 'ana');
    await usuario.type(screen.getByLabelText('Contraseña'), 'clave');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
    expect(screen.getByRole('button', { name: 'Ingresando…' })).toBeDisabled();
  });
});

describe('ingreso de votante', () => {
  it('manda cédula y PIN, y la sesión trae su puesto y su mesa', async () => {
    api.loginVoter.mockResolvedValue({ token: 'jwt-votante', pollingPlace: 'Puesto Central', votingTable: 'Mesa 3' });
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);

    await usuario.click(screen.getByRole('button', { name: 'Votante' }));
    await usuario.type(screen.getByLabelText('Cédula'), '1000000001');
    await usuario.type(screen.getByLabelText('PIN de acceso'), '482913');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar a votar' }));

    expect(api.loginVoter).toHaveBeenCalledWith('1000000001', '482913');
    expect(onLogin).toHaveBeenCalledWith({
      role: 'voter',
      token: 'jwt-votante',
      cedula: '1000000001',
      pollingPlace: 'Puesto Central',
      votingTable: 'Mesa 3',
    });
  });

  it('al cambiar de pestaña se borra el error de la otra', async () => {
    api.loginAdmin.mockRejectedValue(new Error('Usuario o contraseña incorrectos'));
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={jest.fn()} />);
    await usuario.type(screen.getByLabelText('Usuario'), 'ana');
    await usuario.type(screen.getByLabelText('Contraseña'), 'x');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
    await screen.findByText('Usuario o contraseña incorrectos');

    await usuario.click(screen.getByRole('button', { name: 'Votante' }));
    expect(screen.queryByText('Usuario o contraseña incorrectos')).not.toBeInTheDocument();
  });
});

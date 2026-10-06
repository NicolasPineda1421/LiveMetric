// Pantalla de ingreso: primero la de los votantes, con cédula y PIN; el
// personal (administrador, auditor o jurado) entra con un botón aparte, con
// usuario y contraseña. Después del PIN, el votante pasa al segundo factor: el código de su
// autenticador (o registrarlo, la primera vez) o, si votan asistidos, la
// autorización del jurado de su mesa. El jurado entra con usuario,
// contraseña y su propio código.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginScreen from '../pages/LoginScreen.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

beforeEach(() => reiniciarApiFalsa(api));

const PERSONAL = 'Ingresar como administrador, auditor o jurado';
// El ingreso del personal está detrás de su botón.
async function alPersonal(usuario) {
  await usuario.click(screen.getByRole('button', { name: PERSONAL }));
}

describe('qué se ve primero', () => {
  it('el ingreso de votantes, y aparte el botón para el personal; con él se va y se vuelve', async () => {
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={jest.fn()} />);
    expect(screen.getByRole('heading', { name: 'Ingreso de votantes' })).toBeInTheDocument();
    expect(screen.getByLabelText('Cédula')).toHaveFocus();
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();

    await alPersonal(usuario);
    expect(screen.getByRole('heading', { name: 'Administrador, auditor o jurado' })).toBeInTheDocument();
    expect(screen.getByLabelText('Usuario')).toHaveFocus();
    expect(screen.queryByRole('button', { name: PERSONAL })).not.toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: '← Volver al ingreso de votantes' }));
    expect(screen.getByLabelText('Cédula')).toBeInTheDocument();
  });
});

describe('ingreso de administrador o auditor', () => {
  it('manda usuario y contraseña, y abre la sesión con el rol que devuelve el servicio', async () => {
    api.loginAdmin.mockResolvedValue({ token: 'jwt-auditor', role: 'auditor' });
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);
    await alPersonal(usuario);

    await usuario.type(screen.getByLabelText('Usuario'), 'ana');
    await usuario.type(screen.getByLabelText('Contraseña'), 'clave-larga-123');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));

    expect(api.loginAdmin).toHaveBeenCalledWith('ana', 'clave-larga-123');
    expect(onLogin).toHaveBeenCalledWith({ role: 'auditor', token: 'jwt-auditor', username: 'ana' });
  });

  it('la contraseña no se ve en pantalla', async () => {
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={jest.fn()} />);
    await alPersonal(usuario);
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password');
  });

  it('el PIN del votante tampoco se ve: en la mesa puede haber alguien al lado (el jurado, en el voto asistido)', async () => {
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={jest.fn()} />);
    expect(screen.getByLabelText('PIN de acceso')).toHaveAttribute('type', 'password');
  });

  it('si el servicio rechaza el ingreso, muestra el motivo y no abre sesión', async () => {
    api.loginAdmin.mockRejectedValue(new Error('Usuario o contraseña incorrectos'));
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);
    await alPersonal(usuario);

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
    await alPersonal(usuario);
    await usuario.type(screen.getByLabelText('Usuario'), 'ana');
    await usuario.type(screen.getByLabelText('Contraseña'), 'clave');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
    expect(screen.getByRole('button', { name: 'Ingresando…' })).toBeDisabled();
  });
});

describe('ingreso de votante', () => {
  const SESION_VOTANTE = { token: 'jwt-votante', pollingPlace: 'Puesto Central', votingTable: 'Mesa 3' };

  async function conPin(usuario, primerPaso) {
    api.loginVoter.mockResolvedValue(primerPaso);
    await usuario.type(screen.getByLabelText('Cédula'), '1000000001');
    await usuario.type(screen.getByLabelText('PIN de acceso'), '482913');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar a votar' }));
  }

  it('con el PIN pide el código del autenticador, y la sesión trae su puesto y su mesa', async () => {
    api.verifyVoterCode.mockResolvedValue(SESION_VOTANTE);
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);
    await conPin(usuario, { next: 'codigo', challenge: 'desafio-1' });

    expect(api.loginVoter).toHaveBeenCalledWith('1000000001', '482913');
    expect(onLogin).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Código de tu autenticador' })).toBeInTheDocument();
    const entrar = screen.getByRole('button', { name: 'Entrar' });
    expect(entrar).toBeDisabled();

    // Solo acepta dígitos, y hasta 6.
    await usuario.type(screen.getByLabelText('Código de la app'), '12a3 4567');
    expect(screen.getByLabelText('Código de la app')).toHaveValue('123456');
    await usuario.click(entrar);
    expect(api.verifyVoterCode).toHaveBeenCalledWith('desafio-1', '123456');
    expect(onLogin).toHaveBeenCalledWith({ role: 'voter', token: 'jwt-votante', cedula: '1000000001', pollingPlace: 'Puesto Central', votingTable: 'Mesa 3' });
  });

  it('el primer ingreso guía el registro: QR, la clave para escribirla a mano y el código para confirmar', async () => {
    api.enrollVoter.mockResolvedValue(SESION_VOTANTE);
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);
    await conPin(usuario, {
      next: 'registro',
      challenge: 'desafio-2',
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/LiveMetric:Votante?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=LiveMetric',
    });

    expect(screen.getByRole('heading', { name: 'Primer ingreso: registra tu autenticador' })).toBeInTheDocument();
    expect(screen.getByText('Microsoft Authenticator')).toBeInTheDocument();
    expect(screen.getByTitle('Código QR para el autenticador')).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();

    await usuario.type(screen.getByLabelText('Código de la app'), '654321');
    await usuario.click(screen.getByRole('button', { name: 'Confirmar y entrar' }));
    expect(api.enrollVoter).toHaveBeenCalledWith('desafio-2', '654321');
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ role: 'voter', token: 'jwt-votante' }));
  });

  it('el votante asistido pasa a la autorización del jurado de su mesa', async () => {
    api.authorizeAssistedVoter.mockResolvedValue(SESION_VOTANTE);
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);
    await conPin(usuario, { next: 'jurado', challenge: 'desafio-3' });

    expect(screen.getByRole('heading', { name: 'Voto asistido' })).toBeInTheDocument();
    expect(screen.getByText(/el jurado no ve tu voto/)).toBeInTheDocument();
    await usuario.type(screen.getByLabelText('Usuario del jurado'), 'jurado.mesa1');
    await usuario.type(screen.getByLabelText('Código del autenticador del jurado'), '246810');
    await usuario.click(screen.getByRole('button', { name: 'Autorizar el ingreso' }));
    expect(api.authorizeAssistedVoter).toHaveBeenCalledWith('desafio-3', 'jurado.mesa1', '246810');
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ role: 'voter', pollingPlace: 'Puesto Central' }));
  });

  it('un código rechazado muestra el motivo; "Volver" regresa al inicio sin el PIN escrito', async () => {
    api.verifyVoterCode.mockRejectedValue(new Error('Código incorrecto o vencido: escribe el que muestra ahora la app.'));
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);
    await conPin(usuario, { next: 'codigo', challenge: 'desafio-4' });
    await usuario.type(screen.getByLabelText('Código de la app'), '111111');
    await usuario.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByText(/Código incorrecto o vencido/)).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    await usuario.click(screen.getByRole('button', { name: 'Volver' }));
    expect(screen.queryByText(/Código incorrecto o vencido/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('PIN de acceso')).toHaveValue('');
    expect(screen.getByLabelText('Cédula')).toHaveValue('1000000001');
  });

  it('al volver al ingreso de votantes se borra el error del personal', async () => {
    api.loginAdmin.mockRejectedValue(new Error('Usuario o contraseña incorrectos'));
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={jest.fn()} />);
    await alPersonal(usuario);
    await usuario.type(screen.getByLabelText('Usuario'), 'ana');
    await usuario.type(screen.getByLabelText('Contraseña'), 'x');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
    await screen.findByText('Usuario o contraseña incorrectos');

    await usuario.click(screen.getByRole('button', { name: '← Volver al ingreso de votantes' }));
    expect(screen.queryByText('Usuario o contraseña incorrectos')).not.toBeInTheDocument();
  });
});

describe('ingreso de jurado', () => {
  it('después de la contraseña pide el código de su autenticador y abre la sesión de jurado', async () => {
    api.loginAdmin.mockResolvedValue({ next: 'codigo', challenge: 'desafio-j' });
    api.verifyAdminCode.mockResolvedValue({ token: 'jwt-jurado', role: 'jurado' });
    const onLogin = jest.fn();
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={onLogin} />);
    await alPersonal(usuario);
    await usuario.type(screen.getByLabelText('Usuario'), 'jurado.mesa1');
    await usuario.type(screen.getByLabelText('Contraseña'), 'clave-larga-123');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));
    expect(onLogin).not.toHaveBeenCalled();

    await usuario.type(screen.getByLabelText('Código de la app'), '135790');
    await usuario.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(api.verifyAdminCode).toHaveBeenCalledWith('desafio-j', '135790');
    expect(onLogin).toHaveBeenCalledWith({ role: 'jurado', token: 'jwt-jurado', username: 'jurado.mesa1' });
  });

  it('en su primer ingreso registra su autenticador', async () => {
    api.loginAdmin.mockResolvedValue({ next: 'registro', challenge: 'desafio-jr', secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/LiveMetric:Jurado?secret=JBSWY3DPEHPK3PXP' });
    api.enrollAdmin.mockResolvedValue({ token: 'jwt-jurado', role: 'jurado' });
    const usuario = userEvent.setup();
    render(<LoginScreen onLogin={jest.fn()} />);
    await alPersonal(usuario);
    await usuario.type(screen.getByLabelText('Usuario'), 'jurado.mesa1');
    await usuario.type(screen.getByLabelText('Contraseña'), 'clave-larga-123');
    await usuario.click(screen.getByRole('button', { name: 'Ingresar como administrador' }));

    expect(screen.getByText(/Como jurado, autorizas los votos asistidos/)).toBeInTheDocument();
    await usuario.type(screen.getByLabelText('Código de la app'), '975310');
    await usuario.click(screen.getByRole('button', { name: 'Confirmar y entrar' }));
    expect(api.enrollAdmin).toHaveBeenCalledWith('desafio-jr', '975310');
  });
});

// Pestañas de gestión del administrador: validaciones antes de llamar al
// backend, confirmaciones de las acciones que no se pueden deshacer y los
// PIN de votante, que se muestran una sola vez.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminDashboard, { formatPinExpiry } from '../pages/AdminDashboard.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const SESION = { role: 'admin', token: 'jwt-admin', username: 'admin' };

// Los formularios del panel ponen cada <label> justo antes de su campo.
const campo = (etiqueta) => screen.getByText(etiqueta, { selector: 'label' }).nextElementSibling;

async function abrir(pestana) {
  const usuario = userEvent.setup();
  render(<AdminDashboard session={SESION} onLogout={jest.fn()} />);
  await usuario.click(screen.getByRole('button', { name: pestana }));
  return usuario;
}

beforeEach(() => {
  reiniciarApiFalsa(api);
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('Resumen', () => {
  it('cuenta las elecciones por estado', async () => {
    api.listAllElections.mockResolvedValue([{ status: 'active' }, { status: 'closed' }, { status: 'closed' }]);
    render(<AdminDashboard session={SESION} onLogout={jest.fn()} />);
    const fila = (estado) => screen.getByText(estado).closest('.tally-row');
    await screen.findByText('Cerradas'); // aparece cuando termina de cargar
    expect(within(fila('Cerradas')).getByText('2')).toBeInTheDocument();
    expect(within(fila('Activas')).getByText('1')).toBeInTheDocument();
    expect(within(fila('Programadas')).getByText('0')).toBeInTheDocument();
  });
});

describe('Plantillas', () => {
  beforeEach(() => api.listTemplates.mockResolvedValue([]));

  it('una plantilla genérica necesita al menos dos opciones: si no, ni llama al servicio', async () => {
    const usuario = await abrir('Plantillas');
    await usuario.type(campo('Nombre'), 'Consulta');
    await usuario.type(screen.getByPlaceholderText('Opción 1'), 'Sí');
    await usuario.type(screen.getByPlaceholderText('Opción 2'), '   ');
    await usuario.click(screen.getByRole('button', { name: 'Crear plantilla' }));
    expect(screen.getByText('Se necesitan al menos 2 opciones.')).toBeInTheDocument();
    expect(api.createTemplate).not.toHaveBeenCalled();
  });

  it('crea la plantilla genérica con las opciones sin espacios de más', async () => {
    api.createTemplate.mockResolvedValue({ id: 1 });
    const usuario = await abrir('Plantillas');
    await usuario.type(campo('Nombre'), 'Consulta');
    await usuario.type(screen.getByPlaceholderText('Opción 1'), '  Sí ');
    await usuario.type(screen.getByPlaceholderText('Opción 2'), 'No');
    await usuario.click(screen.getByRole('button', { name: '+ Agregar opción' }));
    await usuario.click(screen.getByRole('button', { name: 'Crear plantilla' }));
    expect(api.createTemplate).toHaveBeenCalledWith('jwt-admin', 'Consulta', '', 'generic', ['Sí', 'No']);
    expect(await screen.findByText('Plantilla creada correctamente.')).toBeInTheDocument();
  });

  it('una presidencial necesita dos candidatos con número y nombre', async () => {
    const usuario = await abrir('Plantillas');
    await usuario.click(screen.getByRole('button', { name: 'Elección presidencial' }));
    await usuario.type(campo('Nombre'), 'Presidencia');
    const nombres = screen.getAllByPlaceholderText('Nombre del candidato');
    await usuario.type(nombres[0], 'Candidata Uno');
    await usuario.click(screen.getByRole('button', { name: 'Crear plantilla' }));
    expect(screen.getByText('Se necesitan al menos 2 candidatos con número y nombre.')).toBeInTheDocument();

    await usuario.type(nombres[1], 'Candidato Dos');
    api.createTemplate.mockResolvedValue({ id: 2 });
    await usuario.click(screen.getByRole('button', { name: 'Crear plantilla' }));
    expect(api.createTemplate).toHaveBeenCalledWith('jwt-admin', 'Presidencia', '', 'presidential', [
      { candidateNumber: '1', name: 'Candidata Uno', logo: null },
      { candidateNumber: '2', name: 'Candidato Dos', logo: null },
    ]);
  });

  it('lista las plantillas existentes', async () => {
    api.listTemplates.mockResolvedValue([
      { id: 4, name: 'Consulta', template_type: 'generic', options: [{ id: 1, label: 'Sí' }, { id: 2, label: 'No' }] },
      { id: 5, name: 'Presidencia', template_type: 'presidential', options: [{ id: 3, label: 'Candidata Uno', candidateNumber: '1' }] },
    ]);
    await abrir('Plantillas');
    expect(await screen.findByText('Sí, No')).toBeInTheDocument();
    expect(screen.getByText('Presidencial')).toBeInTheDocument();
    expect(screen.getByText('Candidata Uno')).toBeInTheDocument();
  });
});

describe('Elecciones', () => {
  const ACTIVA = { id: 9, title: 'Consejo', status: 'active', scheduled_start: '2026-10-05T12:00:00Z', scheduled_end: '2026-10-05T22:00:00Z', vote_count: 3 };

  it('programa la elección con la plantilla y las fechas en ISO', async () => {
    api.listTemplates.mockResolvedValue([{ id: 4, name: 'Consulta', template_type: 'generic' }]);
    api.listAllElections.mockResolvedValue([]);
    api.createElection.mockResolvedValue({ id: 10 });
    const usuario = await abrir('Elecciones');
    await usuario.selectOptions(await within(campo('Plantilla').parentElement).findByRole('combobox'), '4');
    await usuario.type(campo('Título de la elección'), 'Consejo 2026');
    await usuario.type(campo('Apertura'), '2026-10-05T08:00');
    await usuario.type(campo('Cierre'), '2026-10-05T17:00');
    await usuario.click(screen.getByRole('button', { name: 'Programar elección' }));
    expect(api.createElection).toHaveBeenCalledWith(
      'jwt-admin',
      4,
      'Consejo 2026',
      new Date('2026-10-05T08:00').toISOString(),
      new Date('2026-10-05T17:00').toISOString(),
    );
    expect(await screen.findByText(/Elección creada/)).toBeInTheDocument();
  });

  it('detener una elección pide confirmación; si se cancela, no pasa nada', async () => {
    api.listTemplates.mockResolvedValue([]);
    api.listAllElections.mockResolvedValue([ACTIVA]);
    window.confirm.mockReturnValue(false);
    const usuario = await abrir('Elecciones');
    await usuario.click(await screen.findByRole('button', { name: 'Detener' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(api.stopElection).not.toHaveBeenCalled();
  });

  it('confirmada, la detiene', async () => {
    api.listTemplates.mockResolvedValue([]);
    api.listAllElections.mockResolvedValue([ACTIVA]);
    api.stopElection.mockResolvedValue({});
    const usuario = await abrir('Elecciones');
    await usuario.click(await screen.findByRole('button', { name: 'Detener' }));
    expect(api.stopElection).toHaveBeenCalledWith('jwt-admin', 9);
    expect(await screen.findByText(/Elección detenida/)).toBeInTheDocument();
  });

  it('una elección cerrada no ofrece detenerse', async () => {
    api.listTemplates.mockResolvedValue([]);
    api.listAllElections.mockResolvedValue([{ ...ACTIVA, status: 'closed' }]);
    await abrir('Elecciones');
    await screen.findByText('Consejo');
    expect(screen.queryByRole('button', { name: 'Detener' })).not.toBeInTheDocument();
  });
});

describe('Usuarios', () => {
  it('crea un auditor; la contraseña no se ve y exige 10 caracteres', async () => {
    api.createAdminUser.mockResolvedValue({});
    const usuario = await abrir('Usuarios');
    const clave = campo('Contraseña (mínimo 10 caracteres)');
    expect(clave).toHaveAttribute('type', 'password');
    expect(clave).toHaveAttribute('minLength', '10');

    await usuario.type(campo('Usuario'), 'auditora');
    await usuario.type(clave, 'una-clave-larga');
    await usuario.selectOptions(campo('Rol'), 'auditor');
    await usuario.click(screen.getByRole('button', { name: 'Crear usuario' }));
    expect(api.createAdminUser).toHaveBeenCalledWith('jwt-admin', 'auditora', 'una-clave-larga', 'auditor', {});
    expect(await screen.findByText('Usuario "auditora" (auditor) creado correctamente.')).toBeInTheDocument();
    expect(clave).toHaveValue('');
  });

  it('un jurado se crea con su puesto y su mesa', async () => {
    api.createAdminUser.mockResolvedValue({});
    api.listUsers.mockResolvedValue({ users: [] });
    const usuario = await abrir('Usuarios');
    expect(screen.queryByText('Mesa', { selector: 'label' })).not.toBeInTheDocument();
    await usuario.type(campo('Usuario'), 'jurado.mesa1');
    await usuario.type(campo('Contraseña (mínimo 10 caracteres)'), 'una-clave-larga');
    await usuario.selectOptions(campo('Rol'), 'jurado');
    await usuario.type(campo('Puesto de votación'), 'Puesto Central');
    await usuario.type(campo('Mesa'), 'Mesa 1');
    await usuario.click(screen.getByRole('button', { name: 'Crear usuario' }));
    expect(api.createAdminUser).toHaveBeenCalledWith('jwt-admin', 'jurado.mesa1', 'una-clave-larga', 'jurado', {
      pollingPlace: 'Puesto Central',
      votingTable: 'Mesa 1',
    });
    expect(await screen.findByText('Usuario "jurado.mesa1" (jurado de mesa) creado correctamente.')).toBeInTheDocument();
  });

  it('lista los usuarios; a un jurado con autenticador se le puede restablecer, con confirmación', async () => {
    api.listUsers.mockResolvedValue({
      users: [
        { id: 1, username: 'admin', role: 'admin', polling_place: null, voting_table: null, has_totp: false },
        { id: 5, username: 'jurado.mesa1', role: 'jurado', polling_place: 'Puesto Central', voting_table: 'Mesa 1', has_totp: true },
        { id: 6, username: 'jurado.mesa2', role: 'jurado', polling_place: 'Puesto Central', voting_table: 'Mesa 2', has_totp: false },
      ],
    });
    api.resetUserTotp.mockResolvedValue({});
    const usuario = await abrir('Usuarios');
    const fila = (await screen.findByText('jurado.mesa1')).closest('tr');
    expect(fila).toHaveTextContent('Puesto Central — Mesa 1');
    expect(fila).toHaveTextContent('Registrado');
    expect(screen.getByText('jurado.mesa2').closest('tr')).toHaveTextContent('Pendiente (primer ingreso)');
    expect(screen.getAllByRole('button', { name: 'Restablecer autenticador' })).toHaveLength(1);

    await usuario.click(within(fila).getByRole('button', { name: 'Restablecer autenticador' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(api.resetUserTotp).toHaveBeenCalledWith('jwt-admin', 5);
  });
});

describe('Padrón', () => {
  beforeEach(() => api.listVoters.mockResolvedValue({ voters: [] }));

  async function cargar(usuario, texto) {
    const area = campo('Votantes a cargar');
    await usuario.clear(area);
    await usuario.type(area, texto);
    await usuario.click(screen.getByRole('button', { name: 'Cargar al padrón' }));
  }

  it('lee una fila por votante, sin espacios de más, y descarta las incompletas', async () => {
    api.uploadVoters.mockResolvedValue({ inserted: 1, updated: 0, accessCodes: [] });
    const usuario = await abrir('Padrón');
    await cargar(usuario, ' 1000000010 , Ana Gómez , Puesto Norte , Mesa 2 {enter}1000000011, Sin puesto{enter}{enter}');
    // Sin vencimiento elegido (el servidor no sugirió ninguno), se manda vacío y el servidor usa el suyo.
    expect(api.uploadVoters).toHaveBeenCalledWith('jwt-admin', [
      { cedula: '1000000010', fullName: 'Ana Gómez', pollingPlace: 'Puesto Norte', votingTable: 'Mesa 2' },
    ], undefined);
    expect(await screen.findByText('Padrón actualizado: 1 nuevos, 0 actualizados.')).toBeInTheDocument();
  });

  it('sin ninguna fila válida, explica el formato y no llama al servicio', async () => {
    const usuario = await abrir('Padrón');
    await cargar(usuario, 'solo-una-columna');
    expect(screen.getByText(/No se reconoció ninguna fila válida/)).toBeInTheDocument();
    expect(api.uploadVoters).not.toHaveBeenCalled();
  });

  it('muestra los PIN generados una sola vez, y el listado solo dice si tiene PIN', async () => {
    api.uploadVoters.mockResolvedValue({ inserted: 1, updated: 0, accessCodes: [{ cedula: '1000000010', pin: '482913' }] });
    api.listVoters
      .mockResolvedValueOnce({ voters: [] })
      .mockResolvedValue({ voters: [{ id: 1, cedula: '1000000010', full_name: 'Ana Gómez', polling_place: 'Puesto Norte', voting_table: 'Mesa 2', is_active: true, has_pin: true }] });
    const usuario = await abrir('Padrón');
    await cargar(usuario, '1000000010, Ana Gómez, Puesto Norte, Mesa 2');

    const panel = (await screen.findByText('PIN de acceso generados')).closest('.panel');
    expect(within(panel).getByText('482913')).toBeInTheDocument();
    const listado = (await screen.findByText('Ana Gómez')).closest('tr');
    expect(within(listado).getByText('Asignado (sin vencimiento)')).toBeInTheDocument();
    expect(listado).not.toHaveTextContent('482913');

    // Al cambiar de pestaña y volver, el PIN ya no está en ninguna parte.
    await usuario.click(screen.getByRole('button', { name: 'Resumen' }));
    await usuario.click(screen.getByRole('button', { name: 'Padrón' }));
    await screen.findByText('Ana Gómez');
    expect(screen.queryByText('482913')).not.toBeInTheDocument();
  });

  it('regenerar un PIN pide confirmación, porque invalida el anterior', async () => {
    api.listVoters.mockResolvedValue({ voters: [{ id: 7, cedula: '1000000010', full_name: 'Ana Gómez', polling_place: 'P', voting_table: 'M', is_active: true, has_pin: true }] });
    window.confirm.mockReturnValue(false);
    const usuario = await abrir('Padrón');
    await usuario.click(await screen.findByRole('button', { name: 'Regenerar PIN' }));
    expect(api.resetVoterPin).not.toHaveBeenCalled();

    window.confirm.mockReturnValue(true);
    api.resetVoterPin.mockResolvedValue({ cedula: '1000000010', pin: '771204' });
    await usuario.click(screen.getByRole('button', { name: 'Regenerar PIN' }));
    expect(api.resetVoterPin).toHaveBeenCalledWith('jwt-admin', 7, undefined);
    expect(await screen.findByText('771204')).toBeInTheDocument();
  });
});

describe('Padrón: vencimiento del PIN', () => {
  // Dentro de los 90 días que admite el campo (el servidor nunca sugiere más).
  const CIERRE = new Date(Math.ceil((Date.now() + 10 * 24 * 3600 * 1000) / 60000) * 60000);
  const sugerencia = (titulo = 'Consulta 2030') => ({ suggested: CIERRE.toISOString(), electionTitle: titulo, maxDays: 90, windowMinutesBefore: 60 });
  const votante = (cambios) => ({ id: 7, cedula: '1000000010', full_name: 'Ana Gómez', polling_place: 'P', voting_table: 'M', is_active: true, has_pin: true, has_totp: false, assisted: false, ...cambios });
  const campoVencimiento = () => campo('Vencimiento de los PIN que se generen');

  it('propone el cierre de la última elección programada y lo manda al cargar; los PIN muestran cuándo vencen', async () => {
    api.listVoters.mockResolvedValue({ voters: [], pinExpiry: sugerencia() });
    api.uploadVoters.mockResolvedValue({ inserted: 1, updated: 0, accessCodes: [{ cedula: '1000000010', pin: '482913' }], pinExpiresAt: CIERRE.toISOString() });
    const usuario = await abrir('Padrón');
    expect(await screen.findByText(/Sugerido: el cierre de «Consulta 2030»/)).toBeInTheDocument();
    expect(new Date(campoVencimiento().value).getTime()).toBe(CIERRE.getTime());

    await usuario.click(screen.getByRole('button', { name: 'Cargar al padrón' }));
    expect(api.uploadVoters.mock.calls[0][2]).toBe(CIERRE.toISOString());
    const panel = (await screen.findByText('PIN de acceso generados')).closest('.panel');
    expect(panel).toHaveTextContent(`Vencen el ${formatPinExpiry(CIERRE)}`);
  });

  it('el administrador elige otra fecha, y vale también para regenerar un PIN', async () => {
    api.listVoters.mockResolvedValue({ voters: [votante({ pin_expires_at: CIERRE.toISOString() })], pinExpiry: sugerencia() });
    const elegida = new Date(CIERRE.getTime() - 3 * 24 * 3600 * 1000);
    api.resetVoterPin.mockResolvedValue({ cedula: '1000000010', pin: '771204', pinExpiresAt: elegida.toISOString() });
    const usuario = await abrir('Padrón');
    await screen.findByText('Ana Gómez');
    const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await usuario.clear(campoVencimiento());
    await usuario.type(campoVencimiento(), local(elegida));
    await usuario.click(screen.getByRole('button', { name: 'Regenerar PIN' }));
    expect(api.resetVoterPin).toHaveBeenCalledWith('jwt-admin', 7, elegida.toISOString());
  });

  it('el listado dice si el PIN vence, ya venció o es de antes del vencimiento', async () => {
    api.listVoters.mockResolvedValue({
      voters: [
        votante({ id: 1, full_name: 'Con fecha', pin_expires_at: CIERRE.toISOString() }),
        votante({ id: 2, full_name: 'PIN del año pasado', cedula: '2', pin_expires_at: '2020-01-01T00:00:00Z' }),
        votante({ id: 3, full_name: 'Viejo', cedula: '3', pin_expires_at: null }),
        votante({ id: 4, full_name: 'Sin PIN', cedula: '4', has_pin: false, pin_expires_at: null }),
      ],
      pinExpiry: sugerencia(null),
    });
    await abrir('Padrón');
    const fila = async (nombre) => (await screen.findByText(nombre)).closest('tr');
    expect(await fila('Con fecha')).toHaveTextContent(`Vence ${formatPinExpiry(CIERRE)}`);
    expect(within(await fila('PIN del año pasado')).getByText('Vencido')).toBeInTheDocument();
    expect(await fila('Viejo')).toHaveTextContent('Asignado (sin vencimiento)');
    expect(await fila('Sin PIN')).toHaveTextContent('Sin asignar');
    expect(screen.getByText(/No hay elecciones programadas: se sugieren 24 horas/)).toBeInTheDocument();
  });
});

describe('Padrón: segundo factor y voto asistido', () => {
  const votante = (cambios) => ({ id: 7, cedula: '1000000010', full_name: 'Ana Gómez', polling_place: 'P', voting_table: 'M', is_active: true, has_pin: true, has_totp: false, assisted: false, ...cambios });

  it('muestra si registró el autenticador, y se lo restablece con confirmación', async () => {
    api.listVoters.mockResolvedValue({ voters: [votante({ has_totp: true })] });
    api.resetVoterTotp.mockResolvedValue({});
    const usuario = await abrir('Padrón');
    const fila = (await screen.findByText('Ana Gómez')).closest('tr');
    expect(fila).toHaveTextContent('Registrado');
    await usuario.click(within(fila).getByRole('button', { name: 'Restablecer autenticador' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(api.resetVoterTotp).toHaveBeenCalledWith('jwt-admin', 7);
    expect(await screen.findByText('Autenticador de Ana Gómez restablecido.')).toBeInTheDocument();
  });

  it('marcar el voto asistido pide confirmación y avisa que lo autoriza el jurado', async () => {
    api.listVoters.mockResolvedValue({ voters: [votante()] });
    api.setVoterAssisted.mockResolvedValue({ id: 7, assisted: true });
    window.confirm.mockReturnValue(false);
    const usuario = await abrir('Padrón');
    const casilla = await screen.findByRole('checkbox', { name: 'Voto asistido de Ana Gómez' });
    await usuario.click(casilla);
    expect(api.setVoterAssisted).not.toHaveBeenCalled();
    expect(window.confirm.mock.calls[0][0]).toMatch(/autorización del jurado de su mesa/);

    window.confirm.mockReturnValue(true);
    await usuario.click(casilla);
    expect(api.setVoterAssisted).toHaveBeenCalledWith('jwt-admin', 7, true);
    expect(await screen.findByText('Ana Gómez votará asistido.')).toBeInTheDocument();
  });

  it('un votante asistido no usa autenticador: no se ofrece restablecerlo', async () => {
    api.listVoters.mockResolvedValue({ voters: [votante({ has_totp: true, assisted: true })] });
    await abrir('Padrón');
    const fila = (await screen.findByText('Ana Gómez')).closest('tr');
    expect(fila).toHaveTextContent('No lo usa');
    expect(within(fila).getByRole('checkbox')).toBeChecked();
    expect(within(fila).queryByRole('button', { name: 'Restablecer autenticador' })).not.toBeInTheDocument();
  });
});

describe('Auditoría', () => {
  const evento = (id) => ({ id, event_type: 'LOGIN_FAILURE_VOTER', actor_type: 'voter', actor_ref: `hash-${id}`, ip_address: '10.0.0.5', created_at: '2026-10-05T14:00:00Z' });

  it('pagina de a 25 eventos', async () => {
    api.listAuditLog.mockImplementation((token, limit, offset) => Promise.resolve({ events: [evento(offset + 1)], total: 30 }));
    const usuario = await abrir('Auditoría');
    expect(await screen.findByText('Página 1 de 2 · 30 eventos')).toBeInTheDocument();
    expect(api.listAuditLog).toHaveBeenLastCalledWith('jwt-admin', 25, 0);
    expect(screen.getByRole('button', { name: '← Anterior' })).toBeDisabled();

    await usuario.click(screen.getByRole('button', { name: 'Siguiente →' }));
    expect(await screen.findByText('Página 2 de 2 · 30 eventos')).toBeInTheDocument();
    expect(api.listAuditLog).toHaveBeenLastCalledWith('jwt-admin', 25, 25);
    expect(screen.getByText('hash-26')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Siguiente →' })).toBeDisabled();
  });

  it('sin eventos, lo dice', async () => {
    api.listAuditLog.mockResolvedValue({ events: [], total: 0 });
    await abrir('Auditoría');
    expect(await screen.findByText('Sin eventos registrados.')).toBeInTheDocument();
  });
});

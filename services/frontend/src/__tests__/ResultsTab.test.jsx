// Pestaña de resultados (administrador y auditor) con el sello de veracidad
// del acta: lo calcula analytics-service por su cuenta (firma digital,
// cadena de hashes, reconteo) y la pantalla solo puede mostrarlo en verde
// si el informe dice que todo cuadra.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResultsTab } from '../pages/AdminDashboard.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const ADMIN = { role: 'admin', token: 'jwt-admin' };
const AUDITOR = { role: 'auditor', token: 'jwt-auditor' };
const ELECCIONES = [
  { id: 1, title: 'Consejo estudiantil', status: 'certified' },
  { id: 2, title: 'Representante', status: 'active' },
  { id: 3, title: 'Personero', status: 'certified' },
];
const CERTIFICADA = {
  certified: true,
  totalVotes: 120,
  recordHash: 'ab'.repeat(32),
  results: [{ optionId: 10, label: 'Lista A', votes: 70 }, { optionId: 11, label: 'Lista B', votes: 50 }],
};
const EN_VIVO = { certified: false, results: [{ optionId: 20, label: 'Ana', votes: 3 }] };
const INTEGRA = { state: 'integra', publicKeyId: 'a1b2c3d4e5f60718', problems: [], votes: { storedTotal: 120 } };

// Deja una promesa en manos de la prueba, para decidir cuándo se resuelve.
function diferida() {
  let resolver;
  const promesa = new Promise((r) => { resolver = r; });
  return { promesa, resolver };
}

async function elegir(usuario, sesion, id) {
  render(<ResultsTab session={sesion} />);
  await screen.findByRole('option', { name: 'Consejo estudiantil (certified)' });
  await usuario.selectOptions(screen.getByRole('combobox'), String(id));
}

beforeEach(() => {
  reiniciarApiFalsa(api);
  api.listAllElections.mockResolvedValue(ELECCIONES);
  api.getResults.mockImplementation((token, id) => Promise.resolve(id === '2' ? EN_VIVO : CERTIFICADA));
});

it('un acta verificada se muestra en verde, con la clave que la firmó', async () => {
  api.getIntegrity.mockResolvedValue(INTEGRA);
  await elegir(userEvent.setup(), ADMIN, 1);

  const sello = (await screen.findByText('✓ Acta verificada')).closest('.acta-seal');
  expect(sello).toHaveClass('tone-ok');
  expect(sello).toHaveTextContent('a1b2c3d4e5f60718');
  expect(api.getIntegrity).toHaveBeenCalledWith('jwt-admin', '1');
});

it('un acta alterada se muestra en rojo, con cada problema y el aviso de que no es oficial', async () => {
  api.getIntegrity.mockResolvedValue({
    state: 'alterada',
    problems: ['El contenido del acta no coincide con su hash', 'Mesa 2: el acta dice 40 votos y hay 38 guardados'],
  });
  await elegir(userEvent.setup(), ADMIN, 1);

  const sello = (await screen.findByText('✘ Acta alterada')).closest('.acta-seal');
  expect(sello).toHaveClass('tone-bad');
  expect(sello).toHaveTextContent('El contenido del acta no coincide con su hash');
  expect(sello).toHaveTextContent('Mesa 2: el acta dice 40 votos y hay 38 guardados');
  expect(sello).toHaveTextContent('no deben tomarse como oficiales');
});

it('un acta sin firma digital queda en "atención", no en verde', async () => {
  api.getIntegrity.mockResolvedValue({ state: 'sin_firma', problems: [], votes: { storedTotal: 120 } });
  await elegir(userEvent.setup(), ADMIN, 1);
  expect((await screen.findByText('⚠ Acta sin firma digital')).closest('.acta-seal')).toHaveClass('tone-warn');
});

it('si no se puede verificar, lo dice en rojo: nunca lo da por bueno', async () => {
  api.getIntegrity.mockRejectedValue(new Error('No se pudo contactar el servicio "analytics".'));
  await elegir(userEvent.setup(), ADMIN, 1);
  const sello = (await screen.findByText('✘ No se pudo verificar el acta')).closest('.acta-seal');
  expect(sello).toHaveClass('tone-bad');
  expect(sello).toHaveTextContent('No se pudo contactar el servicio "analytics".');
});

it('un estado que la pantalla no conoce no muestra ningún sello', async () => {
  api.getIntegrity.mockResolvedValue({ state: 'desconocido', problems: [] });
  await elegir(userEvent.setup(), ADMIN, 1);
  await screen.findByText('Lista A');
  expect(document.querySelector('.acta-seal.tone-ok')).toBeNull();
  expect(screen.queryByText(/Acta verificada/)).not.toBeInTheDocument();
});

it('una elección en curso se muestra "en vivo", sin sello ni acta', async () => {
  await elegir(userEvent.setup(), ADMIN, 2);
  expect(await screen.findByText('En vivo')).toBeInTheDocument();
  expect(screen.getByText('Ana')).toBeInTheDocument();
  expect(api.getIntegrity).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Descargar Acta/ })).not.toBeInTheDocument();
});

it('si se cambia de elección antes de que llegue la verificación, no muestra el sello de la anterior', async () => {
  const verificacion = diferida();
  api.getIntegrity.mockReturnValue(verificacion.promesa);
  const usuario = userEvent.setup();
  await elegir(usuario, ADMIN, 1);
  await screen.findByText('Verificando la firma y la integridad del acta…');

  await usuario.selectOptions(screen.getByRole('combobox'), '2');
  await screen.findByText('En vivo');
  // La verificación de la elección 1 llega tarde, cuando ya se ve la 2.
  await act(async () => {
    verificacion.resolver(INTEGRA);
    await verificacion.promesa;
  });

  expect(screen.queryByText('✓ Acta verificada')).not.toBeInTheDocument();
});

it('la verificación atrasada de la elección anterior no borra el sello de la actual', async () => {
  const de1 = diferida();
  const de3 = diferida();
  api.getIntegrity.mockImplementation((token, id) => (id === '1' ? de1.promesa : de3.promesa));
  const usuario = userEvent.setup();
  await elegir(usuario, ADMIN, 1);
  await usuario.selectOptions(screen.getByRole('combobox'), '3');

  // Primero llega la de la 3 (la que se está viendo) y después la de la 1.
  await act(async () => {
    de3.resolver({ state: 'alterada', problems: ['El contenido del acta no coincide con su hash'] });
    await de3.promesa;
  });
  expect(screen.getByText('✘ Acta alterada')).toBeInTheDocument();
  await act(async () => {
    de1.resolver(INTEGRA);
    await de1.promesa;
  });

  expect(screen.getByText('✘ Acta alterada')).toBeInTheDocument();
  expect(screen.queryByText('✓ Acta verificada')).not.toBeInTheDocument();
});

it('solo el administrador puede descargar el acta en PDF; el auditor no', async () => {
  api.getIntegrity.mockResolvedValue(INTEGRA);
  const usuario = userEvent.setup();
  const { unmount } = render(<ResultsTab session={ADMIN} />);
  await screen.findByRole('option', { name: 'Consejo estudiantil (certified)' });
  await usuario.selectOptions(screen.getByRole('combobox'), '1');
  expect(await screen.findByRole('button', { name: /Descargar Acta de Escrutinio/ })).toBeInTheDocument();
  unmount();

  await elegir(usuario, AUDITOR, 1);
  await screen.findByText('✓ Acta verificada');
  expect(screen.queryByRole('button', { name: /Descargar Acta/ })).not.toBeInTheDocument();
});

it('si la descarga del acta falla, muestra el motivo', async () => {
  api.getIntegrity.mockResolvedValue(INTEGRA);
  api.downloadActaPdf.mockRejectedValue(new Error('Error 500 al generar el acta'));
  const usuario = userEvent.setup();
  await elegir(usuario, ADMIN, 1);
  await usuario.click(await screen.findByRole('button', { name: /Descargar Acta de Escrutinio/ }));
  expect(api.downloadActaPdf).toHaveBeenCalledWith('jwt-admin', '1');
  expect(await screen.findByText('Error 500 al generar el acta')).toBeInTheDocument();
});

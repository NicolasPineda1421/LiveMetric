// Pestaña Escrutinio del administrador: verifica todas las actas (hash,
// cadena y firma digital) y señala cuáles fueron alteradas.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminDashboard from '../pages/AdminDashboard.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const acta = (electionId, cambios = {}) => ({
  electionId,
  title: `Elección ${electionId}`,
  certifiedAt: '2026-09-01T18:00:00Z',
  hashOk: true,
  linkOk: true,
  signature: 'valida',
  verdict: 'verificada',
  problems: [],
  ...cambios,
});

async function verificar(respuesta) {
  api.verifyChain.mockResolvedValue(respuesta);
  const usuario = userEvent.setup();
  render(<AdminDashboard session={{ role: 'admin', token: 'jwt-admin', username: 'admin' }} onLogout={jest.fn()} />);
  await usuario.click(screen.getByRole('button', { name: 'Escrutinio' }));
  await usuario.click(screen.getByRole('button', { name: 'Verificar actas' }));
  expect(api.verifyChain).toHaveBeenCalledWith('jwt-admin');
}

const filaDe = (electionId) => screen.getByText(`#${electionId} Elección ${electionId}`).closest('tr');

beforeEach(() => reiniciarApiFalsa(api));

it('con todas las actas firmadas e intactas, lo confirma', async () => {
  await verificar({ valid: true, totalRecords: 2, unsigned: 0, publicKeyId: 'a1b2c3d4e5f60718', records: [acta(1), acta(2)] });
  expect(await screen.findByText(/Ninguna acta fue alterada: 2 acta\(s\) certificada\(s\), todas con firma digital válida\./)).toBeInTheDocument();
  expect(within(filaDe(1)).getByText('Verificada')).toHaveClass('tone-ok');
  expect(screen.getByText('a1b2c3d4e5f60718')).toBeInTheDocument();
});

it('cuenta las actas sin firma (anteriores a la firma digital) sin darlas por alteradas', async () => {
  await verificar({
    valid: true,
    totalRecords: 2,
    unsigned: 1,
    publicKeyId: 'a1b2c3d4e5f60718',
    records: [acta(1, { signature: 'sin_firma', verdict: 'sin_firma' }), acta(2)],
  });
  expect(await screen.findByText(/1 de ellas sin firma digital/)).toBeInTheDocument();
  expect(within(filaDe(1)).getByText('Sin firma digital')).toHaveClass('tone-warn');
});

it('señala cada acta alterada, con qué falló y el aviso de que no es oficial', async () => {
  await verificar({
    valid: false,
    totalRecords: 3,
    unsigned: 0,
    publicKeyId: 'a1b2c3d4e5f60718',
    records: [
      acta(1),
      acta(2, { hashOk: false, signature: 'invalida', verdict: 'alterada', problems: ['El contenido del acta no coincide con su hash'] }),
      acta(3, { linkOk: false, verdict: 'alterada', problems: ['La cadena se rompe en esta acta'] }),
    ],
  });
  expect(await screen.findByText('Se detectaron actas alteradas: #2, #3. No deben tomarse como oficiales.')).toBeInTheDocument();

  const fila2 = filaDe(2);
  expect(within(fila2).getByText('✘ Modificado')).toBeInTheDocument();
  expect(within(fila2).getByText('✘ No corresponde al acta')).toBeInTheDocument();
  expect(within(fila2).getByText('Alterada')).toHaveClass('tone-bad');
  expect(within(fila2).getByText('El contenido del acta no coincide con su hash')).toBeInTheDocument();
  expect(within(filaDe(3)).getByText('✘ Rota')).toBeInTheDocument();
  expect(within(filaDe(1)).getByText('Verificada')).toBeInTheDocument();
});

it('sin actas todavía, lo dice', async () => {
  await verificar({ valid: true, totalRecords: 0, unsigned: 0, publicKeyId: 'a1b2c3d4e5f60718', records: [] });
  expect(await screen.findByText('Todavía no hay actas certificadas.')).toBeInTheDocument();
});

it('si la verificación falla, muestra el error y no un resultado', async () => {
  api.verifyChain.mockRejectedValue(new Error('No se pudo contactar el servicio "scrutiny".'));
  const usuario = userEvent.setup();
  render(<AdminDashboard session={{ role: 'admin', token: 'jwt-admin', username: 'admin' }} onLogout={jest.fn()} />);
  await usuario.click(screen.getByRole('button', { name: 'Escrutinio' }));
  await usuario.click(screen.getByRole('button', { name: 'Verificar actas' }));
  expect(await screen.findByText('No se pudo contactar el servicio "scrutiny".')).toBeInTheDocument();
  expect(screen.queryByText(/Ninguna acta fue alterada/)).not.toBeInTheDocument();
});

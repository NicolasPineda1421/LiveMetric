// Widget de los tableros: pide su propia fuente de datos y la muestra según
// su tipo. Los de gráficos (Recharts) no se prueban aquí: necesitan medir el
// tamaño del contenedor, que jsdom no tiene.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Widget from '../components/widgets/Widget.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const SESION = { role: 'auditor', token: 'jwt-auditor' };
const widget = (cambios) => ({ id: 'w1', type: 'kpi', title: 'Mi widget', dataSource: 'results', params: {}, ...cambios });

beforeEach(() => reiniciarApiFalsa(api));

it('el KPI de integridad muestra el veredicto del acta con su color', async () => {
  api.getIntegrity.mockResolvedValue({
    state: 'alterada',
    problems: ['El contenido del acta no coincide con su hash'],
    record: { signature: 'invalida', hashOk: false, linkOk: true },
    chain: { valid: true, totalRecords: 1, brokenElectionIds: [] },
    votes: { totalMatches: true, storedTotal: 5, certifiedTotal: 5, optionDiffs: [], tableDiffs: [] },
    recordHash: 'a'.repeat(64),
    certifiedAt: '2026-10-05T22:00:00Z',
  });
  render(<Widget session={SESION} electionId="3" config={widget({ title: 'Integridad', dataSource: 'integrity' })} />);
  expect(await screen.findByText('✘ Alterada')).toHaveClass('widget-kpi-value', 'tone-bad');
  expect(screen.getByText('El contenido del acta no coincide con su hash')).toBeInTheDocument();
  expect(api.getIntegrity).toHaveBeenCalledWith('jwt-auditor', '3');
});

it('una tabla muestra las filas que arma el adaptador', async () => {
  api.getResults.mockResolvedValue({ results: [{ label: 'Lista A', votes: 3 }, { label: 'Lista B', votes: 1 }] });
  render(<Widget session={SESION} electionId="3" config={widget({ type: 'table', dataSource: 'concentration' })} />);
  expect(await screen.findByText('75.0%')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '% del total' })).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(3);
});

it('una tabla vacía muestra el mensaje de la fuente', async () => {
  api.getSuspiciousAccess.mockResolvedValue({ alerts: [], totals: { attempts: 3, failures: 0, failureRatePct: 0 } });
  render(<Widget session={SESION} electionId="3" config={widget({ type: 'table', dataSource: 'suspiciousAccess' })} />);
  expect(await screen.findByText(/Sin alertas: ningún patrón de ingresos fallidos/)).toBeInTheDocument();
});

it('cada fuente consulta su endpoint, con sus parámetros', async () => {
  const casos = [
    ['timeseries', { interval: 'day' }, api.getTimeseries, ['jwt-auditor', '3', 'day']],
    ['participation', { groupBy: 'voting_table' }, api.getParticipation, ['jwt-auditor', '3', 'voting_table']],
    ['participationRate', {}, api.getOperationalMetrics, ['jwt-auditor', '3']],
    ['audit', {}, api.getAuditMetrics, ['jwt-auditor', '3']],
    ['turnoutProjection', {}, api.getTurnoutProjection, ['jwt-auditor', '3']],
    ['leadTimeline', {}, api.getLeadTimeline, ['jwt-auditor', '3']],
  ];
  for (const [dataSource, params, endpoint, argumentos] of casos) {
    const { unmount } = render(<Widget session={SESION} electionId="3" config={widget({ dataSource, params })} />);
    expect(endpoint).toHaveBeenCalledWith(...argumentos);
    unmount();
  }
});

it('si la fuente falla, muestra el error en el widget', async () => {
  api.getResults.mockRejectedValue(new Error('No se pudo contactar el servicio "analytics".'));
  render(<Widget session={SESION} electionId="3" config={widget()} />);
  expect(await screen.findByText('No se pudo contactar el servicio "analytics".')).toBeInTheDocument();
});

it('mientras carga, se marca como "cargando" (la exportación a PDF espera a que termine)', () => {
  const { container } = render(<Widget session={SESION} electionId="3" config={widget()} />);
  expect(container.querySelector('.widget-loading')).toBeInTheDocument();
});

it('los botones de configurar y quitar aparecen solo si el tablero es editable', async () => {
  api.getResults.mockResolvedValue({ results: [] });
  const onRemove = jest.fn();
  const onConfigure = jest.fn();
  const config = widget();
  const { unmount } = render(<Widget session={SESION} electionId="3" config={config} />);
  expect(screen.queryByTitle('Quitar')).not.toBeInTheDocument();
  expect(screen.queryByTitle('Configurar')).not.toBeInTheDocument();
  unmount();

  const usuario = userEvent.setup();
  render(<Widget session={SESION} electionId="3" config={config} onRemove={onRemove} onConfigure={onConfigure} />);
  await usuario.click(screen.getByTitle('Configurar'));
  await usuario.click(screen.getByTitle('Quitar'));
  expect(onConfigure).toHaveBeenCalledWith(config);
  expect(onRemove).toHaveBeenCalledWith('w1');
});

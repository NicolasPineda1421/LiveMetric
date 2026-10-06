// adaptForWidgets: traduce la respuesta de cada fuente de analytics-service
// a lo que muestran los widgets de los tableros. Lo más delicado es el
// widget de integridad: es el indicador de veracidad del acta, y solo puede
// quedar en verde si todo cuadra.
import { adaptForWidgets, HIDDEN_RESULTS_NOTE } from '../components/widgets/dataAdapters.js';

const fila = (tabla, titulo) => tabla.rows.find((r) => r[0] === titulo);

// Informe de integridad de un acta que está bien en todo; cada caso cambia
// solo lo que prueba.
function informe(cambios = {}) {
  return {
    state: 'integra',
    status: 'certified',
    publicKeyId: 'a1b2c3d4e5f60718',
    signingKeyId: 'a1b2c3d4e5f60718',
    recordHash: 'f'.repeat(64),
    certifiedAt: '2026-09-01T18:00:00Z',
    problems: [],
    record: { signature: 'valida', hashOk: true, linkOk: true },
    chain: { valid: true, totalRecords: 3, brokenElectionIds: [] },
    votes: { totalMatches: true, storedTotal: 120, certifiedTotal: 120, optionDiffs: [], tableDiffs: [] },
    ...cambios,
  };
}

describe('integridad del acta (indicador de veracidad)', () => {
  it('verde solo con firma válida, contenido intacto y votos que coinciden', () => {
    const { kpi, table } = adaptForWidgets('integrity', informe());
    expect(kpi).toMatchObject({ value: '✔ Verificada', tone: 'ok' });
    expect(fila(table, 'Firma digital del acta')[1]).toBe('✔ Válida (clave a1b2c3d4e5f60718)');
    expect(fila(table, 'Contenido del acta contra su hash')[1]).toBe('✔ Coincide');
    expect(fila(table, 'Cadena completa de actas')[1]).toBe('✔ Íntegra (3 actas)');
    expect(fila(table, 'Votos guardados contra certificados')[1]).toBe('✔ 120 = 120');
  });

  it('un acta sin firma no queda en verde, aunque su contenido esté intacto', () => {
    const { kpi, table } = adaptForWidgets('integrity', informe({ state: 'sin_firma', record: { signature: 'sin_firma', hashOk: true, linkOk: true } }));
    expect(kpi.value).toBe('⚠ Sin firma');
    expect(kpi.tone).toBeUndefined();
    expect(fila(table, 'Firma digital del acta')[1]).toMatch(/^⚠ Sin firma/);
  });

  it('un acta modificada queda en rojo, con el motivo y cada diferencia de votos', () => {
    const { kpi, table } = adaptForWidgets(
      'integrity',
      informe({
        state: 'alterada',
        problems: ['El contenido del acta no coincide con su hash', 'La firma digital no corresponde al acta'],
        record: { signature: 'invalida', hashOk: false, linkOk: true },
        votes: {
          totalMatches: false,
          storedTotal: 118,
          certifiedTotal: 120,
          optionDiffs: [{ label: 'Candidata Uno', certified: 70, stored: 68 }],
          tableDiffs: [{ table: 'Mesa 2', certified: 40, stored: 38 }],
        },
      }),
    );
    expect(kpi).toMatchObject({ value: '✘ Alterada', tone: 'bad', note: 'El contenido del acta no coincide con su hash' });
    expect(fila(table, 'Firma digital del acta')[1]).toBe('✘ No corresponde al acta');
    expect(fila(table, 'Contenido del acta contra su hash')[1]).toBe('✘ No coincide: el acta fue modificada');
    expect(fila(table, 'Votos guardados contra certificados')[1]).toBe('✘ 118 guardados, 120 certificados');
    expect(fila(table, 'Opción "Candidata Uno"')[1]).toBe('✘ Acta: 70 · guardados: 68');
    expect(fila(table, 'Mesa Mesa 2')[1]).toBe('✘ Acta: 40 · guardados: 38');
  });

  it('una firma de otra clave (otra instalación) se señala con esa clave', () => {
    const { table } = adaptForWidgets(
      'integrity',
      informe({ state: 'alterada', problems: ['Firmada con otra clave'], signingKeyId: '9999888877776666', record: { signature: 'otra_clave', hashOk: true, linkOk: true } }),
    );
    expect(fila(table, 'Firma digital del acta')[1]).toBe('✘ De una clave desconocida (9999888877776666)');
  });

  it('dice en qué actas se rompió la cadena', () => {
    const { table } = adaptForWidgets('integrity', informe({ state: 'alterada', problems: ['x'], chain: { valid: false, totalRecords: 5, brokenElectionIds: [3, 5] } }));
    expect(fila(table, 'Cadena completa de actas')[1]).toBe('✘ Rota en #3, #5');
  });

  it('sin acta todavía, explica por qué según el estado de la elección', () => {
    const cerrada = adaptForWidgets('integrity', { state: 'sin_certificar', status: 'closed' });
    const activa = adaptForWidgets('integrity', { state: 'sin_certificar', status: 'active' });
    expect(cerrada.kpi.value).toBe('Sin acta aún');
    expect(cerrada.kpi.note).toBe('La elección cerró pero todavía no se certificó.');
    expect(activa.kpi.note).toBe('El acta se certifica automáticamente cuando cierra la elección.');
    expect(activa.table.rows).toEqual([]);
  });
});

describe('resultados y participación', () => {
  it('results: una barra por opción y el total que informa el servicio', () => {
    const datos = adaptForWidgets('results', { totalVotes: 7, results: [{ label: 'Sí', votes: 4 }, { label: 'No', votes: 3 }] });
    expect(datos.items).toEqual([{ name: 'Sí', value: 4 }, { name: 'No', value: 3 }]);
    expect(datos.kpi.value).toBe(7);
  });

  it('results: sin total en la respuesta, lo suma', () => {
    expect(adaptForWidgets('results', { results: [{ label: 'A', votes: 2 }, { label: 'B', votes: 5 }] }).kpi.value).toBe(7);
  });

  it('participation: porcentaje general y por grupo, sin dividir por cero', () => {
    const { kpi, table } = adaptForWidgets('participation', {
      groups: [
        { group: 'Puesto Central', registered: 200, votesCast: 150 },
        { group: null, registered: 0, votesCast: 0 },
      ],
    });
    expect(kpi.value).toBe('75.0%');
    expect(table.rows[0]).toEqual(['Puesto Central', 200, 150, '75.0%']);
    expect(table.rows[1]).toEqual(['(sin dato)', 0, 0, '—']);
    expect(adaptForWidgets('participation', { groups: [] }).kpi.value).toBe('0.0%');
  });

  it('participation: las barras, en % de cada grupo con el detalle; la torta, los votos de mayor a menor', () => {
    const datos = adaptForWidgets('participation', {
      groups: [
        { group: 'Colegio Andino', registered: 80, votesCast: 20 },
        { group: 'Escuela El Salitre', registered: 30, votesCast: 27 },
        { group: 'Puesto Norte', registered: 1200, votesCast: 0 },
      ],
    });
    expect(datos.unit).toBe('%');
    expect(datos.items).toEqual([
      { name: 'Colegio Andino', value: 25, detail: '20 de 80 habilitados' },
      { name: 'Escuela El Salitre', value: 90, detail: '27 de 30 habilitados' },
      { name: 'Puesto Norte', value: 0, detail: '0 de 1.200 habilitados' },
    ]);
    expect(datos.pieItems).toEqual([{ name: 'Escuela El Salitre', value: 27 }, { name: 'Colegio Andino', value: 20 }]);
  });

  it('participation: sin votos todavía, el gráfico lo dice en lugar de mostrar todo en cero', () => {
    const datos = adaptForWidgets('participation', { groups: [{ group: 'Colegio Andino', registered: 80, votesCast: 0 }] });
    expect(datos.items).toEqual([]);
    expect(datos.emptyMessage).toMatch(/^Todavía no hay votos en esta elección/);
    expect(datos.table.rows).toEqual([['Colegio Andino', 80, 0, '0.0%']]);
  });

  it('concentration: porcentaje de cada opción, y "—" si no hay votos', () => {
    const conVotos = adaptForWidgets('concentration', { concentration: { hhi: 5000, level: 'alta' }, results: [{ label: 'A', votes: 3 }, { label: 'B', votes: 1 }] });
    expect(conVotos.kpi.value).toBe('5000 (alta)');
    expect(conVotos.table.rows).toEqual([['A', 3, '75.0%'], ['B', 1, '25.0%']]);
    const sinVotos = adaptForWidgets('concentration', { results: [{ label: 'A', votes: 0 }] });
    expect(sinVotos.table.rows).toEqual([['A', 0, '—']]);
    expect(sinVotos.kpi.value).toBe('0 (sin datos)');
  });
});

// Sin acta certificada, analytics-service solo informa cuántos votaron: los
// widgets no pueden mostrar votos por opción ni quién va adelante.
describe('resultados ocultos hasta certificar el acta', () => {
  it('results: el total, sin barras ni filas, y el aviso en el KPI y en los gráficos', () => {
    const datos = adaptForWidgets('results', { resultsHidden: true, totalVotes: 42 });
    expect(datos.kpi).toEqual({ label: 'Total de votos', value: 42, note: HIDDEN_RESULTS_NOTE });
    expect(datos.items).toEqual([]);
    expect(datos.table.rows).toEqual([]);
    expect(datos.emptyMessage).toBe(HIDDEN_RESULTS_NOTE);
    expect(datos.table.emptyMessage).toBe(HIDDEN_RESULTS_NOTE);
  });

  it('concentration y leadTimeline: no calculan nada, solo avisan cuándo se publica', () => {
    const hhi = adaptForWidgets('concentration', { resultsHidden: true, totalVotes: 42 });
    expect(hhi.kpi.value).toBe('Al certificar');
    expect(hhi.items).toEqual([]);
    const lider = adaptForWidgets('leadTimeline', { state: 'oculto_hasta_certificar' });
    expect(lider.kpi).toEqual({ label: 'Cambios de primer lugar', value: 'Al certificar', note: HIDDEN_RESULTS_NOTE });
    expect(lider.items).toEqual([]);
    expect(lider.table.rows).toEqual([]);
  });
});

describe('accesos sospechosos', () => {
  const alerta = (severity) => ({ severity, title: 'Muchos PIN fallidos', subject: '10.0.0.5', attempts: 12, from: '2026-09-01T10:00:00Z', to: '2026-09-01T10:05:00Z', detail: '...' });
  const totals = { attempts: 40, failures: 12, failureRatePct: 30 };

  it('rojo si hay alguna alerta alta', () => {
    const { kpi, table } = adaptForWidgets('suspiciousAccess', { alerts: [alerta('media'), alerta('alta')], totals });
    expect(kpi).toMatchObject({ value: '2 alertas', tone: 'bad' });
    expect(kpi.note).toBe('12 de 40 ingresos fallaron (30%) durante la elección.');
    expect(table.rows.map((r) => r[0])).toEqual(['Media', 'Alta']);
  });

  it('solo alertas medias: queda en "atención", ni rojo ni verde', () => {
    const { kpi } = adaptForWidgets('suspiciousAccess', { alerts: [alerta('media')], totals });
    expect(kpi.value).toBe('1 alerta');
    expect(kpi.tone).toBeUndefined();
  });

  it('sin alertas: verde', () => {
    expect(adaptForWidgets('suspiciousAccess', { alerts: [], totals }).kpi).toMatchObject({ value: 'Sin alertas', tone: 'ok' });
  });
});

describe('momento de definición y proyección de participación', () => {
  it('con menos de 5 votos no muestra la evolución (revelaría votos individuales)', () => {
    const { kpi, items } = adaptForWidgets('leadTimeline', { state: 'insuficiente', checkpoints: [] });
    expect(kpi.value).toBe('Menos de 5 votos');
    expect(items).toEqual([]);
  });

  it('dice si hubo cambios de primer lugar', () => {
    const punto = { at: '2026-09-01T10:00:00Z', votesCounted: 10, marginPp: 20, leader: { label: 'A' }, shares: [{ optionId: 1, label: 'A', pct: 60 }] };
    expect(adaptForWidgets('leadTimeline', { state: 'ok', checkpoints: [punto], currentLeader: { label: 'A' }, leadChanges: 0 }).kpi.value).toBe('Sin cambios');
    expect(adaptForWidgets('leadTimeline', { state: 'ok', checkpoints: [punto], currentLeader: null, leadChanges: 2 }).kpi.value).toBe('Empate');
    expect(adaptForWidgets('leadTimeline', { state: 'sin_votos', checkpoints: [] }).kpi.value).toBe('Sin votos todavía');
  });

  it('la proyección solo dibuja la serie proyectada mientras la votación está en curso', () => {
    const base = { currentTurnoutPct: 40, votesSoFar: 80, registered: 200, elapsedPct: 50, curve: [] };
    const enCurso = adaptForWidgets('turnoutProjection', { ...base, state: 'en_curso', projectedTurnoutPct: 70, projectedVotes: 140, interval: { lowPct: 60, highPct: 80 }, method: 'ritmo' });
    const final = adaptForWidgets('turnoutProjection', { ...base, state: 'final' });
    expect(enCurso.kpi).toMatchObject({ label: 'Participación proyectada al cierre', value: '70%' });
    expect(enCurso.series.map((s) => s.key)).toEqual(['actual', 'projected']);
    expect(final.kpi.value).toBe('40%');
    expect(final.series.map((s) => s.key)).toEqual(['actual']);
    expect(final.table.rows.map((r) => r[0])).not.toContain('Jornada transcurrida');
  });
});

describe('entradas inesperadas', () => {
  it('sin datos o con una fuente desconocida devuelve una forma vacía, no un error', () => {
    const vacia = { kpi: { label: 'results', value: '—' }, items: [], table: { columns: [], rows: [] } };
    expect(adaptForWidgets('results', null)).toEqual(vacia);
    expect(adaptForWidgets('__proto__', {})).toEqual({ ...vacia, kpi: { label: '__proto__', value: '—' } });
  });
});

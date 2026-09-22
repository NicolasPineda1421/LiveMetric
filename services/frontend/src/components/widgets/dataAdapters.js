// Traduce la respuesta cruda de cada endpoint de analytics-service a una
// forma genérica que cualquier widget puede consumir, sin que cada
// componente de gráfico necesite conocer la forma de cada fuente de datos.
//
//   kpi:   { label, value }              -> KpiCard
//   items: [{ name, value }]             -> BarChartWidget / PieChartWidget
//   table: { columns: [...], rows: [...] } -> TableWidget

export function adaptForWidgets(dataSource, raw) {
  if (!raw) return emptyShape(dataSource);

  switch (dataSource) {
    case 'results': {
      const items = (raw.results || []).map((r) => ({ name: r.label, value: r.votes }));
      const total = raw.totalVotes ?? items.reduce((s, i) => s + i.value, 0);
      return {
        kpi: { label: 'Total de votos', value: total },
        items,
        table: { columns: ['Opción', 'Votos'], rows: items.map((i) => [i.name, i.value]) },
      };
    }

    // Reutiliza la misma respuesta que "results" (ver fetchDataSource en
    // Widget.jsx); solo cambia qué campo de esa respuesta se muestra.
    case 'concentration': {
      const c = raw.concentration || { hhi: 0, level: 'sin datos' };
      const items = (raw.results || []).map((r) => ({ name: r.label, value: r.votes }));
      const total = items.reduce((s, i) => s + i.value, 0);
      return {
        kpi: { label: 'Concentración de votos (HHI)', value: `${c.hhi} (${c.level})` },
        items,
        table: {
          columns: ['Opción', 'Votos', '% del total'],
          rows: items.map((i) => [i.name, i.value, total ? `${((i.value / total) * 100).toFixed(1)}%` : '—']),
        },
      };
    }

    case 'timeseries': {
      const items = (raw.points || []).map((p) => ({
        name: new Date(p.bucket).toLocaleString(),
        value: p.votes,
      }));
      const total = items.reduce((s, i) => s + i.value, 0);
      return {
        kpi: { label: `Votos (por ${raw.interval === 'day' ? 'día' : 'hora'})`, value: total },
        items,
        table: { columns: ['Momento', 'Votos'], rows: items.map((i) => [i.name, i.value]) },
      };
    }

    // Reutiliza la misma respuesta que "timeseries" (ver fetchDataSource en
    // Widget.jsx); solo cambia qué campo de esa respuesta se muestra. Un
    // punto marcado aquí es una señal para revisar, no una acusación de
    // fraude — puede ser, por ejemplo, la apertura de la elección.
    case 'anomalies': {
      const anomalies = raw.anomalies || [];
      return {
        kpi: { label: 'Picos atípicos detectados', value: anomalies.length },
        items: anomalies.map((a) => ({ name: new Date(a.bucket).toLocaleString(), value: a.votes })),
        table: {
          columns: ['Momento', 'Votos', 'Desvíos estándar del promedio (z)'],
          rows: anomalies.map((a) => [new Date(a.bucket).toLocaleString(), a.votes, a.zScore]),
        },
      };
    }

    case 'participation': {
      const groups = raw.groups || [];
      const items = groups.map((g) => ({ name: g.group || '(sin dato)', value: g.votesCast }));
      const totalRegistered = groups.reduce((s, g) => s + (g.registered || 0), 0);
      const totalCast = groups.reduce((s, g) => s + (g.votesCast || 0), 0);
      const pct = totalRegistered ? ((totalCast / totalRegistered) * 100).toFixed(1) : '0.0';
      return {
        kpi: { label: 'Participación general', value: `${pct}%` },
        items,
        table: {
          columns: ['Grupo', 'Votantes registrados', 'Votos emitidos', '% participación'],
          rows: groups.map((g) => [
            g.group || '(sin dato)',
            g.registered,
            g.votesCast,
            g.registered ? `${((g.votesCast / g.registered) * 100).toFixed(1)}%` : '—',
          ]),
        },
      };
    }

    case 'operational': {
      const items = [
        { name: 'Votos/min', value: raw.votesPerMinute },
        { name: 'Mesas con votos', value: raw.tablesWithVotes },
        { name: 'Total de mesas', value: raw.totalTables },
      ];
      return {
        kpi: { label: 'Votos por minuto', value: raw.votesPerMinute },
        items,
        table: {
          columns: ['Métrica', 'Valor'],
          rows: [
            ['Total de votos', raw.totalVotes],
            ['Votos por minuto', raw.votesPerMinute],
            ['Mesas con votos', `${raw.tablesWithVotes} / ${raw.totalTables}`],
          ],
        },
      };
    }

    // Reutiliza la misma respuesta que "operational" (ver fetchDataSource en
    // Widget.jsx); solo cambia qué campo de esa respuesta se muestra.
    case 'participationRate': {
      const rate = raw.participationRate ?? 0;
      const ci = raw.participationCi95 || { low: 0, high: 0 };
      return {
        kpi: { label: 'Participación (IC 95%)', value: `${rate}% [${ci.low}%–${ci.high}%]` },
        items: [],
        table: {
          columns: ['Métrica', 'Valor'],
          rows: [
            ['Tasa de participación', `${rate}%`],
            ['Intervalo de confianza 95%', `${ci.low}% – ${ci.high}%`],
          ],
        },
      };
    }

    case 'audit': {
      const events = raw.events || [];
      return {
        kpi: { label: 'Eventos de auditoría', value: events.length },
        items: [],
        table: {
          columns: ['Evento', 'Actor', 'Referencia', 'Fecha'],
          rows: events.map((e) => [
            e.event_type,
            e.actor_type,
            e.actor_ref,
            new Date(e.created_at).toLocaleString(),
          ]),
        },
      };
    }

    default:
      return emptyShape(dataSource);
  }
}

function emptyShape(dataSource) {
  return { kpi: { label: dataSource, value: '—' }, items: [], table: { columns: [], rows: [] } };
}

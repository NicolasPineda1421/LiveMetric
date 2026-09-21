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

// Traduce la respuesta cruda de cada endpoint de analytics-service a una
// forma genérica que cualquier widget puede consumir, sin que cada
// componente de gráfico necesite conocer la forma de cada fuente de datos.
//
//   kpi:   { label, value, tone?, note? } -> KpiCard
//   items: [{ name, value }]             -> BarChartWidget / PieChartWidget
//   items + series: [{ key, label }]     -> LineChartWidget con varias series
//   table: { columns: [...], rows: [...], emptyMessage? } -> TableWidget

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

    case 'turnoutProjection': {
      const curve = raw.curve || [];
      const moment = momentFormatter(curve.map((p) => p.at));
      const inProgress = raw.state === 'en_curso';
      const current = `${raw.currentTurnoutPct}% (${raw.votesSoFar} de ${raw.registered} habilitados)`;
      const method =
        raw.method === 'historico'
          ? `Según cómo se repartieron los votos en ${plural(raw.basedOnElections, 'elección anterior', 'elecciones anteriores')}`
          : 'Si el ritmo actual se mantiene. No hay elecciones anteriores comparables, y en una jornada real el ritmo suele bajar al final: tiende a sobrestimar';
      const kpiByState = {
        sin_iniciar: { value: 'Aún no empezó', note: 'La proyección aparece cuando la votación esté en curso.' },
        insuficiente: {
          value: 'Muy pronto',
          note: `Para proyectar hace falta el ${raw.minimums?.elapsedPct}% de la jornada y ${raw.minimums?.votes} votos. Por ahora: ${raw.currentTurnoutPct}%.`,
        },
        final: { value: `${raw.currentTurnoutPct}%`, note: 'Participación final: la votación ya cerró.' },
        en_curso: {
          value: `${raw.projectedTurnoutPct}%`,
          note: `Rango probable ${raw.interval?.lowPct}%–${raw.interval?.highPct}% · ahora ${raw.currentTurnoutPct}%`,
        },
      };
      return {
        kpi: { label: inProgress ? 'Participación proyectada al cierre' : 'Participación', ...kpiByState[raw.state] },
        unit: '%',
        items: curve.map((p) => ({ name: moment(p.at), actual: p.actualPct, projected: p.projectedPct })),
        series: [
          { key: 'actual', label: 'Participación real', color: 'accent' },
          ...(inProgress ? [{ key: 'projected', label: 'Proyección al cierre', color: 'accent', dashed: true }] : []),
        ],
        table: {
          columns: ['Métrica', 'Valor'],
          rows: [
            [raw.state === 'final' ? 'Participación final' : 'Participación hasta ahora', current],
            // En una elección cerrada (incluso detenida antes de tiempo) el
            // % de jornada transcurrida ya no dice nada.
            ...(raw.state === 'final' ? [] : [['Jornada transcurrida', `${raw.elapsedPct}%`]]),
            ...(inProgress
              ? [
                  ['Proyección al cierre', `${raw.projectedTurnoutPct}% (${raw.projectedVotes} votos)`],
                  ['Rango probable', `${raw.interval.lowPct}% – ${raw.interval.highPct}%`],
                  ['Cómo se calcula', method],
                ]
              : [['Estado', kpiByState[raw.state].note]]),
          ],
        },
      };
    }

    case 'leadTimeline': {
      const points = raw.checkpoints || [];
      const moment = momentFormatter(points.map((p) => p.at));
      // Una serie por opción (hasta 8, las de mayor % al final: una por
      // color de la paleta). La clave es el id y no la etiqueta, porque
      // recharts lee "Lic. Pérez" como una ruta anidada por el punto.
      const shown = (points.length ? points[points.length - 1].shares : []).slice(0, 8);
      const changedAt = new Set((raw.changes || []).map((c) => c.at));
      const leader = raw.currentLeader?.label;

      let kpi;
      if (raw.state === 'sin_votos') kpi = { value: 'Sin votos todavía' };
      else if (raw.state === 'insuficiente') {
        kpi = { value: 'Menos de 5 votos', note: 'Con tan pocos votos, mostrar la evolución revelaría votos individuales.' };
      } else if (!leader) kpi = { value: 'Empate', note: `${plural(raw.leadChanges, 'cambio', 'cambios')} de primer lugar hasta ahora.` };
      else if (raw.leadChanges === 0) kpi = { value: 'Sin cambios', note: `${leader} lideró de principio a fin.` };
      else {
        kpi = {
          value: plural(raw.leadChanges, 'cambio', 'cambios'),
          note: `${leader} lidera sin interrupciones desde las ${moment(raw.stableSince.at)}, con el ${raw.stableSince.votesCountedPct}% de los votos contados.`,
        };
      }

      return {
        kpi: { label: 'Cambios de primer lugar', ...kpi },
        unit: '%',
        items: points.map((p) => {
          const row = { name: moment(p.at) };
          for (const share of p.shares) row[`op${share.optionId}`] = share.pct;
          return row;
        }),
        series: shown.map((s) => ({ key: `op${s.optionId}`, label: s.label })),
        table: {
          columns: ['Momento', 'Votos contados', 'Primer lugar', 'Ventaja'],
          rows: points.map((p) => [
            moment(p.at),
            p.votesCounted,
            p.leader ? `${p.leader.label}${changedAt.has(p.at) ? ' ← pasa a liderar' : ''}` : 'Empate',
            `${p.marginPp} pp`,
          ]),
          emptyMessage: kpi.note || kpi.value,
        },
      };
    }

    case 'integrity': {
      if (raw.state === 'sin_certificar') {
        const why =
          raw.status === 'closed'
            ? 'La elección cerró pero todavía no se certificó.'
            : 'El acta se certifica automáticamente cuando cierra la elección.';
        return {
          kpi: { label: 'Integridad del acta', value: 'Sin acta aún', note: why },
          items: [],
          table: { columns: ['Verificación', 'Resultado'], rows: [], emptyMessage: why },
        };
      }
      const intact = raw.state === 'integra';
      const votes = raw.votes;
      const check = (passed, okText, badText) => (passed ? `✔ ${okText}` : `✘ ${badText}`);
      return {
        kpi: {
          label: 'Integridad del acta',
          value: intact ? '✔ Íntegra' : '✘ Alterada',
          tone: intact ? 'ok' : 'bad',
          note: intact ? 'El acta no cambió y los votos guardados coinciden con lo certificado.' : raw.problems[0],
        },
        items: [],
        table: {
          columns: ['Verificación', 'Resultado'],
          rows: [
            ['Contenido del acta contra su hash', check(raw.record.hashOk, 'Coincide', 'No coincide: el acta fue modificada')],
            ['Enlace con el acta anterior', check(raw.record.linkOk, 'Correcto', 'Roto')],
            [
              'Cadena completa de actas',
              check(
                raw.chain.valid,
                `Íntegra (${plural(raw.chain.totalRecords, 'acta', 'actas')})`,
                `Rota en ${raw.chain.brokenElectionIds.map((id) => `#${id}`).join(', ')}`,
              ),
            ],
            [
              'Votos guardados contra certificados',
              check(votes.totalMatches, `${votes.storedTotal} = ${votes.certifiedTotal}`, `${votes.storedTotal} guardados, ${votes.certifiedTotal} certificados`),
            ],
            ...votes.optionDiffs.map((d) => [`Opción "${d.label}"`, `✘ Acta: ${d.certified} · guardados: ${d.stored}`]),
            ...votes.tableDiffs.map((d) => [`Mesa ${d.table}`, `✘ Acta: ${d.certified} · guardados: ${d.stored}`]),
            ['Hash del acta', `${raw.recordHash.slice(0, 16)}…`],
            ['Certificada', new Date(raw.certifiedAt).toLocaleString()],
          ],
        },
      };
    }

    case 'suspiciousAccess': {
      const alerts = raw.alerts || [];
      const totals = raw.totals || { attempts: 0, failures: 0, failureRatePct: 0 };
      const hasHigh = alerts.some((a) => a.severity === 'alta');
      const moment = momentFormatter(alerts.flatMap((a) => [a.from, a.to]));
      return {
        kpi: {
          label: 'Alertas de acceso',
          value: alerts.length ? plural(alerts.length, 'alerta', 'alertas') : 'Sin alertas',
          // Solo alertas medias: sin tono, queda en el dorado de "atención".
          tone: hasHigh ? 'bad' : alerts.length ? undefined : 'ok',
          note: `${totals.failures} de ${totals.attempts} ingresos fallaron (${totals.failureRatePct}%) durante la elección.`,
        },
        items: (raw.failuresByReason || []).map((r) => ({ name: r.reason, value: r.count })),
        table: {
          columns: ['Severidad', 'Qué pasó', 'Origen', 'Intentos', 'Cuándo', 'Qué significa'],
          rows: alerts.map((a) => [
            a.severity === 'alta' ? 'Alta' : 'Media',
            a.title,
            a.subject,
            a.attempts,
            `${moment(a.from)} – ${moment(a.to)}`,
            a.detail,
          ]),
          emptyMessage: 'Sin alertas: ningún patrón de ingresos fallidos superó los umbrales durante la elección.',
        },
      };
    }

    default:
      return emptyShape(dataSource);
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Hora corta para ejes y tablas: solo HH:MM si todo cae el mismo día, con
// la fecha si abarca varios (una elección puede durar más de un día).
function momentFormatter(isoDates) {
  const days = new Set(isoDates.map((d) => new Date(d).toDateString()));
  const options =
    days.size > 1 ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  return (iso) => new Date(iso).toLocaleString([], options);
}

function emptyShape(dataSource) {
  return { kpi: { label: dataSource, value: '—' }, items: [], table: { columns: [], rows: [] } };
}

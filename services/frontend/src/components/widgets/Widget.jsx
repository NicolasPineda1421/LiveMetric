import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { adaptForWidgets } from './dataAdapters.js';
import KpiCard from './KpiCard.jsx';
import BarChartWidget from './BarChartWidget.jsx';
import LineChartWidget from './LineChartWidget.jsx';
import PieChartWidget from './PieChartWidget.jsx';
import TableWidget from './TableWidget.jsx';

function fetchDataSource(token, electionId, dataSource, params = {}) {
  switch (dataSource) {
    case 'results':
      return api.getResults(token, electionId);
    case 'timeseries':
      return api.getTimeseries(token, electionId, params.interval);
    case 'participation':
      return api.getParticipation(token, electionId, params.groupBy);
    case 'operational':
      return api.getOperationalMetrics(token, electionId);
    case 'audit':
      return api.getAuditMetrics(token, electionId);
    default:
      return Promise.resolve(null);
  }
}

function renderByType(type, shaped, printMode) {
  switch (type) {
    case 'kpi':
      return <KpiCard kpi={shaped.kpi} />;
    case 'bar':
      return <BarChartWidget items={shaped.items} printMode={printMode} />;
    case 'line':
      return <LineChartWidget items={shaped.items} printMode={printMode} />;
    case 'pie':
      return <PieChartWidget items={shaped.items} printMode={printMode} />;
    case 'table':
      return <TableWidget table={shaped.table} />;
    default:
      return null;
  }
}

// Un widget resuelve su propia fuente de datos a partir de su `config`
// ({type, dataSource, params}); el builder y la vista de solo lectura del
// auditor comparten este mismo componente, solo cambian los botones que le
// pasan (editar/quitar, o ninguno). `printMode` retematiza los gráficos con
// colores aptos para papel (ver palette.js) mientras se exporta a PDF; el
// resto de la tarjeta (título, KPI, tabla) ya se retematiza solo vía las
// variables CSS que redefine `.pdf-export-mode` en styles.css.
export default function Widget({ session, electionId, config, onRemove, onConfigure, dragHandleClassName, printMode }) {
  const [state, setState] = useState({ loading: true, error: '', shaped: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', shaped: null });
    fetchDataSource(session.token, electionId, config.dataSource, config.params)
      .then((raw) => {
        if (cancelled) return;
        setState({ loading: false, error: '', shaped: adaptForWidgets(config.dataSource, raw) });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, error: err.message, shaped: null });
      });
    return () => {
      cancelled = true;
    };
  }, [session.token, electionId, config.dataSource, JSON.stringify(config.params)]);

  return (
    <div className="widget-card">
      <div className={`widget-header ${dragHandleClassName || ''}`}>
        <span className="widget-title">{config.title}</span>
        {(onConfigure || onRemove) && (
          <div className="widget-actions">
            {onConfigure && (
              <button className="link-button" title="Configurar" onClick={() => onConfigure(config)}>
                ⚙
              </button>
            )}
            {onRemove && (
              <button className="link-button" title="Quitar" onClick={() => onRemove(config.id)}>
                ✕
              </button>
            )}
          </div>
        )}
      </div>
      <div className="widget-body">
        {state.loading && <div className="widget-empty widget-loading">Cargando…</div>}
        {state.error && <div className="widget-empty widget-error">{state.error}</div>}
        {!state.loading && !state.error && state.shaped && renderByType(config.type, state.shaped, printMode)}
      </div>
    </div>
  );
}

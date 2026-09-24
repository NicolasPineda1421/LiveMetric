import React from 'react';

// `kpi.tone` ('ok' | 'bad') colorea el valor cuando es un veredicto (acta
// íntegra/alterada, alertas de acceso); `kpi.note` agrega una línea corta
// de contexto debajo.
export default function KpiCard({ title, kpi }) {
  return (
    <div className="widget-kpi">
      <div className="widget-kpi-label">{title || kpi.label}</div>
      <div className={`widget-kpi-value${kpi.tone ? ` tone-${kpi.tone}` : ''}`}>{kpi.value}</div>
      {kpi.note && <div className="widget-kpi-note">{kpi.note}</div>}
    </div>
  );
}

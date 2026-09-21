import React from 'react';

export default function KpiCard({ title, kpi }) {
  return (
    <div className="widget-kpi">
      <div className="widget-kpi-label">{title || kpi.label}</div>
      <div className="widget-kpi-value">{kpi.value}</div>
    </div>
  );
}

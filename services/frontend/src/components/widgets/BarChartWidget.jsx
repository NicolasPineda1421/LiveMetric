import React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { SEQUENTIAL_ACCENT, MUTED_INK, GRIDLINE, PRINT_INK, PRINT_MUTED_INK, PRINT_GRIDLINE } from './palette.js';

export default function BarChartWidget({ items, printMode }) {
  if (!items || items.length === 0) {
    return <div className="widget-empty">Sin datos para mostrar.</div>;
  }
  const gridline = printMode ? PRINT_GRIDLINE : GRIDLINE;
  const tickStyle = { fill: printMode ? PRINT_MUTED_INK : MUTED_INK, fontSize: 11 };
  const barFill = printMode ? PRINT_INK : SEQUENTIAL_ACCENT;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={items} margin={{ top: 8, right: 12, left: 0, bottom: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridline} vertical={false} />
        <XAxis
          dataKey="name"
          tick={tickStyle}
          interval={0}
          angle={-25}
          textAnchor="end"
          height={50}
          axisLine={{ stroke: gridline }}
          tickLine={false}
        />
        <YAxis allowDecimals={false} tick={tickStyle} axisLine={false} tickLine={false} width={36} />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          contentStyle={{ background: '#222e3b', border: '1px solid #303e4d', borderRadius: 3, fontSize: 12 }}
          labelStyle={{ color: '#eae4d6' }}
        />
        <Bar dataKey="value" fill={barFill} radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

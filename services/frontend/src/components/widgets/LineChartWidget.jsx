import React from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { SEQUENTIAL_ACCENT, MUTED_INK, GRIDLINE, PRINT_INK, PRINT_MUTED_INK, PRINT_GRIDLINE } from './palette.js';

export default function LineChartWidget({ items, printMode }) {
  if (!items || items.length === 0) {
    return <div className="widget-empty">Sin datos para mostrar.</div>;
  }
  const gridline = printMode ? PRINT_GRIDLINE : GRIDLINE;
  const tickStyle = { fill: printMode ? PRINT_MUTED_INK : MUTED_INK, fontSize: 11 };
  const lineColor = printMode ? PRINT_INK : SEQUENTIAL_ACCENT;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={items} margin={{ top: 8, right: 12, left: 0, bottom: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridline} vertical={false} />
        <XAxis
          dataKey="name"
          tick={tickStyle}
          interval="preserveStartEnd"
          angle={-25}
          textAnchor="end"
          height={50}
          axisLine={{ stroke: gridline }}
          tickLine={false}
        />
        <YAxis allowDecimals={false} tick={tickStyle} axisLine={false} tickLine={false} width={36} />
        <Tooltip
          contentStyle={{ background: '#222e3b', border: '1px solid #303e4d', borderRadius: 3, fontSize: 12 }}
          labelStyle={{ color: '#eae4d6' }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={lineColor}
          strokeWidth={2}
          dot={{ r: 4, fill: lineColor, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

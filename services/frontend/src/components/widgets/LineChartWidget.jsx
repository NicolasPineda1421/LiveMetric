import React from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { SEQUENTIAL_ACCENT, MUTED_INK, GRIDLINE, PRINT_INK, PRINT_MUTED_INK, PRINT_GRIDLINE, colorAt } from './palette.js';

// Una serie (la forma de siempre: items [{ name, value }]) o varias, cuando
// el adaptador manda `series` ([{ key, label, dashed, color }]) e items con
// una propiedad por serie. Varias series usan la paleta categórica (una
// identidad por opción), salvo las marcadas color: 'accent', que son la
// misma magnitud (ej. participación real vs. proyectada: mismo color, la
// proyección punteada).
export default function LineChartWidget({ items, series, unit = '', printMode }) {
  if (!items || items.length === 0) {
    return <div className="widget-empty">Sin datos para mostrar.</div>;
  }
  const gridline = printMode ? PRINT_GRIDLINE : GRIDLINE;
  const tickStyle = { fill: printMode ? PRINT_MUTED_INK : MUTED_INK, fontSize: 11 };
  const accent = printMode ? PRINT_INK : SEQUENTIAL_ACCENT;
  const lines = series && series.length ? series : [{ key: 'value', color: 'accent' }];
  const multiple = lines.length > 1;
  const colorOf = (line, i) => (line.color === 'accent' ? accent : colorAt(i, printMode));

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
        <YAxis
          allowDecimals={false}
          tick={tickStyle}
          axisLine={false}
          tickLine={false}
          width={unit ? 42 : 36}
          tickFormatter={(v) => `${v}${unit}`}
        />
        <Tooltip
          contentStyle={{ background: '#222e3b', border: '1px solid #303e4d', borderRadius: 3, fontSize: 12 }}
          labelStyle={{ color: '#eae4d6' }}
          formatter={(v) => (v === null || v === undefined ? '—' : `${v}${unit}`)}
        />
        {multiple && <Legend wrapperStyle={{ fontSize: 11, color: tickStyle.fill }} verticalAlign="top" height={24} />}
        {lines.map((line, i) => (
          <Line
            key={line.key}
            type="monotone"
            dataKey={line.key}
            name={line.label || line.key}
            stroke={colorOf(line, i)}
            strokeWidth={2}
            strokeDasharray={line.dashed ? '6 4' : undefined}
            dot={{ r: multiple ? 2.5 : 4, fill: colorOf(line, i), strokeWidth: 0 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

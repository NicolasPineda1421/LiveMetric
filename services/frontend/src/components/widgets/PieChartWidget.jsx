import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { colorAt, foldToOther, MUTED_INK, PRINT_MUTED_INK } from './palette.js';

export default function PieChartWidget({ items, printMode }) {
  const total = (items || []).reduce((sum, i) => sum + (i.value || 0), 0);
  if (!items || items.length === 0 || total === 0) {
    return <div className="widget-empty">Sin datos para mostrar.</div>;
  }
  // Cada porción es una identidad distinta (candidato, puesto, mesa): aquí sí
  // corresponde la paleta categórica, con leyenda porque el color es la
  // única forma de distinguirlas (a diferencia de una barra con eje rotulado).
  const data = foldToOther(items);
  const ringColor = printMode ? '#f9f9f7' : '#1b2530'; // separador = fondo de la tarjeta (claro u oscuro)

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="75%" paddingAngle={2} isAnimationActive={false}>
          {data.map((_, i) => (
            <Cell key={i} fill={colorAt(i, printMode)} stroke={ringColor} strokeWidth={2} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ background: '#222e3b', border: '1px solid #303e4d', borderRadius: 3, fontSize: 12 }}
          labelStyle={{ color: '#eae4d6' }}
        />
        <Legend
          verticalAlign="bottom"
          height={36}
          wrapperStyle={{ fontSize: 11, color: printMode ? PRINT_MUTED_INK : MUTED_INK }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

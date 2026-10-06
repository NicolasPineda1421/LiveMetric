import React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LabelList } from 'recharts';
import { SEQUENTIAL_ACCENT, MUTED_INK, GRIDLINE, PRINT_INK, PRINT_MUTED_INK, PRINT_GRIDLINE } from './palette.js';
import { disposicionDeBarras, formatearValor, recortar } from './barras.js';

// Al pasar el mouse: el nombre completo, el valor y, si lo hay, el detalle
// ("12 de 40 habilitados").
function DetalleBarra({ active, payload, unit }) {
  if (!active || !payload?.length) return null;
  const item = payload[0].payload;
  return (
    <div className="barras-tooltip">
      <strong>{item.name}</strong>
      <span>{formatearValor(item.value, unit)}</span>
      {item.detail && <span className="barras-tooltip-detalle">{item.detail}</span>}
    </div>
  );
}

// El nombre de cada barra horizontal, en una sola línea (recharts parte en
// dos los largos): recortado si no entra, y completo al pasar el mouse.
function EtiquetaDeBarra({ x, y, payload, letras, estilo }) {
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={estilo.fill} fontSize={estilo.fontSize}>
      <title>{payload.value}</title>
      {recortar(payload.value, letras)}
    </text>
  );
}

// items: [{ name, value, detail? }]; unit: '%' si los valores son porcentajes.
export default function BarChartWidget({ items, unit, printMode, emptyMessage }) {
  if (!items || items.length === 0) {
    return <div className="widget-empty">{emptyMessage || 'Sin datos para mostrar.'}</div>;
  }
  const gridline = printMode ? PRINT_GRIDLINE : GRIDLINE;
  const tickStyle = { fill: printMode ? PRINT_MUTED_INK : MUTED_INK, fontSize: 11 };
  const barFill = printMode ? PRINT_INK : SEQUENTIAL_ACCENT;
  const tooltip = <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DetalleBarra unit={unit} />} />;
  const disposicion = disposicionDeBarras(items, { printMode });

  if (!disposicion.horizontal) {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={disposicion.filas} margin={{ top: 8, right: 12, left: 0, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridline} vertical={false} />
          <XAxis dataKey="name" tick={tickStyle} interval={0} angle={-25} textAnchor="end" height={50} axisLine={{ stroke: gridline }} tickLine={false} />
          <YAxis
            allowDecimals={false}
            domain={unit === '%' ? [0, 100] : [0, 'auto']}
            tickFormatter={(v) => formatearValor(v, unit)}
            tick={tickStyle}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          {tooltip}
          <Bar dataKey="value" fill={barFill} radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  const { filas, ocultas, anchoEtiquetas, letras, alto } = disposicion;
  return (
    <div className="barras-horizontales">
      {/* En pantalla, cada barra tiene su alto y, si no entran, se desplazan;
          en el PDF ocupan el widget. */}
      <div className="barras-lienzo" style={printMode ? { flex: '1 1 0' } : { height: alto }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart layout="vertical" data={filas} margin={{ top: 4, right: 48, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridline} horizontal={false} />
            <XAxis type="number" hide domain={unit === '%' ? [0, 100] : [0, 'auto']} />
            <YAxis
              type="category"
              dataKey="name"
              width={anchoEtiquetas}
              interval={0}
              tick={<EtiquetaDeBarra letras={letras} estilo={tickStyle} />}
              axisLine={{ stroke: gridline }}
              tickLine={false}
            />
            {tooltip}
            <Bar dataKey="value" fill={barFill} radius={[0, 3, 3, 0]} maxBarSize={18} isAnimationActive={false}>
              <LabelList dataKey="value" position="right" formatter={(v) => formatearValor(v, unit)} style={tickStyle} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {ocultas > 0 && <p className="barras-nota">Y {ocultas} más, con menos: la tabla los trae todos.</p>}
    </div>
  );
}

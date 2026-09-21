import React from 'react';
import GridLayout, { WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import Widget from './widgets/Widget.jsx';

const ResponsiveGridLayout = WidthProvider(GridLayout);

// Lienzo compartido entre el editor de admin (editable) y la vista de solo
// lectura del auditor (editable=false): mismo render, solo cambia si se
// puede arrastrar/redimensionar y si los widgets muestran sus controles.
export default function DashboardCanvas({
  session,
  electionId,
  widgets,
  onLayoutChange,
  editable = false,
  onRemoveWidget,
  onConfigureWidget,
  printMode = false,
}) {
  if (widgets.length === 0) {
    return <div className="empty-state">Este tablero todavía no tiene widgets.</div>;
  }

  const layout = widgets.map((w) => ({ i: String(w.id), ...w.grid }));

  return (
    <ResponsiveGridLayout
      className="dashboard-canvas"
      layout={layout}
      cols={12}
      rowHeight={70}
      margin={[12, 12]}
      compactType="vertical"
      isDraggable={editable}
      isResizable={editable}
      draggableHandle=".widget-header"
      onLayoutChange={editable ? onLayoutChange : undefined}
    >
      {widgets.map((w) => (
        <div key={String(w.id)}>
          <Widget
            session={session}
            electionId={electionId}
            config={w}
            onRemove={editable ? onRemoveWidget : undefined}
            onConfigure={editable ? onConfigureWidget : undefined}
            printMode={printMode}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}

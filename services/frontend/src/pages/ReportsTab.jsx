import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import DashboardCanvas from '../components/DashboardCanvas.jsx';
import { exportDashboardToPdf, buildIntro, slugify } from '../utils/exportDashboardPdf.js';
import { WIDGET_TYPE_LABELS, DATA_SOURCE_LABELS } from '../components/widgets/labels.js';

const WIDGET_DATA_SOURCES = {
  kpi: ['results', 'timeseries', 'participation', 'operational', 'audit', 'concentration', 'participationRate', 'anomalies'],
  bar: ['results', 'participation'],
  line: ['timeseries'],
  pie: ['results', 'participation'],
  table: ['results', 'timeseries', 'participation', 'operational', 'audit', 'concentration', 'anomalies'],
};

const DEFAULT_GRID = {
  kpi: { w: 3, h: 2 },
  bar: { w: 5, h: 4 },
  line: { w: 5, h: 4 },
  pie: { w: 5, h: 4 },
  table: { w: 6, h: 4 },
};

function newWidgetId() {
  return crypto.randomUUID();
}

const GRID_COLS = 12;

// Empaquetado simple tipo "estantería": intenta seguir llenando la fila
// donde terminó el último widget agregado; si no cabe, abre una fila nueva
// debajo de todo lo existente. No es un bin-packing general (no rellena
// huecos que deje un widget borrado), pero evita que cada widget nuevo se
// apile en una sola columna, que es el caso que realmente importa aquí.
function nextGridPosition(widgets, size) {
  if (widgets.length === 0) return { x: 0, y: 0, ...size };

  const sorted = [...widgets].sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);
  const last = sorted[sorted.length - 1];
  const rowY = last.grid.y;
  const usedInRow = last.grid.x + last.grid.w;

  if (usedInRow + size.w <= GRID_COLS) {
    return { x: usedInRow, y: rowY, ...size };
  }
  const bottom = Math.max(...widgets.map((w) => w.grid.y + w.grid.h));
  return { x: 0, y: bottom, ...size };
}

export default function ReportsTab({ session }) {
  const [elections, setElections] = useState([]);
  const [electionId, setElectionId] = useState('');
  const [dashboards, setDashboards] = useState([]);
  const [dashboardId, setDashboardId] = useState(''); // '' = tablero nuevo sin guardar
  const [name, setName] = useState('Nuevo tablero');
  const [widgets, setWidgets] = useState([]);
  const [pendingType, setPendingType] = useState(null); // tipo de widget que se está agregando/editando
  const [editingWidgetId, setEditingWidgetId] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    api.listAllElections(session.token).then(setElections).catch(() => {});
  }, [session.token]);

  function loadDashboards(id) {
    if (!id) return;
    api.listDashboards(session.token, id).then((d) => setDashboards(d.dashboards)).catch((e) => setError(e.message));
  }

  useEffect(() => {
    if (electionId) loadDashboards(electionId);
  }, [electionId, session.token]);

  function selectElection(id) {
    setElectionId(id);
    resetDashboard();
    if (id) loadDashboards(id);
  }

  function resetDashboard() {
    setDashboardId('');
    setName('Nuevo tablero');
    setWidgets([]);
    setPendingType(null);
    setEditingWidgetId(null);
    setError('');
    setSuccess('');
  }

  async function openDashboard(id) {
    setError(''); setSuccess('');
    try {
      const d = await api.getDashboard(session.token, id);
      setDashboardId(d.id);
      setName(d.name);
      setWidgets((d.layout && d.layout.widgets) || []);
    } catch (err) {
      setError(err.message);
    }
  }

  function startAddWidget(type) {
    setEditingWidgetId(null);
    setPendingType(type);
  }

  function startEditWidget(config) {
    setEditingWidgetId(config.id);
    setPendingType(config.type);
  }

  function cancelWidgetForm() {
    setPendingType(null);
    setEditingWidgetId(null);
  }

  function commitWidgetForm({ title, dataSource, params }) {
    if (editingWidgetId) {
      setWidgets((ws) => ws.map((w) => (w.id === editingWidgetId ? { ...w, title, dataSource, params } : w)));
    } else {
      setWidgets((ws) => {
        const grid = nextGridPosition(ws, DEFAULT_GRID[pendingType]);
        return [...ws, { id: newWidgetId(), type: pendingType, title, dataSource, params, grid }];
      });
    }
    cancelWidgetForm();
  }

  function removeWidget(id) {
    setWidgets((ws) => ws.filter((w) => w.id !== id));
  }

  function handleLayoutChange(newLayout) {
    setWidgets((ws) =>
      ws.map((w) => {
        const l = newLayout.find((item) => item.i === String(w.id));
        if (!l) return w;
        return { ...w, grid: { x: l.x, y: l.y, w: l.w, h: l.h } };
      })
    );
  }

  async function save() {
    setSaving(true); setError(''); setSuccess('');
    const layout = { widgets };
    try {
      if (dashboardId) {
        await api.updateDashboard(session.token, dashboardId, name, layout);
      } else {
        const created = await api.createDashboard(session.token, electionId, name, layout);
        setDashboardId(created.id);
      }
      setSuccess('Tablero guardado correctamente.');
      loadDashboards(electionId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!dashboardId) return;
    if (!window.confirm(`¿Borrar el tablero "${name}"? No se puede deshacer.`)) return;
    setError(''); setSuccess('');
    try {
      await api.deleteDashboard(session.token, dashboardId);
      resetDashboard();
      loadDashboards(electionId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function exportPdf() {
    setExporting(true); setError('');
    try {
      // Dos frames para que React quite las asas de arrastre/redimensionar y
      // los botones de widget (editable=false mientras exporting=true) antes
      // de tomar la captura; si no, saldrían en la foto del PDF.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const election = elections.find((e) => String(e.id) === String(electionId));
      await exportDashboardToPdf(canvasRef.current, {
        title: name,
        subtitle: `Elección: ${election ? election.title : electionId}${election ? ` · Estado: ${election.status}` : ''} · Generado el ${new Date().toLocaleString()}`,
        intro: buildIntro(name, election, widgets),
        filename: `reporte-${slugify(name)}.pdf`,
      });
    } catch (err) {
      setError('No se pudo generar el PDF: ' + err.message);
    } finally {
      setExporting(false);
    }
  }

  const editingWidget = editingWidgetId ? widgets.find((w) => w.id === editingWidgetId) : null;

  return (
    <div>
      <h2 className="section-title">Reportes</h2>
      <p className="section-desc">
        Arma tableros propios por elección: combina tarjetas KPI, gráficos y tablas
        conectados a resultados, participación, operación y auditoría.
      </p>

      <div className="panel">
        <div className="grid-2">
          <div className="field-dark">
            <label>Elección</label>
            <select value={electionId} onChange={(e) => selectElection(e.target.value)}>
              <option value="">Selecciona una elección…</option>
              {elections.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}
            </select>
          </div>
          {electionId && (
            <div className="field-dark">
              <label>Tablero</label>
              <select value={dashboardId} onChange={(e) => (e.target.value ? openDashboard(Number(e.target.value)) : resetDashboard())}>
                <option value="">+ Nuevo tablero</option>
                {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      {electionId && (
        <>
          {error && <div className="error-banner">{error}</div>}
          {success && <div className="success-banner">{success}</div>}

          <div className="panel">
            <div className="reports-toolbar">
              <input
                className="dashboard-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre del tablero"
              />
              <div className="reports-toolbar-actions">
                <button className="btn btn-gold" onClick={save} disabled={saving}>
                  {saving ? 'Guardando…' : 'Guardar tablero'}
                </button>
                {dashboardId && (
                  <>
                    <button className="btn btn-outline" onClick={exportPdf} disabled={exporting}>
                      {exporting ? 'Generando PDF…' : '📄 Exportar PDF'}
                    </button>
                    <button className="btn btn-danger-outline" onClick={remove}>Borrar tablero</button>
                  </>
                )}
              </div>
            </div>

            <div className="widget-palette">
              <span className="widget-palette-label">Agregar widget:</span>
              {Object.keys(WIDGET_TYPE_LABELS).map((type) => (
                <button key={type} className="btn btn-outline" onClick={() => startAddWidget(type)}>
                  + {WIDGET_TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            {pendingType && (
              <WidgetForm
                type={pendingType}
                initial={editingWidget}
                onCancel={cancelWidgetForm}
                onSubmit={commitWidgetForm}
              />
            )}
          </div>

          <div className={`panel dashboard-canvas-panel ${exporting ? 'pdf-export-mode' : ''}`} ref={canvasRef}>
            <DashboardCanvas
              session={session}
              electionId={electionId}
              widgets={widgets}
              editable={!exporting}
              onLayoutChange={handleLayoutChange}
              onRemoveWidget={removeWidget}
              onConfigureWidget={startEditWidget}
              printMode={exporting}
            />
          </div>
        </>
      )}
    </div>
  );
}

function WidgetForm({ type, initial, onCancel, onSubmit }) {
  const sources = WIDGET_DATA_SOURCES[type];
  const [dataSource, setDataSource] = useState(initial?.dataSource || sources[0]);
  const [title, setTitle] = useState(initial?.title || DATA_SOURCE_LABELS[dataSource]);
  // Al crear un widget nuevo, el título sigue a la fuente de datos elegida
  // (así dice "Participación por puesto/mesa" y no el genérico "Gráfico de
  // torta"). Al editar uno existente, o en cuanto la persona toque el campo
  // de título a mano, se deja de autocompletar para no pisar su elección.
  const [titleTouched, setTitleTouched] = useState(Boolean(initial));
  const [interval, setInterval_] = useState(initial?.params?.interval || 'hour');
  const [groupBy, setGroupBy] = useState(initial?.params?.groupBy || 'polling_place');

  function handleDataSourceChange(newSource) {
    setDataSource(newSource);
    if (!titleTouched) setTitle(DATA_SOURCE_LABELS[newSource]);
  }

  function submit(e) {
    e.preventDefault();
    const params = {};
    if (dataSource === 'timeseries' || dataSource === 'anomalies') params.interval = interval;
    if (dataSource === 'participation') params.groupBy = groupBy;
    onSubmit({ title: title.trim() || DATA_SOURCE_LABELS[dataSource], dataSource, params });
  }

  return (
    <form className="widget-form" onSubmit={submit}>
      <div className="field-dark">
        <label>Título del widget</label>
        <input value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} required />
      </div>
      <div className="field-dark">
        <label>Fuente de datos</label>
        <select value={dataSource} onChange={(e) => handleDataSourceChange(e.target.value)}>
          {sources.map((s) => <option key={s} value={s}>{DATA_SOURCE_LABELS[s]}</option>)}
        </select>
      </div>
      {(dataSource === 'timeseries' || dataSource === 'anomalies') && (
        <div className="field-dark">
          <label>Agrupar por</label>
          <select value={interval} onChange={(e) => setInterval_(e.target.value)}>
            <option value="hour">Hora</option>
            <option value="day">Día</option>
          </select>
        </div>
      )}
      {dataSource === 'participation' && (
        <div className="field-dark">
          <label>Agrupar por</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="polling_place">Puesto de votación</option>
            <option value="voting_table">Mesa</option>
          </select>
        </div>
      )}
      <div className="reports-toolbar-actions">
        <button className="btn btn-gold">{initial ? 'Guardar cambios' : 'Agregar al tablero'}</button>
        <button type="button" className="btn btn-outline" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}

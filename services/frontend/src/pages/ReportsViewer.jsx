import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import DashboardCanvas from '../components/DashboardCanvas.jsx';
import { exportDashboardToPdf, buildIntro, slugify } from '../utils/exportDashboardPdf.js';

// Misma idea que ReportsTab pero de solo lectura: sin paleta de widgets, sin
// guardar/borrar, y el lienzo con isDraggable/isResizable en false. La usan
// los auditores (y sirve para "ver" un tablero sin riesgo de moverlo sin querer).
export default function ReportsViewer({ session }) {
  const [elections, setElections] = useState([]);
  const [electionId, setElectionId] = useState('');
  const [dashboards, setDashboards] = useState([]);
  const [dashboardId, setDashboardId] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    api.listAllElections(session.token).then(setElections).catch(() => {});
  }, [session.token]);

  useEffect(() => {
    setDashboardId(''); setDashboard(null);
    if (!electionId) return;
    api.listDashboards(session.token, electionId).then((d) => setDashboards(d.dashboards)).catch((e) => setError(e.message));
  }, [electionId, session.token]);

  async function openDashboard(id) {
    setError('');
    if (!id) { setDashboardId(''); setDashboard(null); return; }
    try {
      const d = await api.getDashboard(session.token, id);
      setDashboardId(id);
      setDashboard(d);
    } catch (err) {
      setError(err.message);
    }
  }

  async function exportPdf() {
    if (!dashboard) return;
    setExporting(true); setError('');
    try {
      // Un frame para que el lienzo tome la clase "pdf-export-mode" (fondo
      // blanco) antes de capturar.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const election = elections.find((e) => String(e.id) === String(electionId));
      const widgets = (dashboard.layout && dashboard.layout.widgets) || [];
      await exportDashboardToPdf(canvasRef.current, {
        title: dashboard.name,
        subtitle: `Elección: ${election ? election.title : electionId}${election ? ` · Estado: ${election.status}` : ''} · Generado el ${new Date().toLocaleString()}`,
        intro: buildIntro(dashboard.name, election, widgets),
        filename: `reporte-${slugify(dashboard.name)}.pdf`,
      });
    } catch (err) {
      setError('No se pudo generar el PDF: ' + err.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <h2 className="section-title">Reportes</h2>
      <p className="section-desc">Tableros de indicadores armados por los administradores, por elección.</p>

      <div className="panel">
        <div className="grid-2">
          <div className="field-dark">
            <label>Elección</label>
            <select value={electionId} onChange={(e) => setElectionId(e.target.value)}>
              <option value="">Selecciona una elección…</option>
              {elections.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}
            </select>
          </div>
          {electionId && (
            <div className="field-dark">
              <label>Tablero</label>
              <select value={dashboardId} onChange={(e) => openDashboard(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Selecciona un tablero…</option>
                {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
        </div>
        {electionId && dashboards.length === 0 && (
          <div className="empty-state">Aún no hay tableros para esta elección.</div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {dashboard && (
        <>
          <div className="reports-toolbar">
            <button className="btn btn-outline" onClick={exportPdf} disabled={exporting}>
              {exporting ? 'Generando PDF…' : '📄 Exportar PDF'}
            </button>
          </div>
          <div className={`panel dashboard-canvas-panel ${exporting ? 'pdf-export-mode' : ''}`} ref={canvasRef}>
            <DashboardCanvas
              session={session}
              electionId={electionId}
              widgets={(dashboard.layout && dashboard.layout.widgets) || []}
              editable={false}
              printMode={exporting}
            />
          </div>
        </>
      )}
    </div>
  );
}

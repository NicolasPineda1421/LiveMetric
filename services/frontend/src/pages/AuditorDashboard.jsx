import React, { useState } from 'react';
import { ResultsTab } from './AdminDashboard.jsx';
import ReportsViewer from './ReportsViewer.jsx';

const TABS = [
  { id: 'results', label: 'Resultados' },
  { id: 'reports', label: 'Reportes' },
];

// Rol de solo lectura: ve resultados y los tableros de reportes que un
// administrador armó, pero no tiene acceso a ninguna pestaña de gestión
// (plantillas, elecciones, usuarios, padrón) ni puede crear/editar/borrar
// nada — ningún endpoint de escritura acepta su rol en ningún servicio.
export default function AuditorDashboard({ session, onLogout }) {
  const [tab, setTab] = useState('results');

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="wordmark"><span className="seal">LM</span> LiveMetric</div>
        <div className="session-info">
          <span>Auditor: {session.username}</span>
          <button className="link-button" onClick={onLogout}>Salir</button>
        </div>
      </div>

      <div className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="content">
        {tab === 'results' && <ResultsTab session={session} />}
        {tab === 'reports' && <ReportsViewer session={session} />}
      </div>
    </div>
  );
}

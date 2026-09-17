import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function VoterDashboard({ session, onLogout }) {
  const [elections, setElections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState({}); // { [electionId]: optionId }
  const [votedElectionId, setVotedElectionId] = useState(null);

  async function loadElections() {
    setLoading(true);
    setError('');
    try {
      const data = await api.listActiveElections();
      setElections(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadElections();
    const interval = setInterval(loadElections, 15000); // refresco periódico: elecciones pueden cerrar en cualquier momento
    return () => clearInterval(interval);
  }, []);

  async function submitVote(electionId) {
    const optionId = selection[electionId];
    if (!optionId) return;
    setError('');
    try {
      await api.castVote(session.token, electionId, optionId);
      setVotedElectionId(electionId);
    } catch (err) {
      setError(err.message);
    }
  }

  if (votedElectionId) {
    return (
      <div className="app-shell">
        <Topbar session={session} onLogout={onLogout} />
        <div className="confirmation-screen">
          <div>
            <div className="seal">✓</div>
            <h1>Voto registrado</h1>
            <p>
              Tu voto quedó guardado de forma anónima e inmodificable. Cuando la
              elección cierre, el resultado se certificará automáticamente en el
              módulo de escrutinio.
            </p>
            <button className="btn btn-outline" style={{ marginTop: '1.5rem' }} onClick={() => setVotedElectionId(null)}>
              Ver otras elecciones activas
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Topbar session={session} onLogout={onLogout} />
      <div className="content">
        <h2 className="section-title">Elecciones abiertas ahora</h2>
        <p className="section-desc">
          Solo se muestran elecciones dentro de su ventana de votación. La lista se
          actualiza automáticamente.
        </p>

        {(session.pollingPlace || session.votingTable) && (
          <div className="voter-meta-banner">
            <span>Puesto: <strong>{session.pollingPlace}</strong></span>
            <span>Mesa: <strong>{session.votingTable}</strong></span>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        {loading ? (
          <div className="empty-state">Cargando…</div>
        ) : elections.length === 0 ? (
          <div className="empty-state">No hay elecciones activas en este momento. Vuelve más tarde.</div>
        ) : (
          <div className="ballot-list">
            {elections.map((election) => (
              <div key={election.id} className="ballot-card">
                <div className="ballot-title">{election.title}</div>
                <div className="ballot-meta">
                  <span className="live-dot" />
                  Cierra: {new Date(election.scheduled_end).toLocaleString()}
                </div>

                {election.options.map((opt, idx) => (
                  <div
                    key={opt.id}
                    className={`ballot-option ${selection[election.id] === opt.id ? 'selected' : ''}`}
                    onClick={() => setSelection((s) => ({ ...s, [election.id]: opt.id }))}
                  >
                    {opt.candidate_number ? (
                      <div className="ballot-option-candidate">
                        <span className="candidate-number-chip">{opt.candidate_number}</span>
                        {opt.logo ? (
                          <img className="candidate-photo" src={opt.logo} alt={opt.label} />
                        ) : (
                          <span className="candidate-photo-placeholder">S/F</span>
                        )}
                        <span>{opt.label}</span>
                      </div>
                    ) : (
                      <>
                        <span className="ballot-option-number">{idx + 1}</span>
                        <span>{opt.label}</span>
                      </>
                    )}
                  </div>
                ))}

                <button
                  className="btn btn-gold"
                  style={{ marginTop: '0.75rem' }}
                  disabled={!selection[election.id]}
                  onClick={() => submitVote(election.id)}
                >
                  Emitir voto
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Topbar({ session, onLogout }) {
  return (
    <div className="topbar">
      <div className="wordmark"><span className="seal">LM</span> LiveMetric</div>
      <div className="session-info">
        <span>Votante</span>
        <button className="link-button" onClick={onLogout}>Salir</button>
      </div>
    </div>
  );
}

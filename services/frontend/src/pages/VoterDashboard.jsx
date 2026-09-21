import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function VoterDashboard({ session, onLogout }) {
  const [elections, setElections] = useState([]);
  const [myVotes, setMyVotes] = useState([]); // [{ electionId, createdAt }] — nunca la opción elegida
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState({}); // { [electionId]: optionId }
  const [votedElectionId, setVotedElectionId] = useState(null); // solo para la pantalla de confirmación inmediata

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const [activeElections, votes] = await Promise.all([
        api.listActiveElections(),
        api.listMyVotes(session.token).catch(() => ({ votes: [] })), // no bloquea la lista si falla
      ]);
      setElections(activeElections);
      setMyVotes(votes.votes);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000); // refresco periódico: elecciones pueden cerrar en cualquier momento
    return () => clearInterval(interval);
  }, []);

  // De dónde sale "ya votaste en esta elección": del historial del servidor
  // (persiste entre sesiones) más la que se acaba de emitir en esta misma
  // pantalla (por si el refresco periódico todavía no llegó). Antes esto no
  // se consultaba y la papeleta de una elección ya votada volvía a
  // aparecer; el backend rechazaba el segundo voto, pero la interfaz no lo
  // anticipaba.
  const votedElectionIds = new Set(myVotes.map((v) => v.electionId));
  if (votedElectionId) votedElectionIds.add(votedElectionId);

  async function submitVote(electionId) {
    const optionId = selection[electionId];
    if (!optionId) return;
    setError('');
    try {
      await api.castVote(session.token, electionId, optionId);
      setVotedElectionId(electionId);
      setMyVotes((v) => [{ electionId, createdAt: new Date().toISOString() }, ...v]);
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

                {votedElectionIds.has(election.id) ? (
                  <div className="already-voted-note">Ya emitiste tu voto en esta elección.</div>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <VoteHistory votes={myVotes} />
      </div>
    </div>
  );
}

// Historial de la propia persona votante: demuestra que votó y cuándo, pero
// nunca en qué elección ni por qué opción — ni siquiera el backend conserva
// esa asociación en la respuesta (ver GET /my-votes en voting-service).
function VoteHistory({ votes }) {
  if (votes.length === 0) return null;
  return (
    <div className="panel" style={{ marginTop: '1.5rem' }}>
      <h3 style={{ marginTop: 0, fontSize: '0.95rem' }}>Historial de tus votos</h3>
      <p className="section-desc" style={{ marginBottom: '0.9rem' }}>
        Solo confirma que votaste y cuándo; nunca muestra en qué elección ni qué opción elegiste.
      </p>
      <div className="tally">
        {votes.map((v, i) => (
          <div className="tally-row" key={i}>
            <span className="tally-label">Voto emitido</span>
            <span className="tally-votes mono">{new Date(v.createdAt).toLocaleString()}</span>
          </div>
        ))}
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

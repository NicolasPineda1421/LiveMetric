import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Jurado de mesa: autoriza el ingreso de los votantes asistidos de SU mesa
// (quienes no pueden usar una app autenticadora). Ve su mesa, a quiénes
// puede autorizar y cómo hacerlo; nada más del sistema.
export default function JuradoDashboard({ session, onLogout }) {
  const [mesa, setMesa] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getJuradoMesa(session.token).then(setMesa).catch((e) => setError(e.message));
  }, [session.token]);

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="wordmark"><span className="seal">LM</span> LiveMetric</div>
        <div className="session-info">
          <span>Jurado: {session.username}</span>
          <button className="link-button" onClick={onLogout}>Salir</button>
        </div>
      </div>

      <div className="content">
        <h2 className="section-title">Jurado de mesa</h2>
        {error && <div className="error-banner">{error}</div>}
        {mesa && (mesa.votingTable ? (
          <p className="section-desc">
            Tu mesa: <strong>{mesa.pollingPlace} — {mesa.votingTable}</strong>. Solo puedes autorizar a los votantes
            asistidos de esta mesa.
          </p>
        ) : (
          <p className="section-desc">
            Tu puesto: <strong>{mesa.pollingPlace}</strong>, todas las mesas. Puedes autorizar a los votantes asistidos
            de cualquier mesa de este puesto.
          </p>
        ))}

        <div className="panel">
          <h3>Cómo autorizar un voto asistido</h3>
          <ol className="jurado-pasos">
            <li>Pide la <strong>cédula física</strong>: comprueba que la foto y el nombre sean de la persona, y que esté en la lista de abajo.</li>
            <li>La persona escribe su <strong>cédula y su PIN</strong> en el equipo de votación. No mires el PIN.</li>
            <li>Cuando la pantalla diga <strong>«Voto asistido»</strong>, escribe tu usuario y el código de 6 dígitos de tu autenticador.</li>
            <li><strong>Apártate</strong>: el voto es secreto, tú no lo ves. Tu autorización queda registrada en la auditoría.</li>
          </ol>
        </div>

        <div className="panel">
          <h3>Votantes asistidos de tu {mesa && !mesa.votingTable ? 'puesto' : 'mesa'}{mesa ? ` (${mesa.assistedVoters.length})` : ''}</h3>
          {!mesa ? (
            <div className="empty-state">{error ? 'No se pudo cargar tu mesa.' : 'Cargando…'}</div>
          ) : mesa.assistedVoters.length === 0 ? (
            <div className="empty-state">Ningún votante de tu {mesa.votingTable ? 'mesa' : 'puesto'} está marcado para el voto asistido.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Nombre</th><th>Cédula termina en</th><th>Mesa</th></tr></thead>
              <tbody>
                {mesa.assistedVoters.map((v) => (
                  <tr key={`${v.fullName}-${v.cedulaEnd}`}>
                    <td>{v.fullName}</td>
                    <td className="mono">···{v.cedulaEnd}</td>
                    <td>{v.votingTable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

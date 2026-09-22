import React, { useState } from 'react';
import { api } from '../api.js';

export default function LoginScreen({ onLogin }) {
  const [tab, setTab] = useState('admin'); // 'admin' | 'voter'
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [adminUser, setAdminUser] = useState('');
  const [adminPass, setAdminPass] = useState('');

  const [cedulaUser, setCedulaUser] = useState('');
  const [pin, setPin] = useState('');

  async function submitAdmin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.loginAdmin(adminUser, adminPass);
      onLogin({ role: data.role, token: data.token, username: adminUser });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitVoter(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.loginVoter(cedulaUser, pin);
      onLogin({
        role: 'voter',
        token: data.token,
        cedula: cedulaUser,
        pollingPlace: data.pollingPlace,
        votingTable: data.votingTable,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-hero">
        <div className="wordmark"><span className="seal">LM</span> LiveMetric</div>
        <h1 style={{ marginTop: '2rem' }}>Un acta certificada por cada elección.</h1>
        <p>
          Votación en tiempo real con ventana horaria, doble verificación de
          identidad y un libro de escrutinio con hash encadenado que
          cualquiera puede auditar después del cierre.
        </p>
        <div className="hero-ledger">
          <div className="hero-ledger-item"><span className="tick">01</span><span><strong>Programe</strong> una elección con hora de inicio y cierre.</span></div>
          <div className="hero-ledger-item"><span className="tick">02</span><span><strong>El sistema</strong> abre y cierra la votación sin intervención manual.</span></div>
          <div className="hero-ledger-item"><span className="tick">03</span><span><strong>El escrutinio</strong> certifica el resultado con un hash verificable.</span></div>
        </div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <div className="login-tabs">
            <button className={`login-tab ${tab === 'admin' ? 'active' : ''}`} onClick={() => { setTab('admin'); setError(''); }}>
              Administrador / Auditor
            </button>
            <button className={`login-tab ${tab === 'voter' ? 'active' : ''}`} onClick={() => { setTab('voter'); setError(''); }}>
              Votante
            </button>
          </div>

          {error && <div className="error-banner on-paper">{error}</div>}

          {tab === 'admin' ? (
            <form onSubmit={submitAdmin}>
              <div className="field">
                <label htmlFor="admin-user">Usuario</label>
                <input id="admin-user" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} required autoFocus />
              </div>
              <div className="field">
                <label htmlFor="admin-pass">Contraseña</label>
                <input id="admin-pass" type="password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} required />
              </div>
              <button className="btn btn-primary" disabled={loading}>{loading ? 'Ingresando…' : 'Ingresar como administrador'}</button>
            </form>
          ) : (
            <form onSubmit={submitVoter}>
              <div className="field">
                <label htmlFor="cedula-user">Cédula</label>
                <input id="cedula-user" value={cedulaUser} onChange={(e) => setCedulaUser(e.target.value)} required autoFocus inputMode="numeric" />
              </div>
              <div className="field">
                <label htmlFor="voter-pin">PIN de acceso</label>
                <input id="voter-pin" value={pin} onChange={(e) => setPin(e.target.value)} required inputMode="numeric" maxLength={10} />
                <div className="field-hint">El PIN te lo entrega el encargado de tu puesto de votación.</div>
              </div>
              <button className="btn btn-primary" disabled={loading}>{loading ? 'Verificando…' : 'Ingresar a votar'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

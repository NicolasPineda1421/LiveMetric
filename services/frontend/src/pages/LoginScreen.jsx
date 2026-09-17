import React, { useState } from 'react';
import { api } from '../api.js';

export default function LoginScreen({ onLogin }) {
  const [tab, setTab] = useState('admin'); // 'admin' | 'voter'
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [adminUser, setAdminUser] = useState('');
  const [adminPass, setAdminPass] = useState('');

  const [cedulaUser, setCedulaUser] = useState('');
  const [cedulaPass, setCedulaPass] = useState('');

  async function submitAdmin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.loginAdmin(adminUser, adminPass);
      onLogin({ role: 'admin', token: data.token, username: adminUser });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitVoter(e) {
    e.preventDefault();
    setError('');
    if (cedulaUser !== cedulaPass) {
      setError('La cédula debe ingresarse igual en ambos campos.');
      return;
    }
    setLoading(true);
    try {
      const data = await api.loginVoter(cedulaUser, cedulaPass);
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
              Administrador
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

              <div className="default-creds">
                Credencial de arranque para la primera vez: usuario <code>admin</code>, contraseña <code>Admin123!</code>.
                Cámbiala apenas entres (pestaña "Usuarios" en el panel).
              </div>
            </form>
          ) : (
            <form onSubmit={submitVoter}>
              <div className="field">
                <label htmlFor="cedula-user">Cédula (usuario)</label>
                <input id="cedula-user" value={cedulaUser} onChange={(e) => setCedulaUser(e.target.value)} required autoFocus inputMode="numeric" />
              </div>
              <div className="field">
                <label htmlFor="cedula-pass">Cédula (contraseña)</label>
                <input id="cedula-pass" value={cedulaPass} onChange={(e) => setCedulaPass(e.target.value)} required inputMode="numeric" />
                <div className="field-hint">Repite el mismo número de cédula en ambos campos.</div>
              </div>
              <button className="btn btn-primary" disabled={loading}>{loading ? 'Verificando…' : 'Ingresar a votar'}</button>

              <div className="default-creds">
                Cédulas de demostración precargadas: <code>1000000001</code> a <code>1000000005</code>.
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

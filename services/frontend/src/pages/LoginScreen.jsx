import React, { useState } from 'react';
import { api } from '../api.js';
import SegundoFactor from '../components/SegundoFactor.jsx';

export default function LoginScreen({ onLogin }) {
  const [tab, setTab] = useState('admin'); // 'admin' | 'voter'
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [adminUser, setAdminUser] = useState('');
  const [adminPass, setAdminPass] = useState('');

  const [cedulaUser, setCedulaUser] = useState('');
  const [pin, setPin] = useState('');

  // Respuesta del primer paso cuando falta el segundo factor (votante, o
  // jurado): { next, challenge, secret?, otpauthUri?, quien }.
  const [paso, setPaso] = useState(null);

  async function submitAdmin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.loginAdmin(adminUser, adminPass);
      if (data.next) {
        setAdminPass('');
        setPaso({ ...data, quien: 'jurado' });
        return;
      }
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
      setPin('');
      setPaso({ ...data, quien: 'votante' });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Segundo paso: "enviar" hace el pedido que corresponde y devuelve la sesión.
  async function completar(enviar) {
    setError('');
    setLoading(true);
    try {
      const data = await enviar();
      if (paso.quien === 'jurado') {
        onLogin({ role: 'jurado', token: data.token, username: adminUser });
      } else {
        onLogin({
          role: 'voter',
          token: data.token,
          cedula: cedulaUser,
          pollingPlace: data.pollingPlace,
          votingTable: data.votingTable,
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function enviarCodigo(codigo) {
    const registro = paso.next === 'registro';
    if (paso.quien === 'jurado') {
      return completar(() => (registro ? api.enrollAdmin : api.verifyAdminCode)(paso.challenge, codigo));
    }
    return completar(() => (registro ? api.enrollVoter : api.verifyVoterCode)(paso.challenge, codigo));
  }

  function volver() {
    setPaso(null);
    setError('');
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
          {!paso && (
            <div className="login-tabs">
              <button className={`login-tab ${tab === 'admin' ? 'active' : ''}`} onClick={() => { setTab('admin'); setError(''); }}>
                Administrador / Auditor / Jurado
              </button>
              <button className={`login-tab ${tab === 'voter' ? 'active' : ''}`} onClick={() => { setTab('voter'); setError(''); }}>
                Votante
              </button>
            </div>
          )}

          {error && <div className="error-banner on-paper">{error}</div>}

          {paso ? (
            <SegundoFactor
              paso={paso}
              loading={loading}
              onCodigo={enviarCodigo}
              onJurado={(usuario, codigo) => completar(() => api.authorizeAssistedVoter(paso.challenge, usuario, codigo))}
              onVolver={volver}
            />
          ) : tab === 'admin' ? (
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
                <input id="voter-pin" type="password" value={pin} onChange={(e) => setPin(e.target.value)} required inputMode="numeric" autoComplete="off" maxLength={10} />
                <div className="field-hint">
                  El PIN te lo entrega el encargado de tu puesto de votación y solo sirve durante la votación (desde
                  una hora antes de que abra). Después te pediremos el código de tu autenticador o, si votas
                  asistido, la autorización del jurado de tu mesa.
                </div>
              </div>
              <button className="btn btn-primary" disabled={loading}>{loading ? 'Verificando…' : 'Ingresar a votar'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

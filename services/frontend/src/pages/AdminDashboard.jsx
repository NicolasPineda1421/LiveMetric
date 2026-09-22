import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import ReportsTab from './ReportsTab.jsx';

const TABS = [
  { id: 'overview', label: 'Resumen' },
  { id: 'templates', label: 'Plantillas' },
  { id: 'elections', label: 'Elecciones' },
  { id: 'results', label: 'Resultados' },
  { id: 'reports', label: 'Reportes' },
  { id: 'scrutiny', label: 'Escrutinio' },
  { id: 'users', label: 'Usuarios' },
  { id: 'voters', label: 'Padrón' },
  { id: 'audit', label: 'Auditoría' },
];

export default function AdminDashboard({ session, onLogout }) {
  const [tab, setTab] = useState('overview');

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="wordmark"><span className="seal">LM</span> LiveMetric</div>
        <div className="session-info">
          <span>Admin: {session.username}</span>
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
        {tab === 'overview' && <OverviewTab session={session} />}
        {tab === 'templates' && <TemplatesTab session={session} />}
        {tab === 'elections' && <ElectionsTab session={session} />}
        {tab === 'results' && <ResultsTab session={session} />}
        {tab === 'reports' && <ReportsTab session={session} />}
        {tab === 'scrutiny' && <ScrutinyTab session={session} />}
        {tab === 'users' && <UsersTab session={session} />}
        {tab === 'voters' && <VotersTab session={session} />}
        {tab === 'audit' && <AuditTab session={session} />}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

/* ============================================================ Resumen */

function OverviewTab({ session }) {
  const [elections, setElections] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listAllElections(session.token)
      .then(setElections)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [session.token]);

  const counts = elections.reduce(
    (acc, p) => ({ ...acc, [p.status]: (acc[p.status] || 0) + 1 }),
    {}
  );

  return (
    <div>
      <h2 className="section-title">Resumen</h2>
      <p className="section-desc">Estado general del sistema electoral.</p>
      {error && <div className="error-banner">{error}</div>}
      <div className="grid-2" style={{ marginBottom: '1.25rem' }}>
        <div className="panel">
          <h3>Elecciones por estado</h3>
          {loading ? (
            <div className="empty-state">Cargando…</div>
          ) : (
            <div className="tally">
              <div className="tally-row"><span className="tally-label">Programadas</span><span className="tally-votes">{counts.scheduled || 0}</span></div>
              <div className="tally-row"><span className="tally-label">Activas</span><span className="tally-votes">{counts.active || 0}</span></div>
              <div className="tally-row"><span className="tally-label">Cerradas</span><span className="tally-votes">{counts.closed || 0}</span></div>
            </div>
          )}
        </div>
        <div className="panel">
          <h3>Primeros pasos</h3>
          <ol style={{ paddingLeft: '1.1rem', color: 'var(--color-text-muted)', fontSize: '0.88rem' }}>
            <li>Crea una plantilla en la pestaña "Plantillas".</li>
            <li>Instancia una elección con su ventana de tiempo en "Elecciones".</li>
            <li>El sistema abre y cierra automáticamente; revisa "Resultados".</li>
            <li>Verifica la integridad del escrutinio en "Escrutinio".</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ Plantillas */

function TemplatesTab({ session }) {
  const [templates, setTemplates] = useState([]);
  const [templateType, setTemplateType] = useState('generic'); // 'generic' | 'presidential'
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState(['', '']); // genérica: strings
  const [candidates, setCandidates] = useState([
    { number: '1', name: '', logo: '' },
    { number: '2', name: '', logo: '' },
  ]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function load() {
    api.listTemplates(session.token).then(setTemplates).catch((e) => setError(e.message));
  }
  useEffect(load, [session.token]);

  // --- genérica ---
  function updateOption(i, value) {
    setOptions((opts) => opts.map((o, idx) => (idx === i ? value : o)));
  }
  function addOption() { setOptions((opts) => [...opts, '']); }
  function removeOption(i) { setOptions((opts) => opts.filter((_, idx) => idx !== i)); }

  // --- presidencial ---
  function updateCandidate(i, field, value) {
    setCandidates((cs) => cs.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }
  function addCandidate() {
    setCandidates((cs) => [...cs, { number: String(cs.length + 1), name: '', logo: '' }]);
  }
  function removeCandidate(i) { setCandidates((cs) => cs.filter((_, idx) => idx !== i)); }

  function handleLogoFile(i, file) {
    if (!file) return;
    // Se convierte a data URI base64 en el navegador y se envía como texto
    // dentro del JSON: no hace falta un servicio de almacenamiento de
    // archivos aparte (coherente con Local-First). El backend valida un
    // tamaño máximo razonable para el logo.
    const reader = new FileReader();
    reader.onload = () => updateCandidate(i, 'logo', reader.result);
    reader.readAsDataURL(file);
  }

  async function submit(e) {
    e.preventDefault();
    setError(''); setSuccess('');

    let payloadOptions;
    if (templateType === 'presidential') {
      const cleaned = candidates
        .map((c) => ({ candidateNumber: c.number.trim(), name: c.name.trim(), logo: c.logo || null }))
        .filter((c) => c.candidateNumber && c.name);
      if (cleaned.length < 2) {
        setError('Se necesitan al menos 2 candidatos con número y nombre.');
        return;
      }
      payloadOptions = cleaned;
    } else {
      const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
      if (cleanOptions.length < 2) {
        setError('Se necesitan al menos 2 opciones.');
        return;
      }
      payloadOptions = cleanOptions;
    }

    try {
      await api.createTemplate(session.token, name, description, templateType, payloadOptions);
      setSuccess('Plantilla creada correctamente.');
      setName(''); setDescription('');
      setOptions(['', '']);
      setCandidates([{ number: '1', name: '', logo: '' }, { number: '2', name: '', logo: '' }]);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h2 className="section-title">Plantillas</h2>
      <p className="section-desc">
        Define una pregunta o una elección presidencial una sola vez y reutilízala en varias elecciones.
      </p>

      <div className="panel">
        <h3>Nueva plantilla</h3>
        {error && <div className="error-banner">{error}</div>}
        {success && <div className="success-banner">{success}</div>}

        <div className="template-type-toggle">
          <button type="button" className={templateType === 'generic' ? 'active' : ''} onClick={() => setTemplateType('generic')}>
            Genérica
          </button>
          <button type="button" className={templateType === 'presidential' ? 'active' : ''} onClick={() => setTemplateType('presidential')}>
            Elección presidencial
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field-dark">
            <label>Nombre</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field-dark">
            <label>Descripción (opcional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {templateType === 'presidential' ? (
            <div className="field-dark">
              <label>Candidatos (número, nombre, logo/foto)</label>
              {candidates.map((c, i) => (
                <div className="candidate-row" key={i}>
                  <input value={c.number} onChange={(e) => updateCandidate(i, 'number', e.target.value)} placeholder="N°" />
                  <input value={c.name} onChange={(e) => updateCandidate(i, 'name', e.target.value)} placeholder="Nombre del candidato" />
                  <label className="file-input-label">
                    {c.logo ? <img className="candidate-photo" src={c.logo} alt="" /> : '📷 Logo'}
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleLogoFile(i, e.target.files[0])} />
                  </label>
                  {candidates.length > 2 && (
                    <button type="button" className="btn btn-outline" onClick={() => removeCandidate(i)}>Quitar</button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn-outline" onClick={addCandidate} style={{ marginTop: '0.3rem' }}>
                + Agregar candidato
              </button>
            </div>
          ) : (
            <div className="field-dark">
              <label>Opciones</label>
              {options.map((o, i) => (
                <div className="option-row" key={i}>
                  <input value={o} onChange={(e) => updateOption(i, e.target.value)} placeholder={`Opción ${i + 1}`} />
                  {options.length > 2 && (
                    <button type="button" className="btn btn-outline" onClick={() => removeOption(i)}>Quitar</button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn-outline" onClick={addOption} style={{ marginTop: '0.3rem' }}>
                + Agregar opción
              </button>
            </div>
          )}

          <button className="btn btn-gold" style={{ marginTop: '0.5rem' }}>Crear plantilla</button>
        </form>
      </div>

      <div className="panel">
        <h3>Plantillas existentes</h3>
        {templates.length === 0 ? (
          <div className="empty-state">Aún no hay plantillas.</div>
        ) : (
          <table className="table">
            <thead><tr><th>ID</th><th>Nombre</th><th>Tipo</th><th>Opciones / candidatos</th></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.name}<br /><span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>{t.description}</span></td>
                  <td>{t.template_type === 'presidential' ? 'Presidencial' : 'Genérica'}</td>
                  <td>
                    {t.template_type === 'presidential' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        {(t.options || []).filter(Boolean).map((o) => (
                          <div key={o.id} className="ballot-option-candidate">
                            <span className="candidate-number-chip">{o.candidateNumber}</span>
                            {o.logo ? <img className="candidate-photo" src={o.logo} alt={o.label} /> : <span className="candidate-photo-placeholder">S/F</span>}
                            <span>{o.label}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      (t.options || []).filter(Boolean).map((o) => o.label).join(', ')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ============================================================ Elecciones */

function ElectionsTab({ session }) {
  const [templates, setTemplates] = useState([]);
  const [elections, setElections] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function load() {
    api.listTemplates(session.token).then(setTemplates).catch(() => {});
    api.listAllElections(session.token).then(setElections).catch((e) => setError(e.message));
  }
  useEffect(load, [session.token]);

  async function submit(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await api.createElection(session.token, Number(templateId), title, new Date(start).toISOString(), new Date(end).toISOString());
      setSuccess('Elección creada. Se activará automáticamente en la hora programada.');
      setTitle(''); setStart(''); setEnd('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function stop(electionId) {
    if (!window.confirm('¿Detener esta elección ahora mismo? No se podrá deshacer y nadie más podrá votar.')) return;
    setError(''); setSuccess('');
    try {
      await api.stopElection(session.token, electionId);
      setSuccess('Elección detenida. Se certificará automáticamente en menos de un minuto.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h2 className="section-title">Elecciones</h2>
      <p className="section-desc">Instancia una plantilla con su ventana de tiempo. El worker de fondo la abre y cierra automáticamente.</p>

      <div className="panel">
        <h3>Nueva elección</h3>
        {error && <div className="error-banner">{error}</div>}
        {success && <div className="success-banner">{success}</div>}
        <form onSubmit={submit}>
          <div className="field-dark">
            <label>Plantilla</label>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
              <option value="">Selecciona una plantilla…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} {t.template_type === 'presidential' ? '(Presidencial)' : ''}</option>)}
            </select>
          </div>
          <div className="field-dark">
            <label>Título de la elección</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="grid-2">
            <div className="field-dark">
              <label>Apertura</label>
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
            </div>
            <div className="field-dark">
              <label>Cierre</label>
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </div>
          </div>
          <button className="btn btn-gold" style={{ marginTop: '0.5rem' }}>Programar elección</button>
        </form>
      </div>

      <div className="panel">
        <h3>Todas las elecciones</h3>
        {elections.length === 0 ? (
          <div className="empty-state">Aún no hay elecciones.</div>
        ) : (
          <table className="table">
            <thead><tr><th>ID</th><th>Título</th><th>Estado</th><th>Ventana</th><th>Votos</th><th></th></tr></thead>
            <tbody>
              {elections.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>{p.title}{p.stopped_manually && <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>detenida manualmente</div>}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
                    {new Date(p.scheduled_start).toLocaleString()} → {new Date(p.scheduled_end).toLocaleString()}
                  </td>
                  <td>{p.vote_count}</td>
                  <td>
                    {(p.status === 'scheduled' || p.status === 'active') && (
                      <button className="btn btn-danger-outline" onClick={() => stop(p.id)}>Detener</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ============================================================ Resultados */

export function ResultsTab({ session }) {
  const [elections, setElections] = useState([]);
  const [electionId, setElectionId] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => { api.listAllElections(session.token).then(setElections).catch(() => {}); }, [session.token]);

  async function fetchResults(id) {
    setError(''); setResult(null);
    try {
      const data = await api.getResults(session.token, id);
      setResult(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function downloadActa() {
    setError(''); setDownloading(true);
    try {
      await api.downloadActaPdf(session.token, electionId);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  const maxVotes = result?.results ? Math.max(1, ...result.results.map((r) => r.votes)) : 1;

  return (
    <div>
      <h2 className="section-title">Resultados</h2>
      <p className="section-desc">En vivo mientras la elección está activa; certificados (con acta y hash) una vez cerrada.</p>

      <div className="panel">
        <div className="field-dark">
          <label>Elección</label>
          <select value={electionId} onChange={(e) => { setElectionId(e.target.value); if (e.target.value) fetchResults(e.target.value); }}>
            <option value="">Selecciona una elección…</option>
            {elections.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}
          </select>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {result && (
          <div style={{ marginTop: '1rem' }}>
            {result.certified ? (
              <span className="certified-stamp">✓ Certificado</span>
            ) : (
              <span><span className="live-dot" />En vivo</span>
            )}

            {result.certified && session.role === 'admin' && (
              <button
                className="btn btn-gold"
                style={{ marginLeft: '0.75rem' }}
                onClick={downloadActa}
                disabled={downloading}
              >
                {downloading ? 'Generando acta…' : '📄 Descargar Acta de Escrutinio (PDF)'}
              </button>
            )}

            {result.certified && result.winner && (
              <div className="winner-banner" style={{ marginTop: '0.9rem' }}>
                {result.winner.logo ? (
                  <img className="candidate-photo" src={result.winner.logo} alt={result.winner.label} />
                ) : result.winner.candidateNumber ? (
                  <span className="candidate-photo-placeholder">S/F</span>
                ) : null}
                <div>
                  <div className="winner-banner-title">{result.winner.tie ? 'Empate en primer lugar' : 'Candidato / opción ganadora'}</div>
                  <div className="winner-banner-name">
                    {result.winner.candidateNumber && <span className="candidate-number-chip" style={{ marginRight: '0.4rem' }}>{result.winner.candidateNumber}</span>}
                    {result.winner.label}
                  </div>
                </div>
                <div className="winner-banner-votes">{result.winner.votes} votos<br />de {result.totalVotes} totales</div>
              </div>
            )}

            <div className="tally">
              {(result.results || []).map((r) => (
                <div className="tally-row" key={r.optionId || r.option_id}>
                  <span className="tally-label">
                    {r.candidateNumber && <span className="candidate-number-chip" style={{ marginRight: '0.4rem' }}>{r.candidateNumber}</span>}
                    {r.label}
                  </span>
                  <span className="tally-votes">{r.votes}</span>
                  <div className="tally-bar-track">
                    <div className="tally-bar-fill" style={{ width: `${(r.votes / maxVotes) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>

            {result.certified && result.byTable && result.byTable.length > 0 && (
              <div style={{ marginTop: '1.25rem' }}>
                <h3 style={{ fontSize: '0.95rem' }}>Acta de escrutinio por mesa</h3>
                {result.byTable.map((t) => (
                  <div className="by-table-card" key={`${t.pollingPlace}-${t.votingTable}`}>
                    <h4>{t.pollingPlace} — {t.votingTable}</h4>
                    <div className="table-meta">{t.totalVotes} votos en esta mesa</div>
                    {t.results.map((r) => (
                      <div key={r.optionId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '0.15rem 0' }}>
                        <span>{r.candidateNumber && <span className="candidate-number-chip" style={{ marginRight: '0.4rem' }}>{r.candidateNumber}</span>}{r.label}</span>
                        <span className="mono">{r.votes}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {result.certified && (
              <div style={{ marginTop: '1rem', fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
                <div>hash del acta:</div>
                <div className="mono">{result.recordHash}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ Escrutinio */

function ScrutinyTab({ session }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function verify() {
    setLoading(true); setError(''); setStatus(null);
    try {
      const data = await api.verifyChain(session.token);
      setStatus(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="section-title">Escrutinio</h2>
      <p className="section-desc">
        Verifica que la cadena completa de actas certificadas no haya sido alterada, recalculando
        cada hash desde el origen.
      </p>

      <div className="panel">
        <button className="btn btn-gold" onClick={verify} disabled={loading}>
          {loading ? 'Verificando…' : 'Verificar cadena de escrutinio'}
        </button>

        {error && <div className="error-banner" style={{ marginTop: '1rem' }}>{error}</div>}

        {status && (
          <div style={{ marginTop: '1.25rem' }}>
            {status.valid ? (
              <div className="success-banner">
                Cadena íntegra: {status.totalRecords} acta(s) certificada(s), sin alteraciones detectadas.
              </div>
            ) : (
              <div className="error-banner">
                Se detectó una ruptura en la cadena. Elecciones afectadas: {status.brokenAt.map((b) => b.electionId).join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ Usuarios */

function UsersTab({ session }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('admin');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await api.createAdminUser(session.token, username, password, role);
      setSuccess(`Usuario "${username}" (${role === 'auditor' ? 'auditor' : 'administrador'}) creado correctamente.`);
      setUsername(''); setPassword('');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h2 className="section-title">Usuarios administradores</h2>
      <p className="section-desc">
        Crea otras cuentas de administrador o de auditor (solo lectura: puede ver
        resultados y reportes, nunca gestionar el sistema). Úsalo para reemplazar la
        credencial de arranque apenas configures el sistema.
      </p>

      <div className="panel">
        {error && <div className="error-banner">{error}</div>}
        {success && <div className="success-banner">{success}</div>}
        <form onSubmit={submit}>
          <div className="field-dark">
            <label>Usuario</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} />
          </div>
          <div className="field-dark">
            <label>Contraseña (mínimo 10 caracteres)</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </div>
          <div className="field-dark">
            <label>Rol</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">Administrador</option>
              <option value="auditor">Auditor (solo lectura)</option>
            </select>
          </div>
          <button className="btn btn-gold">Crear usuario</button>
        </form>
      </div>
    </div>
  );
}

/* ============================================================ Padrón */

function VotersTab({ session }) {
  const [rows, setRows] = useState(
    '1000000006, Nuevo Votante Uno, Puesto Central, Mesa 1\n1000000007, Nuevo Votante Dos, Puesto Central, Mesa 2'
  );
  const [voters, setVoters] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newAccessCodes, setNewAccessCodes] = useState([]);
  const [resettingId, setResettingId] = useState(null);

  function load() {
    api.listVoters(session.token, 100, 0).then((d) => setVoters(d.voters)).catch((e) => setError(e.message));
  }
  useEffect(load, [session.token]);

  async function submit(e) {
    e.preventDefault();
    setError(''); setSuccess(''); setNewAccessCodes([]);
    const parsed = rows
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [cedula, fullName, pollingPlace, votingTable] = line.split(',').map((s) => (s || '').trim());
        return { cedula, fullName, pollingPlace, votingTable };
      })
      .filter((v) => v.cedula && v.fullName && v.pollingPlace && v.votingTable);

    if (parsed.length === 0) {
      setError('No se reconoció ninguna fila válida (formato: cedula, nombre completo, puesto de votación, mesa).');
      return;
    }

    try {
      const result = await api.uploadVoters(session.token, parsed);
      setSuccess(`Padrón actualizado: ${result.inserted} nuevos, ${result.updated} actualizados.`);
      setNewAccessCodes(result.accessCodes || []);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetPin(voterId) {
    if (!window.confirm('¿Generar un PIN nuevo para este votante? El PIN anterior (si tenía) dejará de funcionar.')) return;
    setResettingId(voterId);
    setError(''); setSuccess(''); setNewAccessCodes([]);
    try {
      const result = await api.resetVoterPin(session.token, voterId);
      setNewAccessCodes([{ cedula: result.cedula, pin: result.pin }]);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setResettingId(null);
    }
  }

  return (
    <div>
      <h2 className="section-title">Padrón electoral</h2>
      <p className="section-desc">
        Carga masiva de votantes. Una fila por votante, formato <code>cedula, nombre completo, puesto de votación, mesa</code>.
        El puesto y la mesa identifican dónde está habilitado cada votante y quedan asociados a cada voto que emita, para
        poder consolidar el escrutinio por mesa. A cada votante nuevo se le genera un PIN de acceso: es lo que usa para
        entrar a votar (junto a su cédula), no una contraseña que él mismo elige.
      </p>

      <div className="panel">
        {error && <div className="error-banner">{error}</div>}
        {success && <div className="success-banner">{success}</div>}
        <form onSubmit={submit}>
          <div className="field-dark">
            <label>Votantes a cargar</label>
            <textarea rows={6} value={rows} onChange={(e) => setRows(e.target.value)} />
          </div>
          <button className="btn btn-gold">Cargar al padrón</button>
        </form>
      </div>

      {newAccessCodes.length > 0 && (
        <div className="panel access-codes-panel">
          <h3>PIN de acceso generados</h3>
          <p className="section-desc" style={{ marginBottom: '0.8rem' }}>
            Se muestran solo esta vez: cópialos o impímelos ahora para entregarlos en el puesto de votación.
            LiveMetric no vuelve a mostrar un PIN ya generado (solo puede regenerarse, invalidando el anterior).
          </p>
          <table className="table">
            <thead><tr><th>Cédula</th><th>PIN</th></tr></thead>
            <tbody>
              {newAccessCodes.map((a) => (
                <tr key={a.cedula}>
                  <td className="mono">{a.cedula}</td>
                  <td className="mono">{a.pin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h3>Padrón actual ({voters.length} mostrados)</h3>
        {voters.length === 0 ? (
          <div className="empty-state">Sin votantes cargados todavía.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Cédula</th><th>Nombre</th><th>Puesto</th><th>Mesa</th><th>Activo</th><th>PIN</th><th></th></tr></thead>
            <tbody>
              {voters.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.cedula}</td>
                  <td>{v.full_name}</td>
                  <td>{v.polling_place}</td>
                  <td>{v.voting_table}</td>
                  <td>{v.is_active ? 'Sí' : 'No'}</td>
                  <td>{v.has_pin ? 'Asignado' : 'Sin asignar'}</td>
                  <td>
                    <button className="btn btn-outline" disabled={resettingId === v.id} onClick={() => resetPin(v.id)}>
                      {resettingId === v.id ? 'Generando…' : v.has_pin ? 'Regenerar PIN' : 'Generar PIN'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ============================================================ Auditoría */

const AUDIT_PAGE_SIZE = 25;

function AuditTab({ session }) {
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0); // 0-indexado
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api.listAuditLog(session.token, AUDIT_PAGE_SIZE, page * AUDIT_PAGE_SIZE)
      .then((d) => { setEvents(d.events); setTotal(d.total); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [session.token, page]);

  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  return (
    <div>
      <h2 className="section-title">Auditoría</h2>
      <p className="section-desc">
        Registro inmutable de intentos de inicio de sesión y de gestión de identidad.
        Nunca contiene cédulas ni contraseñas en texto plano.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        {loading ? (
          <div className="empty-state">Cargando…</div>
        ) : events.length === 0 ? (
          <div className="empty-state">Sin eventos registrados.</div>
        ) : (
          <>
            <table className="table">
              <thead><tr><th>Evento</th><th>Actor</th><th>Referencia</th><th>IP</th><th>Fecha</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.event_type}</td>
                    <td>{e.actor_type}</td>
                    <td className="mono" style={{ maxWidth: '220px' }}>{e.actor_ref}</td>
                    <td>{e.ip_address}</td>
                    <td>{new Date(e.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="pagination">
              <button className="btn btn-outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                ← Anterior
              </button>
              <span className="pagination-info">
                Página {page + 1} de {totalPages} · {total} evento{total === 1 ? '' : 's'}
              </span>
              <button className="btn btn-outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Siguiente →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

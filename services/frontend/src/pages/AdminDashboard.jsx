import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { HIDDEN_RESULTS_NOTE } from '../components/widgets/dataAdapters.js';
import { ownValue } from '../utils/ownValue.js';
import BuscadorPadron from '../components/BuscadorPadron.jsx';
import CargaPadron from '../components/CargaPadron.jsx';
import UbicacionCampos, { SIN_UBICACION, ubicacionDeLosCampos } from '../components/UbicacionCampos.jsx';
import { descargarTexto } from '../utils/descargar.js';
import { pinesCsv } from '../utils/padronArchivo.js';
import { clavePuesto, crearUbicador, describirUbicacion } from '../utils/ubicacion.js';
import PuestosTab from './PuestosTab.jsx';
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
  { id: 'puestos', label: 'Puestos' },
  { id: 'audit', label: 'Auditoría' },
];

// Mientras se carga el padrón desde un archivo, salir de la pestaña la
// detiene (después del lote en curso) y se pierden de la pantalla los PIN
// ya generados: se pregunta antes.
const AVISO_CARGA_EN_CURSO = 'Se está cargando el padrón. Si sales de esta pestaña, la carga se detiene después del lote '
  + 'actual y los PIN ya generados dejan de mostrarse (habría que regenerarlos). ¿Salir igual?';

export default function AdminDashboard({ session, onLogout }) {
  const [tab, setTab] = useState('overview');
  const cargando = useRef(false);
  const siNoHayCarga = (accion) => () => {
    if (cargando.current && !window.confirm(AVISO_CARGA_EN_CURSO)) return;
    accion();
  };

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="wordmark"><span className="seal">LM</span> LiveMetric</div>
        <div className="session-info">
          <span>Admin: {session.username}</span>
          <button className="link-button" onClick={siNoHayCarga(onLogout)}>Salir</button>
        </div>
      </div>

      <div className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={siNoHayCarga(() => setTab(t.id))}>
            {t.label}
          </button>
        ))}
      </div>

      {/* El Padrón y los Puestos tienen las tablas más anchas: usan más pantalla para no apretarlas. */}
      <div className={`content${tab === 'voters' || tab === 'puestos' ? ' content-ancho' : ''}`}>
        {tab === 'overview' && <OverviewTab session={session} />}
        {tab === 'templates' && <TemplatesTab session={session} />}
        {tab === 'elections' && <ElectionsTab session={session} />}
        {tab === 'results' && <ResultsTab session={session} />}
        {tab === 'reports' && <ReportsTab session={session} />}
        {tab === 'scrutiny' && <ScrutinyTab session={session} />}
        {tab === 'users' && <UsersTab session={session} />}
        {tab === 'voters' && <VotersTab session={session} onCargaEnCurso={(enCurso) => { cargando.current = enCurso; }} />}
        {tab === 'puestos' && <PuestosTab session={session} />}
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

// Indicador de veracidad del acta. Lo calcula analytics-service por su
// cuenta, sin preguntarle al servicio que la certificó: firma digital,
// cadena de hashes y reconteo de los votos guardados (ver
// buildIntegrityReport). Solo queda en verde si todo cuadra.
const SEAL = {
  integra: { tone: 'ok', title: '✓ Acta verificada' },
  sin_firma: { tone: 'warn', title: '⚠ Acta sin firma digital' },
  alterada: { tone: 'bad', title: '✘ Acta alterada' },
};

function ActaSeal({ integrity }) {
  if (!integrity || integrity.loading) {
    return <div className="acta-seal">Verificando la firma y la integridad del acta…</div>;
  }
  if (integrity.error) {
    return (
      <div className="acta-seal tone-bad">
        <strong>✘ No se pudo verificar el acta</strong>
        <div>{integrity.error}</div>
      </div>
    );
  }
  const { report } = integrity;
  const seal = SEAL[report.state];
  if (!seal) return null;
  return (
    <div className={`acta-seal tone-${seal.tone}`}>
      <strong>{seal.title}</strong>
      {report.state === 'integra' && (
        <div>
          Firma digital válida (clave <span className="mono">{report.publicKeyId}</span>), el contenido no cambió desde
          que se certificó y los votos guardados coinciden con el acta ({report.votes.storedTotal}).
        </div>
      )}
      {report.state === 'sin_firma' && (
        <div>
          El contenido coincide con la cadena de hashes y con los votos guardados, pero el acta se certificó antes de la
          firma digital: no se puede probar que la emitió esta instalación.
        </div>
      )}
      {report.state === 'alterada' && (
        <>
          <ul>{report.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          <div>Los resultados de abajo son los del acta tal como está guardada: no deben tomarse como oficiales.</div>
        </>
      )}
    </div>
  );
}

// Cada cuánto se vuelve a pedir el total mientras la elección no tiene acta.
export const LIVE_REFRESH_MS = 10000;

const LIVE_STATUS = {
  scheduled: 'Todavía no empieza',
  active: 'En vivo',
  closed: 'Cerrada: el escrutinio la certifica en menos de un minuto',
};

export function ResultsTab({ session }) {
  const [elections, setElections] = useState([]);
  const [electionId, setElectionId] = useState('');
  const [result, setResult] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  // La elección elegida ahora: una respuesta que llega después de cambiar
  // de elección (o un refresco atrasado) no debe pisar la de la nueva.
  const selected = useRef('');

  useEffect(() => { api.listAllElections(session.token).then(setElections).catch(() => {}); }, [session.token]);

  async function fetchResults(id, { refresh = false } = {}) {
    if (!refresh) { setError(''); setResult(null); setIntegrity(null); }
    try {
      const data = await api.getResults(session.token, id);
      if (selected.current !== id) return;
      setError('');
      setResult(data);
      if (data.certified) {
        // "electionId" en el estado: si se cambia de elección antes de que
        // llegue la respuesta, no se muestra el sello de otra.
        setIntegrity({ electionId: id, loading: true });
        api.getIntegrity(session.token, id)
          .then((report) => setIntegrity((prev) => (prev?.electionId === id ? { electionId: id, report } : prev)))
          .catch((err) => setIntegrity((prev) => (prev?.electionId === id ? { electionId: id, error: err.message } : prev)));
      }
    } catch (err) {
      if (selected.current === id) setError(err.message);
    }
  }

  // Mientras no hay acta, el total se actualiza solo. Cuando el escrutinio
  // certifica, la consulta siguiente ya trae el acta y el refresco se detiene.
  const waitingForActa = Boolean(result && !result.certified);
  useEffect(() => {
    if (!electionId || !waitingForActa) return undefined;
    const timer = setInterval(() => fetchResults(electionId, { refresh: true }), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [electionId, waitingForActa, session.token]);

  function selectElection(id) {
    selected.current = id;
    setElectionId(id);
    if (id) fetchResults(id);
    else setResult(null);
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
      <p className="section-desc">
        Mientras la elección está abierta, en vivo solo se ve cuántas personas votaron: los votos por candidato u opción
        se publican al cierre, cuando el escrutinio certifica el acta. El acta va firmada digitalmente y su veracidad se
        comprueba cada vez que se consulta.
      </p>

      <div className="panel">
        <div className="field-dark">
          <label>Elección</label>
          <select value={electionId} onChange={(e) => selectElection(e.target.value)}>
            <option value="">Selecciona una elección…</option>
            {elections.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}
          </select>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {result && (
          <div style={{ marginTop: '1rem' }}>
            {result.certified ? (
              <ActaSeal integrity={integrity?.electionId === electionId ? integrity : null} />
            ) : (
              <div className="live-total">
                <div className="live-total-status">
                  {result.status === 'active' && <span className="live-dot" />}
                  {LIVE_STATUS[result.status] || 'En vivo'}
                </div>
                <div className="live-total-value">{result.totalVotes ?? 0}</div>
                <div className="live-total-label">{result.totalVotes === 1 ? 'persona votó' : 'personas votaron'}</div>
                <div className="live-total-note">{HIDDEN_RESULTS_NOTE}</div>
              </div>
            )}

            {result.certified && session.role === 'admin' && (
              <button
                className="btn btn-gold"
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

            {result.certified && (
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
            )}

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

const SIGNATURE_LABEL = {
  valida: '✓ Válida',
  invalida: '✘ No corresponde al acta',
  otra_clave: '✘ De una clave desconocida',
  sin_firma: '⚠ Sin firma',
};
const VERDICT = {
  verificada: { tone: 'ok', label: 'Verificada' },
  sin_firma: { tone: 'warn', label: 'Sin firma digital' },
  alterada: { tone: 'bad', label: 'Alterada' },
};

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

  const altered = status ? status.records.filter((r) => r.verdict === 'alterada') : [];

  return (
    <div>
      <h2 className="section-title">Escrutinio</h2>
      <p className="section-desc">
        Verifica acta por acta que ninguna haya sido alterada: recalcula cada hash desde el origen, comprueba que la
        cadena no se rompa y que cada acta tenga la firma digital del módulo de escrutinio.
      </p>

      <div className="panel">
        <button className="btn btn-gold" onClick={verify} disabled={loading}>
          {loading ? 'Verificando…' : 'Verificar actas'}
        </button>

        {error && <div className="error-banner" style={{ marginTop: '1rem' }}>{error}</div>}

        {status && (
          <div style={{ marginTop: '1.25rem' }}>
            {status.totalRecords === 0 ? (
              <div className="empty-state">Todavía no hay actas certificadas.</div>
            ) : status.valid ? (
              <div className="success-banner">
                Ninguna acta fue alterada: {status.totalRecords} acta(s) certificada(s)
                {status.unsigned ? `, ${status.unsigned} de ellas sin firma digital (anteriores a la firma).` : ', todas con firma digital válida.'}
              </div>
            ) : (
              <div className="error-banner">
                Se detectaron actas alteradas: {altered.map((r) => `#${r.electionId}`).join(', ')}. No deben tomarse como oficiales.
              </div>
            )}

            {status.totalRecords > 0 && (
              <table className="table">
                <thead>
                  <tr><th>Elección</th><th>Certificada</th><th>Contenido</th><th>Cadena</th><th>Firma digital</th><th>Veredicto</th></tr>
                </thead>
                <tbody>
                  {status.records.map((r) => (
                    <tr key={r.electionId}>
                      <td>#{r.electionId} {r.title}</td>
                      <td>{new Date(r.certifiedAt).toLocaleString()}</td>
                      <td>{r.hashOk ? '✓ Coincide con su hash' : '✘ Modificado'}</td>
                      <td>{r.linkOk ? '✓ Enlazada' : '✘ Rota'}</td>
                      <td>{SIGNATURE_LABEL[r.signature]}</td>
                      <td>
                        <span className={`verdict tone-${VERDICT[r.verdict].tone}`}>{VERDICT[r.verdict].label}</span>
                        {r.problems.length > 0 && (
                          <ul className="verdict-problems">{r.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="section-desc" style={{ marginTop: '0.9rem' }}>
              Clave pública de esta instalación: <span className="mono">{status.publicKeyId}</span>. La firma solo la
              puede producir el módulo de escrutinio con su clave privada: modificar un acta, aunque se rehagan los
              hashes, la invalida.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ Usuarios */

const ROLE_LABEL = { admin: 'administrador', auditor: 'auditor', jurado: 'jurado de mesa' };

// Dónde autoriza un jurado: su mesa, o todo su puesto si no tiene mesa.
export const lugarJurado = (pollingPlace, votingTable) =>
  `${pollingPlace} — ${votingTable || 'todas las mesas'}`;

// Puesto y mesa de un jurado, elegidos del padrón (así coinciden con los de
// sus votantes). La mesa vacía es "todas las mesas del puesto".
function LugarJuradoFields({ places, pollingPlace, votingTable, onChange }) {
  const puesto = places.find((p) => p.pollingPlace === pollingPlace);
  return (
    <div className="grid-2">
      <div className="field-dark">
        <label>Puesto de votación</label>
        <select value={pollingPlace} onChange={(e) => onChange(e.target.value, '')} required>
          <option value="">Elige un puesto del padrón…</option>
          {places.map((p) => <option key={p.pollingPlace} value={p.pollingPlace}>{p.pollingPlace}</option>)}
        </select>
      </div>
      <div className="field-dark">
        <label>Mesa</label>
        <select value={votingTable} onChange={(e) => onChange(pollingPlace, e.target.value)} disabled={!puesto}>
          <option value="">Todas las mesas del puesto</option>
          {(puesto?.votingTables || []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
    </div>
  );
}

function UsersTab({ session }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('admin');
  const [pollingPlace, setPollingPlace] = useState('');
  const [votingTable, setVotingTable] = useState('');
  const [places, setPlaces] = useState(null);
  const [users, setUsers] = useState([]);
  // Jurado al que se le está cambiando la mesa: { id, pollingPlace, votingTable }.
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function load() {
    api.listUsers(session.token).then((d) => setUsers(d.users)).catch((e) => setError(e.message));
    api.listPadronPlaces(session.token).then((d) => setPlaces(d.places)).catch(() => setPlaces([]));
  }
  useEffect(load, [session.token]);

  const sinPadron = places !== null && places.length === 0;

  async function submit(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await api.createAdminUser(session.token, username, password, role, role === 'jurado' ? { pollingPlace, votingTable } : {});
      const donde = role === 'jurado' ? `, en ${lugarJurado(pollingPlace, votingTable)}` : '';
      setSuccess(`Usuario "${username}" (${ownValue(ROLE_LABEL, role)}${donde}) creado correctamente.`);
      setUsername(''); setPassword('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveMesa() {
    setError(''); setSuccess('');
    try {
      const result = await api.changeJuradoMesa(session.token, editing.id, editing.pollingPlace, editing.votingTable);
      setSuccess(`Jurado "${editing.username}" ahora en ${lugarJurado(result.pollingPlace, result.votingTable)}.`);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetTotp(user) {
    if (!window.confirm(`¿Restablecer el autenticador de "${user.username}"? Tendrá que registrarlo de nuevo en su próximo ingreso.`)) return;
    setError(''); setSuccess('');
    try {
      await api.resetUserTotp(session.token, user.id);
      setSuccess(`Autenticador de "${user.username}" restablecido: lo registra de nuevo en su próximo ingreso.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h2 className="section-title">Usuarios</h2>
      <p className="section-desc">
        Crea cuentas de administrador, de auditor (solo lectura: puede ver resultados y reportes, nunca gestionar el
        sistema) o de jurado de mesa. El jurado autoriza el ingreso de los votantes asistidos de su mesa, o de todo su
        puesto, con el código de su propio autenticador, que registra en su primer ingreso. Úsalo también para
        reemplazar la credencial de arranque apenas configures el sistema.
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
            <label>Contraseña (mínimo 12 caracteres)</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" />
            <div className="field-hint-dark">
              Tres tipos entre minúsculas, mayúsculas, números y símbolos (o una frase de 16 caracteres o más). No puede
              ser una contraseña común, tener secuencias como 123456 o qwerty, ni contener el usuario.
            </div>
          </div>
          <div className="field-dark">
            <label>Rol</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">Administrador</option>
              <option value="auditor">Auditor (solo lectura)</option>
              <option value="jurado">Jurado de mesa (autoriza votos asistidos)</option>
            </select>
          </div>
          {role === 'jurado' && (sinPadron ? (
            <div className="error-banner">Carga el padrón antes de crear jurados: el puesto y la mesa se eligen de él.</div>
          ) : (
            <>
              <LugarJuradoFields
                places={places || []}
                pollingPlace={pollingPlace}
                votingTable={votingTable}
                onChange={(p, m) => { setPollingPlace(p); setVotingTable(m); }}
              />
              <div className="field-hint-dark" style={{ marginTop: '-0.4rem', marginBottom: '0.9rem' }}>
                Con «Todas las mesas del puesto», el jurado puede autorizar a los votantes asistidos de cualquier mesa
                de ese puesto.
              </div>
            </>
          ))}
          <button className="btn btn-gold" disabled={role === 'jurado' && sinPadron}>Crear usuario</button>
        </form>
      </div>

      <div className="panel">
        <h3>Usuarios ({users.length})</h3>
        <div className="tabla-desplazable">
          <table className="table">
            <thead><tr><th>Usuario</th><th>Rol</th><th>Puesto y mesa</th><th>Autenticador</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{ownValue(ROLE_LABEL, u.role) || u.role}</td>
                  <td>
                    {u.role !== 'jurado' ? '—' : editing?.id === u.id ? (
                      <div className="editar-mesa">
                        <LugarJuradoFields
                          places={places || []}
                          pollingPlace={editing.pollingPlace}
                          votingTable={editing.votingTable}
                          onChange={(p, m) => setEditing({ ...editing, pollingPlace: p, votingTable: m })}
                        />
                        <div className="acciones-padron">
                          <button className="btn btn-gold" disabled={!editing.pollingPlace} onClick={saveMesa}>Guardar</button>
                          <button className="btn btn-outline" onClick={() => setEditing(null)}>Cancelar</button>
                        </div>
                      </div>
                    ) : lugarJurado(u.polling_place, u.voting_table)}
                  </td>
                  <td>{u.role !== 'jurado' ? '—' : u.has_totp ? 'Registrado' : 'Pendiente (primer ingreso)'}</td>
                  <td>
                    {u.role === 'jurado' && (
                      <div className="acciones-padron">
                        {editing?.id !== u.id && !sinPadron && (
                          <button
                            className="btn btn-outline"
                            onClick={() => {
                              // Si su puesto está en el padrón, se parte de él (y de su mesa, si existe).
                              const puesto = (places || []).find((p) => p.pollingPlace === u.polling_place);
                              const mesa = puesto?.votingTables.includes(u.voting_table) ? u.voting_table : '';
                              setEditing({ id: u.id, username: u.username, pollingPlace: puesto ? u.polling_place : '', votingTable: mesa });
                            }}
                          >
                            Cambiar mesa
                          </button>
                        )}
                        {u.has_totp && (
                          <button className="btn btn-outline" onClick={() => resetTotp(u)}>Restablecer autenticador</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ Padrón */

// Cuánto vale cada PIN desde que se genera (PIN_VIGENCIA_HORAS del
// servicio): "24 horas", "3 días", "1 hora".
export function duracionDelPin(horas) {
  if (horas % 24 === 0 && horas > 24) return `${horas / 24} días`;
  return horas === 1 ? '1 hora' : `${horas} horas`;
}

// "Vencen el 4 de oct, 18:00", o entre dos fechas si los PIN se generaron
// en momentos distintos (una carga larga, en lotes).
function cuandoVencen(codigos) {
  const fechas = codigos.map((c) => new Date(c.expiresAt).getTime()).filter((t) => !Number.isNaN(t));
  if (fechas.length === 0) return null;
  const [primera, ultima] = [Math.min(...fechas), Math.max(...fechas)].map(formatPinExpiry);
  return primera === ultima ? <>Vencen el <strong>{primera}</strong>.</> : <>Vencen entre el <strong>{primera}</strong> y el <strong>{ultima}</strong>.</>;
}

// Corta, para que entre en la celda del listado: "4 de oct, 18:00" (con el
// año solo si no es el actual).
export function formatPinExpiry(fecha) {
  const d = new Date(fecha);
  const opciones = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (d.getFullYear() !== new Date().getFullYear()) opciones.year = 'numeric';
  return d.toLocaleString('es-CO', opciones);
}

// Estado del PIN en el listado: si tiene, hasta cuándo vale.
function pinStatus(v, ahora) {
  if (!v.has_pin) return 'Sin asignar';
  if (!v.pin_expires_at) return 'Asignado (sin vencimiento)';
  if (new Date(v.pin_expires_at).getTime() <= ahora) return 'Vencido';
  return `Vence ${formatPinExpiry(v.pin_expires_at)}`;
}

const VOTERS_PAGE_SIZE = 50;
const SIN_FILTROS = { q: '', pollingPlace: '', votingTable: '', pin: '', totp: '', assisted: '' };
const PIN_FILTRO = { vigente: 'Vigente', vencido: 'Vencido', sin_vencimiento: 'Sin vencimiento', sin_asignar: 'Sin asignar' };

let siguienteFila = 1;
// Una fila del formulario de alta. Puesto, mesa y ubicación se copian de la
// anterior: suelen agregarse varios votantes de la misma mesa seguidos.
const filaNueva = (anterior = {}) => ({
  key: siguienteFila++,
  cedula: '',
  fullName: '',
  pollingPlace: anterior.pollingPlace || '',
  votingTable: anterior.votingTable || '',
  ubicacion: anterior.ubicacion || SIN_UBICACION,
});

// Debajo de cada votante del formulario, la ubicación de su puesto: la que
// ya tiene, o los campos para darle una si todavía no la tiene (solo en la
// primera fila de ese puesto).
function UbicacionDeLaFila({ fila, filas, puesto, pide, ubicador, onChange }) {
  if (!fila.pollingPlace.trim()) return null;
  if (puesto?.ubicacion) {
    return <p className="ubicacion-puesto field-hint-dark">Ubicación del puesto: {describirUbicacion(puesto.ubicacion)}</p>;
  }
  if (!pide) {
    const primera = filas.findIndex((f) => clavePuesto(f.pollingPlace) === clavePuesto(fila.pollingPlace));
    return <p className="ubicacion-puesto field-hint-dark">Ubicación del puesto: la del votante {primera + 1}.</p>;
  }
  return (
    <fieldset className="ubicacion-puesto">
      <legend>{puesto ? 'Este puesto todavía no tiene ubicación' : 'Puesto nuevo: ¿dónde queda?'}</legend>
      {ubicador
        ? <UbicacionCampos ubicador={ubicador} valor={fila.ubicacion} onChange={onChange} idBase={`ubicacion-${fila.key}`} />
        : <p className="field-hint-dark">Cargando la lista de municipios…</p>}
    </fieldset>
  );
}

// Los PIN que se listan en pantalla; todos van en el archivo para descargar.
const PINES_MOSTRADOS = 50;

function VotersTab({ session, onCargaEnCurso }) {
  const [modoAlta, setModoAlta] = useState('formulario');
  const [filas, setFilas] = useState(() => [filaNueva()]);
  const [voters, setVoters] = useState([]);
  const [total, setTotal] = useState(0);
  const [registered, setRegistered] = useState(0);
  const [places, setPlaces] = useState([]);
  const [filtros, setFiltros] = useState(SIN_FILTROS);
  const [busqueda, setBusqueda] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newAccessCodes, setNewAccessCodes] = useState([]);
  const [resettingId, setResettingId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  // Horas que vale cada PIN desde que se genera (las fija el servicio).
  const [pinVigenciaHoras, setPinVigenciaHoras] = useState(null);
  // El catálogo del DANE, para la ubicación de un puesto nuevo.
  const [ubicador, setUbicador] = useState(null);

  function load() {
    api.listVoters(session.token, { ...filtros, limit: VOTERS_PAGE_SIZE, offset: page * VOTERS_PAGE_SIZE })
      .then((d) => {
        setVoters(d.voters);
        setTotal(d.total ?? d.voters.length);
        setRegistered(d.registered ?? d.voters.length);
        if (d.pinVigenciaHoras) setPinVigenciaHoras(d.pinVigenciaHoras);
      })
      .catch((e) => setError(e.message));
  }
  useEffect(load, [session.token, filtros, page]);

  // Los puestos (para los filtros, las sugerencias del formulario y la
  // ubicación de cada uno) cambian solo al agregar o eliminar: no se piden
  // en cada cambio de filtro.
  function loadPlaces() {
    api.listPuestos(session.token).then((d) => setPlaces(d.puestos || [])).catch(() => {});
  }
  useEffect(loadPlaces, [session.token]);
  useEffect(() => {
    api.getDivipola(session.token).then((catalogo) => setUbicador(crearUbicador(catalogo))).catch(() => {});
  }, [session.token]);
  const puestoPorClave = new Map(places.map((p) => [clavePuesto(p.pollingPlace), p]));
  // La fila del formulario que lleva la ubicación de su puesto: la primera de
  // un puesto que todavía no la tiene (las demás del mismo puesto, no).
  const pideUbicacion = (fila, i) => {
    const clave = clavePuesto(fila.pollingPlace);
    return clave !== '' && !puestoPorClave.get(clave)?.ubicacion && filas.findIndex((f) => clavePuesto(f.pollingPlace) === clave) === i;
  };

  // Cada PIN, con su vencimiento: el de la respuesta que lo generó.
  const conVencimiento = (codigos, vence) => (codigos || []).map((c) => ({ ...c, expiresAt: vence }));
  const limpiarMensajes = () => { setError(''); setSuccess(''); setNewAccessCodes([]); };

  // Los filtros se aplican al cambiarlos (la búsqueda, al pulsar Buscar), y
  // vuelven a la primera página.
  function filtrar(cambios) {
    setFiltros((actual) => ({ ...actual, ...cambios }));
    setPage(0);
  }
  const hayFiltros = Object.values(filtros).some(Boolean);
  const mesasDelFiltro = places.find((p) => p.pollingPlace === filtros.pollingPlace)?.votingTables || [];

  function cambiarFila(key, campo, valor) {
    setFilas((actuales) => actuales.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }

  async function submit(e) {
    e.preventDefault();
    limpiarMensajes();
    const nuevos = filas.map((fila, i) => ({
      cedula: fila.cedula.trim(),
      fullName: fila.fullName.trim(),
      pollingPlace: fila.pollingPlace.trim(),
      votingTable: fila.votingTable.trim(),
      ...(pideUbicacion(fila, i) && ubicador ? ubicacionDeLosCampos(fila.ubicacion, ubicador.pais) : {}),
    }));
    try {
      const result = await api.addVoters(session.token, nuevos);
      const agregados = `Se ${result.inserted === 1 ? 'agregó 1 votante' : `agregaron ${result.inserted} votantes`} al padrón.`;
      const repetidos = result.duplicates?.length
        ? ` Ya estaban y no se modificaron: ${result.duplicates.join(', ')}.`
        : '';
      setSuccess(agregados + repetidos);
      setNewAccessCodes(conVencimiento(result.accessCodes, result.pinExpiresAt));
      setFilas([filaNueva(filas[filas.length - 1])]);
      load();
      loadPlaces();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetPin(voter) {
    if (!window.confirm('¿Generar un PIN nuevo para este votante? El PIN anterior (si tenía) dejará de funcionar.')) return;
    setResettingId(voter.id);
    limpiarMensajes();
    try {
      const result = await api.resetVoterPin(session.token, voter.id);
      setNewAccessCodes(conVencimiento([{
        cedula: result.cedula, pin: result.pin, fullName: voter.full_name, pollingPlace: voter.polling_place, votingTable: voter.voting_table,
      }], result.pinExpiresAt));
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setResettingId(null);
    }
  }

  async function resetTotp(voter) {
    if (!window.confirm(`¿Restablecer el autenticador de ${voter.full_name}? En su próximo ingreso, con su cédula y su PIN, lo registra de nuevo.`)) return;
    limpiarMensajes();
    setSavingId(voter.id);
    try {
      await api.resetVoterTotp(session.token, voter.id);
      setSuccess(`Autenticador de ${voter.full_name} restablecido.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  }

  async function setAssisted(voter, assisted) {
    const aviso = assisted
      ? `¿Marcar a ${voter.full_name} para el voto asistido? Entrará con su PIN y la autorización del jurado de su mesa, en lugar de su autenticador.`
      : `¿Quitar el voto asistido de ${voter.full_name}? Entrará con su PIN y su autenticador.`;
    if (!window.confirm(aviso)) return;
    limpiarMensajes();
    setSavingId(voter.id);
    try {
      await api.setVoterAssisted(session.token, voter.id, assisted);
      setSuccess(assisted ? `${voter.full_name} votará asistido.` : `${voter.full_name} ya no vota asistido.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  }

  async function remove(voter) {
    if (!window.confirm(
      `¿Eliminar a ${voter.full_name} (cédula ${voter.cedula}) del padrón? No se puede deshacer: ya no podrá ingresar. ` +
      'Los votos que ya emitió se conservan, porque son anónimos.'
    )) return;
    limpiarMensajes();
    setSavingId(voter.id);
    try {
      await api.deleteVoter(session.token, voter.id);
      setSuccess(`${voter.full_name} fue eliminado del padrón.`);
      load();
      loadPlaces();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  }

  // La lista de PIN, para imprimirla o repartirla por mesa.
  function descargarPines() {
    const fecha = (vence) => (vence ? new Date(vence).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '');
    const marca = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    descargarTexto(`pin-padron-${marca}.csv`, pinesCsv(newAccessCodes.map((c) => ({ ...c, vence: fecha(c.expiresAt) }))));
  }

  function cambiarModo(modo) {
    setError('');
    setSuccess('');
    setModoAlta(modo);
  }

  const totalPages = Math.max(1, Math.ceil(total / VOTERS_PAGE_SIZE));

  // Dónde se generan PIN, cuánto valen: el tiempo corre desde que se generan.
  const avisoVigencia = pinVigenciaHoras && (
    <p className="field-hint-dark aviso-vigencia">
      Cada PIN vence <strong>{duracionDelPin(pinVigenciaHoras)}</strong> después de generarlo, haya o no una elección:
      conviene generarlos y entregarlos poco antes de votar.
    </p>
  );

  return (
    <div>
      <h2 className="section-title">Padrón electoral</h2>
      <p className="section-desc">
        Agrega a cada votante con su cédula, su nombre, su puesto de votación y su mesa. El puesto y la mesa identifican
        dónde está habilitado y quedan asociados a cada voto que emita, para poder consolidar el escrutinio por mesa. Un
        puesto nuevo se registra con su ubicación (departamento, municipio, localidad y zona urbana o rural), que después
        se ve y se corrige en la pestaña «Puestos». A
        cada votante nuevo se le genera un PIN de acceso: es lo que usa para entrar a votar (junto a su cédula), no una
        contraseña que él mismo elige. Además, en su primer ingreso registra un autenticador (Microsoft o Google
        Authenticator) y desde ahí entra también con su código. Quien no pueda usar una app se marca para el{' '}
        <strong>voto asistido</strong>: lo autoriza el jurado de su mesa, que verifica su cédula en persona. Los datos de
        un votante no se editan: si algo está mal, se elimina y se vuelve a agregar. Para muchos votantes a la vez,
        «Varios desde un archivo o Excel» carga un CSV o las celdas copiadas de una hoja de cálculo.
      </p>
      <p className="section-desc">
        <strong>Vigencia del PIN:</strong> cada PIN vence{pinVigenciaHoras ? ` ${duracionDelPin(pinVigenciaHoras)}` : ''} después de
        generarlo (al agregar al votante o al regenerarlo) y, hasta entonces, sirve haya o no una votación abierta (por
        ejemplo, para registrar el autenticador antes de votar). Votar, en cambio, solo se puede dentro del horario de la
        elección.
      </p>

      <div className="panel">
        <h3>Agregar votantes</h3>
        <div className="modo-alta" role="group" aria-label="Cómo agregar votantes">
          {[['formulario', 'Uno por uno'], ['archivo', 'Varios desde un archivo o Excel']].map(([modo, texto]) => (
            <button
              key={modo}
              type="button"
              className={`btn ${modoAlta === modo ? 'btn-gold' : 'btn-outline'}`}
              aria-pressed={modoAlta === modo}
              onClick={() => cambiarModo(modo)}
            >
              {texto}
            </button>
          ))}
        </div>
        {error && <div className="error-banner">{error}</div>}
        {success && <div className="success-banner">{success}</div>}
        {modoAlta === 'formulario' && (
          <form onSubmit={submit}>
            <datalist id="puestos-padron">
              {places.map((p) => <option key={p.pollingPlace} value={p.pollingPlace} />)}
            </datalist>
            {filas.map((fila, i) => {
              const mesas = places.find((p) => p.pollingPlace.toLowerCase() === fila.pollingPlace.trim().toLowerCase())?.votingTables || [];
              return (
                <fieldset className="fila-votante" key={fila.key}>
                  <legend>Votante {i + 1}</legend>
                  <div className="field-dark">
                    <label htmlFor={`cedula-${fila.key}`}>Cédula</label>
                    <input
                      id={`cedula-${fila.key}`}
                      value={fila.cedula}
                      onChange={(e) => cambiarFila(fila.key, 'cedula', e.target.value)}
                      required
                      pattern="[0-9A-Za-z\-]{5,20}"
                      title="De 5 a 20 letras, números o guiones"
                      inputMode="numeric"
                    />
                  </div>
                  <div className="field-dark">
                    <label htmlFor={`nombre-${fila.key}`}>Nombre completo</label>
                    <input id={`nombre-${fila.key}`} value={fila.fullName} onChange={(e) => cambiarFila(fila.key, 'fullName', e.target.value)} required minLength={3} />
                  </div>
                  <div className="field-dark">
                    <label htmlFor={`puesto-${fila.key}`}>Puesto de votación</label>
                    <input id={`puesto-${fila.key}`} list="puestos-padron" value={fila.pollingPlace} onChange={(e) => cambiarFila(fila.key, 'pollingPlace', e.target.value)} required minLength={2} />
                  </div>
                  <div className="field-dark">
                    <label htmlFor={`mesa-${fila.key}`}>Mesa</label>
                    <input id={`mesa-${fila.key}`} list={`mesas-${fila.key}`} value={fila.votingTable} onChange={(e) => cambiarFila(fila.key, 'votingTable', e.target.value)} required />
                    <datalist id={`mesas-${fila.key}`}>
                      {mesas.map((m) => <option key={m} value={m} />)}
                    </datalist>
                  </div>
                  {filas.length > 1 && (
                    <button type="button" className="link-button quitar-fila" onClick={() => setFilas(filas.filter((f) => f.key !== fila.key))}>
                      Quitar
                    </button>
                  )}
                  <UbicacionDeLaFila
                    fila={fila}
                    filas={filas}
                    puesto={puestoPorClave.get(clavePuesto(fila.pollingPlace))}
                    pide={pideUbicacion(fila, i)}
                    ubicador={ubicador}
                    onChange={(valor) => cambiarFila(fila.key, 'ubicacion', valor)}
                  />
                </fieldset>
              );
            })}
            <button type="button" className="btn btn-outline" style={{ marginBottom: '1rem' }} onClick={() => setFilas([...filas, filaNueva(filas[filas.length - 1])])}>
              + Agregar otro votante
            </button>
            {avisoVigencia}
            <button className="btn btn-gold">{filas.length === 1 ? 'Agregar al padrón' : `Agregar ${filas.length} votantes al padrón`}</button>
          </form>
        )}
        {/* Montada siempre (oculta en el otro modo): cambiar de modo no
            interrumpe una carga ni pierde lo que se estaba revisando. */}
        <div hidden={modoAlta !== 'archivo'}>
          <CargaPadron
            token={session.token}
            avisoVigencia={avisoVigencia}
            onPines={setNewAccessCodes}
            onCambio={() => {
              load();
              loadPlaces();
            }}
            onCargaEnCurso={onCargaEnCurso}
          />
        </div>
      </div>

      {newAccessCodes.length > 0 && (
        <div className="panel access-codes-panel">
          <h3>PIN de acceso generados</h3>
          <p className="section-desc" style={{ marginBottom: '0.8rem' }}>
            Se muestran solo esta vez: descárgalos, cópialos o imprímelos ahora para entregarlos en el puesto de votación.
            LiveMetric no vuelve a mostrar un PIN ya generado (solo puede regenerarse, invalidando el anterior).
            {' '}{cuandoVencen(newAccessCodes)}
          </p>
          <div className="descarga-pines">
            <button type="button" className="btn btn-gold" onClick={descargarPines}>
              {newAccessCodes.length === 1 ? 'Descargar el PIN (CSV)' : `Descargar los ${newAccessCodes.length.toLocaleString('es-CO')} PIN (CSV)`}
            </button>
            <span className="field-hint-dark">
              Con la cédula, ese archivo da acceso al voto: guárdalo en un lugar seguro y bórralo cuando termines de entregar los PIN.
            </span>
          </div>
          <div className="tabla-desplazable">
            <table className="table">
              <thead><tr><th>Cédula</th><th>Nombre</th><th>Puesto y mesa</th><th>PIN</th></tr></thead>
              <tbody>
                {newAccessCodes.slice(0, PINES_MOSTRADOS).map((a) => (
                  <tr key={a.cedula}>
                    <td className="mono">{a.cedula}</td>
                    <td>{a.fullName}</td>
                    <td>{[a.pollingPlace, a.votingTable].filter(Boolean).join(' — ')}</td>
                    <td className="mono">{a.pin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {newAccessCodes.length > PINES_MOSTRADOS && (
            <p className="field-hint-dark">
              Y {(newAccessCodes.length - PINES_MOSTRADOS).toLocaleString('es-CO')} más: están todos en el archivo para descargar.
            </p>
          )}
        </div>
      )}

      <div className="panel">
        <h3>Padrón actual</h3>
        <form className="filtros-padron" onSubmit={(e) => { e.preventDefault(); filtrar({ q: busqueda.trim() }); }}>
          <div className="field-dark filtro-busqueda">
            <label htmlFor="filtro-busqueda">Buscar por cédula o nombre</label>
            <div className="busqueda">
              <BuscadorPadron
                token={session.token}
                value={busqueda}
                onChange={(texto) => {
                  setBusqueda(texto);
                  // Borrar la búsqueda (a mano o con la ×) vuelve a mostrar a todos.
                  if (!texto.trim() && filtros.q) filtrar({ q: '' });
                }}
                onSearch={(q) => filtrar({ q: q.trim() })}
              />
              <button className="btn btn-outline">Buscar</button>
            </div>
          </div>
          <div className="field-dark">
            <label htmlFor="filtro-puesto">Puesto</label>
            <select id="filtro-puesto" value={filtros.pollingPlace} onChange={(e) => filtrar({ pollingPlace: e.target.value, votingTable: '' })}>
              <option value="">Todos</option>
              {places.filter((p) => p.voters > 0).map((p) => <option key={p.pollingPlace} value={p.pollingPlace}>{p.pollingPlace}</option>)}
            </select>
          </div>
          <div className="field-dark">
            <label htmlFor="filtro-mesa">Mesa</label>
            <select id="filtro-mesa" value={filtros.votingTable} onChange={(e) => filtrar({ votingTable: e.target.value })} disabled={!filtros.pollingPlace}>
              <option value="">Todas</option>
              {mesasDelFiltro.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="field-dark">
            <label htmlFor="filtro-pin">PIN</label>
            <select id="filtro-pin" value={filtros.pin} onChange={(e) => filtrar({ pin: e.target.value })}>
              <option value="">Todos</option>
              {Object.entries(PIN_FILTRO).map(([valor, texto]) => <option key={valor} value={valor}>{texto}</option>)}
            </select>
          </div>
          <div className="field-dark">
            <label htmlFor="filtro-totp">Autenticador</label>
            <select id="filtro-totp" value={filtros.totp} onChange={(e) => filtrar({ totp: e.target.value })}>
              <option value="">Todos</option>
              <option value="registrado">Registrado</option>
              <option value="pendiente">Pendiente</option>
            </select>
          </div>
          <div className="field-dark">
            <label htmlFor="filtro-asistido">Voto asistido</label>
            <select id="filtro-asistido" value={filtros.assisted} onChange={(e) => filtrar({ assisted: e.target.value })}>
              <option value="">Todos</option>
              <option value="true">Sí</option>
              <option value="false">No</option>
            </select>
          </div>
        </form>
        <div className="resumen-filtros">
          <span>{hayFiltros ? `${total} de ${registered} votantes` : `${registered} votante${registered === 1 ? '' : 's'}`}</span>
          {hayFiltros && (
            <button className="link-button" onClick={() => { setBusqueda(''); filtrar(SIN_FILTROS); }}>Limpiar filtros</button>
          )}
        </div>

        {voters.length === 0 ? (
          <div className="empty-state">{hayFiltros ? 'Ningún votante coincide con los filtros.' : 'Sin votantes cargados todavía.'}</div>
        ) : (
          <>
            <div className="tabla-desplazable">
              <table className="table">
                <thead>
                  <tr>
                    <th>Cédula</th><th>Nombre</th><th>Puesto</th><th>Mesa</th><th>PIN</th><th>Autenticador</th><th>Voto asistido</th>
                    <th colSpan={3} className="acciones-titulo">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {voters.map((v) => (
                    <tr key={v.id}>
                      <td className="mono sin-corte">{v.cedula}</td>
                      <td>{v.full_name}</td>
                      <td>
                        {v.polling_place}
                        <span className="ubicacion-celda">{describirUbicacion(puestoPorClave.get(clavePuesto(v.polling_place))?.ubicacion)}</span>
                      </td>
                      <td>{v.voting_table}</td>
                      <td>{pinStatus(v, Date.now())}</td>
                      <td>{v.assisted ? 'No lo usa' : v.has_totp ? 'Registrado' : 'Pendiente'}</td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Voto asistido de ${v.full_name}`}
                          checked={v.assisted}
                          disabled={savingId === v.id}
                          onChange={(e) => setAssisted(v, e.target.checked)}
                        />
                      </td>
                      {/* Una columna por acción: así cada una queda alineada en
                          todas las filas, aunque a un votante le falte alguna. */}
                      <td className="accion">
                        <button className="btn btn-outline" disabled={resettingId === v.id} onClick={() => resetPin(v)}>
                          {resettingId === v.id ? 'Generando…' : v.has_pin ? 'Regenerar PIN' : 'Generar PIN'}
                        </button>
                      </td>
                      <td className="accion">
                        {v.has_totp && !v.assisted && (
                          <button className="btn btn-outline" disabled={savingId === v.id} onClick={() => resetTotp(v)}>
                            Restablecer autenticador
                          </button>
                        )}
                      </td>
                      <td className="accion">
                        <button className="btn btn-danger-outline" disabled={savingId === v.id} onClick={() => remove(v)}>
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > VOTERS_PAGE_SIZE && (
              <div className="pagination">
                <button className="btn btn-outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  ← Anterior
                </button>
                <span className="pagination-info">Página {page + 1} de {totalPages} · {total} votantes</span>
                <button className="btn btn-outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Siguiente →
                </button>
              </div>
            )}
          </>
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

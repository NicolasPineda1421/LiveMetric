// Pestaña "Puestos": cada puesto de votación con su ubicación (país,
// departamento, municipio, localidad y zona urbana o rural), sus mesas y
// cuántos votantes tiene. Un puesto se registra al agregar a su primer
// votante; aquí se le pone la ubicación si todavía no la tiene (los de antes
// de la migración 009), se corrige, o se quita si ya no tiene votantes.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import FiltrosUbicacion from '../components/FiltrosUbicacion.jsx';
import UbicacionCampos, { camposDeUbicacion, ubicacionDeLosCampos } from '../components/UbicacionCampos.jsx';
import { crearUbicador, cumpleUbicacion, describirUbicacion, hayFiltroDeUbicacion, SIN_FILTRO_DE_UBICACION } from '../utils/ubicacion.js';

const numero = (n) => n.toLocaleString('es-CO');
const plural = (n, uno, varios) => `${numero(n)} ${n === 1 ? uno : varios}`;
const enOrden = (a, b) => (a || '').localeCompare(b || '', 'es', { numeric: true });

// Primero los que no tienen ubicación; después por departamento, municipio y nombre.
const ordenar = (puestos) => [...puestos].sort((a, b) => Number(Boolean(a.ubicacion)) - Number(Boolean(b.ubicacion))
  || enOrden(a.ubicacion?.departamento, b.ubicacion?.departamento)
  || enOrden(a.ubicacion?.municipio, b.ubicacion?.municipio)
  || enOrden(a.pollingPlace, b.pollingPlace));

export default function PuestosTab({ session }) {
  const [puestos, setPuestos] = useState(null);
  const [ubicador, setUbicador] = useState(null);
  const [filtro, setFiltro] = useState(SIN_FILTRO_DE_UBICACION);
  const [editando, setEditando] = useState(null); // { pollingPlace, valor }
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function load() {
    api.listPuestos(session.token).then((d) => setPuestos(d.puestos)).catch((e) => setError(e.message));
  }
  useEffect(load, [session.token]);
  useEffect(() => {
    api.getDivipola(session.token).then((catalogo) => setUbicador(crearUbicador(catalogo))).catch((e) => setError(e.message));
  }, [session.token]);

  function editar(puesto) {
    setError('');
    setSuccess('');
    setEditando({ pollingPlace: puesto.pollingPlace, valor: camposDeUbicacion(puesto.ubicacion) });
  }

  async function guardar(e) {
    e.preventDefault();
    setGuardando(true);
    setError('');
    try {
      const r = await api.savePuestoUbicacion(session.token, editando.pollingPlace, ubicacionDeLosCampos(editando.valor, ubicador.pais));
      setSuccess(`Ubicación de «${r.pollingPlace}» guardada: ${describirUbicacion(r.ubicacion)}.`);
      setEditando(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  }

  async function quitar(puesto) {
    if (!window.confirm(`¿Quitar el puesto «${puesto.pollingPlace}»? Ya no tiene votantes; si se vuelve a agregar alguno, se registra de nuevo con su ubicación.`)) return;
    setError('');
    setSuccess('');
    try {
      await api.deletePuesto(session.token, puesto.ubicacion.id);
      setSuccess(`El puesto «${puesto.pollingPlace}» fue quitado.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const todos = puestos || [];
  const sinUbicacion = todos.filter((p) => !p.ubicacion);
  const conUbicacion = todos.filter((p) => p.ubicacion);
  const municipios = new Set(conUbicacion.map((p) => p.ubicacion.codigoMunicipio)).size;
  const rurales = conUbicacion.filter((p) => p.ubicacion.zona === 'rural').length;
  const mostrados = ordenar(todos.filter((p) => cumpleUbicacion(p.ubicacion, filtro)));
  const votantesMostrados = mostrados.reduce((s, p) => s + p.voters, 0);

  return (
    <div>
      <h2 className="section-title">Puestos de votación</h2>
      <p className="section-desc">
        Cada puesto tiene su ubicación: país, departamento y municipio (de la lista oficial del DANE), localidad (opcional;
        en Bogotá, una de sus 20) y zona urbana o rural. Un puesto se registra al agregar a su primer votante en
        «Padrón», con el formulario o desde un archivo. Aquí se ve dónde queda cada uno, cuántas mesas y votantes tiene,
        y se corrige su ubicación. El nombre identifica al puesto en todo el país: dos puestos de municipios distintos
        necesitan nombres distintos.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}
      {sinUbicacion.length > 0 && (
        <div className="aviso-puestos" role="status">
          {sinUbicacion.length === 1
            ? '1 puesto no tiene ubicación todavía: no se le pueden agregar votantes hasta que la tenga. Pónsela con «Poner ubicación».'
            : `${numero(sinUbicacion.length)} puestos no tienen ubicación todavía: no se les pueden agregar votantes hasta que la tengan. `
              + 'Pónsela a cada uno con «Poner ubicación».'}
        </div>
      )}

      <div className="panel">
        <div className="filtros-ubicacion filtros-puestos">
          <FiltrosUbicacion puestos={todos} valor={filtro} onChange={(cambios) => setFiltro({ ...filtro, ...cambios })} idBase="filtro-puestos" />
        </div>
        <div className="resumen-filtros resumen-puestos">
          <span>
            {puestos === null ? 'Cargando…' : `${plural(todos.length, 'puesto', 'puestos')}`}
            {conUbicacion.length > 0
              && ` en ${plural(municipios, 'municipio', 'municipios')} · ${plural(conUbicacion.length - rurales, 'urbano', 'urbanos')} y ${plural(rurales, 'rural', 'rurales')}`}
            {hayFiltroDeUbicacion(filtro) && ` · se muestran ${plural(mostrados.length, 'puesto', 'puestos')}, con ${plural(votantesMostrados, 'votante', 'votantes')}`}
          </span>
          {hayFiltroDeUbicacion(filtro) && (
            <button className="link-button" onClick={() => setFiltro(SIN_FILTRO_DE_UBICACION)}>Limpiar filtros</button>
          )}
        </div>

        {puestos !== null && todos.length === 0 ? (
          <div className="empty-state">Todavía no hay puestos: se registran al agregar votantes en «Padrón».</div>
        ) : (
          <div className="tabla-desplazable">
            <table className="table">
              <thead>
                <tr>
                  <th>Puesto</th><th>Departamento</th><th>Municipio</th><th>Localidad</th><th>Zona</th><th>Mesas</th><th>Votantes</th>
                  <th className="acciones-titulo">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {mostrados.map((p) => (
                  <PuestoFila
                    key={p.pollingPlace}
                    puesto={p}
                    editando={editando?.pollingPlace === p.pollingPlace ? editando : null}
                    ubicador={ubicador}
                    guardando={guardando}
                    onEditar={() => editar(p)}
                    onCambio={(valor) => setEditando({ ...editando, valor })}
                    onGuardar={guardar}
                    onCancelar={() => setEditando(null)}
                    onQuitar={() => quitar(p)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PuestoFila({ puesto, editando, ubicador, guardando, onEditar, onCambio, onGuardar, onCancelar, onQuitar }) {
  const u = puesto.ubicacion;
  return (
    <>
      <tr className={u ? undefined : 'puesto-sin-ubicacion'}>
        <td>{puesto.pollingPlace}</td>
        {u ? (
          <>
            <td>{u.departamento}</td>
            <td>{u.municipio}</td>
            <td>{u.localidad || '—'}</td>
            <td>{u.zona === 'rural' ? 'Rural' : 'Urbana'}</td>
          </>
        ) : (
          <td colSpan={4} className="sin-ubicacion">Sin ubicación</td>
        )}
        <td>{puesto.votingTables.length}</td>
        <td>{numero(puesto.voters)}</td>
        <td>
          <div className="acciones-padron">
            {!editando && (
              <button className="btn btn-outline" onClick={onEditar} disabled={!ubicador}>
                {u ? 'Cambiar ubicación' : 'Poner ubicación'}
              </button>
            )}
            {u && puesto.voters === 0 && <button className="btn btn-danger-outline" onClick={onQuitar}>Quitar</button>}
          </div>
        </td>
      </tr>
      {editando && (
        <tr className="fila-edicion">
          <td colSpan={8}>
            <form onSubmit={onGuardar} aria-label={`Ubicación de ${puesto.pollingPlace}`}>
              <UbicacionCampos ubicador={ubicador} valor={editando.valor} onChange={onCambio} idBase="ubicacion-puesto" />
              {u && puesto.voters > 0 && (
                <p className="field-hint-dark">
                  Cambiar la ubicación no cambia a los votantes ni los votos del puesto: solo dice dónde queda.
                </p>
              )}
              <div className="acciones-padron">
                <button className="btn btn-gold" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar ubicación'}</button>
                <button type="button" className="btn btn-outline" onClick={onCancelar}>Cancelar</button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

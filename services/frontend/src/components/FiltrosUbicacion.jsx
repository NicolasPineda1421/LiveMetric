// Filtros por la ubicación del puesto: país, departamento, municipio,
// localidad y zona. Las listas salen de los puestos que hay (ver
// opcionesDeUbicacion), y elegir un departamento deja solo sus municipios.
// onChange recibe solo lo que cambia (y lo que deja de valer: otro
// departamento borra el municipio y la localidad elegidos).
import { opcionesDeUbicacion, SIN_UBICACION } from '../utils/ubicacion.js';

export default function FiltrosUbicacion({ puestos, valor, onChange, idBase }) {
  const opciones = opcionesDeUbicacion(puestos, valor);
  const sinUbicacion = valor.pais === SIN_UBICACION;
  const campo = (id, etiqueta, contenido) => (
    <div className="field-dark">
      <label htmlFor={`${idBase}-${id}`}>{etiqueta}</label>
      {contenido}
    </div>
  );
  return (
    <>
      {campo('pais', 'País', (
        <select
          id={`${idBase}-pais`}
          value={valor.pais}
          onChange={(e) => onChange({ pais: e.target.value, departamento: '', municipio: '', localidad: '', zona: e.target.value === SIN_UBICACION ? '' : valor.zona })}
        >
          <option value="">Todos</option>
          {opciones.paises.map((p) => <option key={p} value={p}>{p}</option>)}
          {opciones.hayPuestosSinUbicacion && <option value={SIN_UBICACION}>Sin ubicación</option>}
        </select>
      ))}
      {campo('departamento', 'Departamento', (
        <select
          id={`${idBase}-departamento`}
          value={valor.departamento}
          disabled={sinUbicacion}
          onChange={(e) => onChange({ departamento: e.target.value, municipio: '', localidad: '' })}
        >
          <option value="">Todos</option>
          {opciones.departamentos.map((d) => <option key={d.codigo} value={d.codigo}>{d.nombre}</option>)}
        </select>
      ))}
      {campo('municipio', 'Municipio', (
        <select
          id={`${idBase}-municipio`}
          value={valor.municipio}
          disabled={sinUbicacion}
          onChange={(e) => onChange({ municipio: e.target.value, localidad: '' })}
        >
          <option value="">Todos</option>
          {opciones.municipios.map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}
        </select>
      ))}
      {campo('localidad', 'Localidad', (
        <select
          id={`${idBase}-localidad`}
          value={valor.localidad}
          disabled={sinUbicacion || opciones.localidades.length === 0}
          onChange={(e) => onChange({ localidad: e.target.value })}
        >
          <option value="">Todas</option>
          {opciones.localidades.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      ))}
      {campo('zona', 'Zona', (
        <select id={`${idBase}-zona`} value={valor.zona} disabled={sinUbicacion} onChange={(e) => onChange({ zona: e.target.value })}>
          <option value="">Todas</option>
          <option value="urbana">Urbana</option>
          <option value="rural">Rural</option>
        </select>
      ))}
    </>
  );
}

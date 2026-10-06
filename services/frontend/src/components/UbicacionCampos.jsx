// Departamento, municipio, localidad y zona de un puesto de votación, de las
// listas del DANE (ver utils/ubicacion.js). "valor" lleva los códigos:
// { departamento: '15', municipio: '15001', localidad: '', zona: 'urbana' }.
// En Bogotá, la localidad es una de sus 20; en los demás municipios, libre.
const enOrden = (a, b) => a.nombre.localeCompare(b.nombre, 'es');

export const SIN_UBICACION = { departamento: '', municipio: '', localidad: '', zona: '' };

// De una ubicación guardada a los valores de los campos.
export const camposDeUbicacion = (u) => (u
  ? { departamento: u.codigoMunicipio.slice(0, 2), municipio: u.codigoMunicipio, localidad: u.localidad || '', zona: u.zona }
  : SIN_UBICACION);

export default function UbicacionCampos({ ubicador, valor, onChange, idBase }) {
  const municipios = valor.departamento ? ubicador.municipiosDe(valor.departamento).sort(enOrden) : [];
  const localidades = valor.municipio ? ubicador.localidadesDe(valor.municipio) : null;
  const cambiar = (campo, dato) => {
    const nuevo = { ...valor, [campo]: dato };
    // Otro departamento u otro municipio: lo que dependía de él ya no vale.
    if (campo === 'departamento') Object.assign(nuevo, { municipio: '', localidad: '' });
    if (campo === 'municipio') nuevo.localidad = '';
    onChange(nuevo);
  };
  return (
    <div className="ubicacion-campos">
      <div className="field-dark">
        <label htmlFor={`${idBase}-pais`}>País</label>
        <input id={`${idBase}-pais`} value={ubicador.pais} readOnly />
      </div>
      <div className="field-dark">
        <label htmlFor={`${idBase}-departamento`}>Departamento</label>
        <select id={`${idBase}-departamento`} value={valor.departamento} onChange={(e) => cambiar('departamento', e.target.value)} required>
          <option value="">Elige…</option>
          {[...ubicador.departamentos].sort(enOrden).map((d) => <option key={d.codigo} value={d.codigo}>{d.nombre}</option>)}
        </select>
      </div>
      <div className="field-dark">
        <label htmlFor={`${idBase}-municipio`}>Municipio</label>
        <select
          id={`${idBase}-municipio`}
          value={valor.municipio}
          onChange={(e) => cambiar('municipio', e.target.value)}
          disabled={!valor.departamento}
          required
        >
          <option value="">{valor.departamento ? 'Elige…' : 'Primero el departamento'}</option>
          {municipios.map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}
        </select>
      </div>
      <div className="field-dark">
        <label htmlFor={`${idBase}-localidad`}>Localidad (opcional)</label>
        {localidades ? (
          <select id={`${idBase}-localidad`} value={valor.localidad} onChange={(e) => cambiar('localidad', e.target.value)}>
            <option value="">Sin localidad</option>
            {localidades.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        ) : (
          <input
            id={`${idBase}-localidad`}
            value={valor.localidad}
            onChange={(e) => cambiar('localidad', e.target.value)}
            maxLength={80}
            placeholder="Comuna, corregimiento…"
          />
        )}
      </div>
      <div className="field-dark">
        <label htmlFor={`${idBase}-zona`}>Zona</label>
        <select id={`${idBase}-zona`} value={valor.zona} onChange={(e) => cambiar('zona', e.target.value)} required>
          <option value="">Elige…</option>
          <option value="urbana">Urbana</option>
          <option value="rural">Rural</option>
        </select>
      </div>
    </div>
  );
}

// Para mandar al servicio (que acepta los códigos del DANE).
export const ubicacionDeLosCampos = (valor, pais) => ({
  pais, departamento: valor.departamento, municipio: valor.municipio, localidad: valor.localidad.trim(), zona: valor.zona,
});

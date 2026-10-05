import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Buscador del padrón con autocompletar: mientras se escribe la cédula (o el
// nombre), muestra hasta 8 votantes que coinciden. Se elige con un clic o
// con las flechas y Enter; Escape cierra la lista. Enter sin elegir busca lo
// escrito, como el botón Buscar.
//
// La consulta sale cuando se deja de escribir un momento (ESPERA_MS): una
// cédula completa son uno o dos pedidos, dentro del límite de consultas del
// panel. Una respuesta que llega tarde (de algo que ya se cambió) se ignora.
export const ESPERA_MS = 250;
const MINIMO = 2;

// Resalta la primera aparición de lo escrito (sin distinguir mayúsculas).
function Resaltado({ texto, buscado }) {
  const i = texto.toLowerCase().indexOf(buscado.toLowerCase());
  if (!buscado || i === -1) return texto;
  return (
    <>
      {texto.slice(0, i)}
      <mark>{texto.slice(i, i + buscado.length)}</mark>
      {texto.slice(i + buscado.length)}
    </>
  );
}

export default function BuscadorPadron({ token, value, onChange, onSearch }) {
  // Lo que la persona escribió: busca sugerencias solo cuando cambia esto (al
  // elegir una sugerencia, el campo cambia pero no se vuelve a buscar).
  const [consulta, setConsulta] = useState('');
  const [sugerencias, setSugerencias] = useState([]);
  const [total, setTotal] = useState(0);
  const [abierto, setAbierto] = useState(false);
  const [activo, setActivo] = useState(-1);
  const ultima = useRef(0);

  useEffect(() => {
    const q = consulta.trim();
    const pedido = ++ultima.current;
    if (q.length < MINIMO) {
      setSugerencias([]);
      setAbierto(false);
      return undefined;
    }
    const espera = setTimeout(() => {
      api.suggestVoters(token, q)
        .then((d) => {
          if (ultima.current !== pedido) return;
          setSugerencias(d.suggestions || []);
          setTotal(d.total ?? (d.suggestions || []).length);
          setActivo(-1);
          setAbierto(true);
        })
        .catch(() => {});
    }, ESPERA_MS);
    return () => clearTimeout(espera);
  }, [consulta, token]);

  function elegir(votante) {
    ultima.current += 1; // descarta una respuesta que esté en camino
    onChange(votante.cedula);
    onSearch(votante.cedula);
    setAbierto(false);
  }

  function teclado(e) {
    if (e.key === 'Escape') {
      setAbierto(false);
      return;
    }
    if (!abierto || sugerencias.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActivo((i) => (i + 1) % sugerencias.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActivo((i) => (i <= 0 ? sugerencias.length - 1 : i - 1));
    } else if (e.key === 'Enter' && activo >= 0) {
      e.preventDefault();
      elegir(sugerencias[activo]); // eslint-disable-line security/detect-object-injection -- activo es un índice numérico dentro de sugerencias
    }
  }

  const buscado = consulta.trim();
  return (
    <div className="autocompletar">
      <input
        id="filtro-busqueda"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={abierto}
        aria-controls="sugerencias-padron"
        aria-activedescendant={abierto && activo >= 0 ? `sugerencia-${activo}` : undefined}
        autoComplete="off"
        value={value}
        maxLength={50}
        placeholder="Cédula o nombre"
        onChange={(e) => {
          onChange(e.target.value);
          setConsulta(e.target.value);
        }}
        onKeyDown={teclado}
        onFocus={() => { if (sugerencias.length > 0 && value.trim() === buscado) setAbierto(true); }}
        onBlur={() => setAbierto(false)}
      />
      {abierto && (
        <ul id="sugerencias-padron" role="listbox" className="sugerencias" aria-label="Votantes que coinciden">
          {sugerencias.length === 0 ? (
            <li className="sin-sugerencias">Ningún votante coincide con «{buscado}».</li>
          ) : (
            sugerencias.map((v, i) => (
              <li
                key={v.id}
                id={`sugerencia-${i}`}
                role="option"
                aria-selected={i === activo}
                className={i === activo ? 'activa' : ''}
                // mousedown (no click): se elige antes de que el campo pierda el foco y cierre la lista.
                onMouseDown={(e) => { e.preventDefault(); elegir(v); }}
                onMouseEnter={() => setActivo(i)}
              >
                <span className="mono"><Resaltado texto={v.cedula} buscado={buscado} /></span>
                <span className="sugerencia-nombre"><Resaltado texto={v.fullName} buscado={buscado} /></span>
                <span className="sugerencia-lugar">{v.pollingPlace} — {v.votingTable}</span>
              </li>
            ))
          )}
          {total > sugerencias.length && (
            <li className="sin-sugerencias">Y {total - sugerencias.length} más: sigue escribiendo para acotar.</li>
          )}
        </ul>
      )}
    </div>
  );
}

// Carga masiva del padrón: un archivo CSV (de Excel, Google Sheets o
// LibreOffice) o las celdas copiadas de una hoja de cálculo. Primero muestra
// cómo quedó cada fila y cuáles tienen errores; recién al confirmar manda
// los votantes al servicio, en lotes, con el avance en pantalla. Los PIN
// generados se los pasa a la pestaña a medida que llegan (onPines), que los
// muestra y permite descargarlos; onCambio, al terminar, recarga el padrón.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  MAXIMO_BYTES, SEGUNDOS_POR_VOTANTE, TAMANO_LOTE, contarPorPuesto, decodificarTexto, enLotes, interpretarPadron,
  nombreSeparador, plantillaCsv,
} from '../utils/padronArchivo.js';
import { descargarTexto } from '../utils/descargar.js';

const FILAS_MOSTRADAS = 100;
// Si el servicio responde 429 (límite de operaciones del panel), se espera
// a que se renueve el cupo y se reintenta el mismo lote, hasta 5 veces.
const REINTENTOS = 5;

const esperar = (ms) => new Promise((resolver) => { setTimeout(resolver, ms); });
const numero = (n) => n.toLocaleString('es-CO');
const plural = (n, uno, varios) => `${numero(n)} ${n === 1 ? uno : varios}`;
const estimado = (segundos) => (segundos < 60 ? 'menos de un minuto' : `unos ${Math.round(segundos / 60)} minutos`);
function faltan(segundos) {
  if (segundos < 60) return 'Falta menos de un minuto.';
  const minutos = Math.round(segundos / 60);
  return minutos === 1 ? 'Falta un minuto.' : `Faltan unos ${minutos} minutos.`;
}

const leerBytes = (archivo) => new Promise((resolver, rechazar) => {
  const lector = new FileReader();
  lector.onload = () => resolver(new Uint8Array(lector.result));
  lector.onerror = () => rechazar(lector.error);
  lector.readAsArrayBuffer(archivo);
});

class CargaDetenida extends Error {}

export default function CargaPadron({ token, pinExpiresAt, campoVencimiento, onPines, onCambio, onCargaEnCurso }) {
  const [paso, setPaso] = useState('elegir'); // elegir | revisar | cargando | listo
  const [texto, setTexto] = useState('');
  const [origen, setOrigen] = useState('');
  const [revision, setRevision] = useState(null);
  const [error, setError] = useState('');
  const [arrastrando, setArrastrando] = useState(false);
  const [avance, setAvance] = useState({ hechos: 0, total: 0, espera: 0, inicio: 0 });
  const [deteniendo, setDeteniendo] = useState(false);
  const [resultado, setResultado] = useState(null);
  const detener = useRef(false);

  // Si el panel se cierra (otra pestaña, salir), la carga se detiene
  // después del lote en curso.
  useEffect(() => () => {
    detener.current = true;
    onCargaEnCurso?.(false);
  }, []);
  useEffect(() => {
    onCargaEnCurso?.(paso === 'cargando');
  }, [paso]);

  // Mientras carga, el navegador pregunta antes de cerrar o recargar la pestaña.
  useEffect(() => {
    if (paso !== 'cargando') return undefined;
    const avisar = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, [paso]);

  function revisar(contenido, deDonde) {
    setError('');
    const r = interpretarPadron(contenido);
    if (r.error) {
      setError(r.error);
      return;
    }
    setOrigen(deDonde);
    setRevision(r);
    setPaso('revisar');
  }

  async function leerArchivo(archivo) {
    if (!archivo) return;
    setError('');
    if (/\.(xlsx|xls|ods)$/i.test(archivo.name)) {
      setError('Ese es un libro de Excel o de LibreOffice: guárdalo como CSV («Guardar como» → «CSV UTF-8»), o copia sus celdas y pégalas abajo.');
      return;
    }
    if (archivo.size > MAXIMO_BYTES) {
      setError(`El archivo pesa más de ${MAXIMO_BYTES / 1024 / 1024} MB: divídelo en partes y cárgalas una tras otra.`);
      return;
    }
    try {
      revisar(decodificarTexto(await leerBytes(archivo)), archivo.name);
    } catch {
      setError('No se pudo leer el archivo.');
    }
  }

  function reiniciar() {
    setPaso('elegir');
    setRevision(null);
    setResultado(null);
    setError('');
  }

  async function enviarLote(votantes, vence) {
    for (let intento = 1; ; intento += 1) {
      try {
        return await api.addVoters(token, votantes, vence, 'archivo');
      } catch (err) {
        if (err.status !== 429 || intento > REINTENTOS) throw err;
        for (let s = err.retryAfter || 60; s > 0; s -= 1) {
          if (detener.current) throw new CargaDetenida();
          setAvance((a) => ({ ...a, espera: s }));
          await esperar(1000);
        }
        setAvance((a) => ({ ...a, espera: 0 }));
      }
    }
  }

  async function cargar() {
    const { votantes } = revision;
    detener.current = false;
    setDeteniendo(false);
    setAvance({ hechos: 0, total: votantes.length, espera: 0, inicio: Date.now() });
    setPaso('cargando');
    const pines = [];
    const yaEstaban = [];
    let vence = pinExpiresAt();
    let hechos = 0;
    let fallo = null;
    for (const lote of enLotes(votantes, TAMANO_LOTE)) {
      if (detener.current) break;
      try {
        const respuesta = await enviarLote(
          lote.map(({ cedula, fullName, pollingPlace, votingTable, assisted }) => ({ cedula, fullName, pollingPlace, votingTable, assisted })),
          vence,
        );
        // Todos los lotes vencen igual: en la fecha que usó el primero.
        vence = respuesta.pinExpiresAt || vence;
        pines.push(...(respuesta.accessCodes || []));
        yaEstaban.push(...(respuesta.duplicates || []));
        hechos += lote.length;
        setAvance((a) => ({ ...a, hechos }));
        onPines([...pines], vence);
      } catch (err) {
        if (!(err instanceof CargaDetenida)) fallo = { fila: lote[0].fila, mensaje: err.message };
        break;
      }
    }
    setResultado({
      agregados: pines.length,
      yaEstaban,
      fallo,
      sinCargar: fallo ? 0 : votantes.length - hechos,
      conErrores: revision.errores.length,
    });
    setPaso('listo');
    onCambio();
  }

  if (paso === 'cargando') {
    const { hechos, total, espera, inicio } = avance;
    const restante = hechos > 0 ? faltan(((Date.now() - inicio) / 1000 / hechos) * (total - hechos)) : '';
    return (
      <div className="carga-padron">
        <div className="avance-carga" role="status">
          <progress max={total} value={hechos} aria-label="Avance de la carga" />
          <p>
            Cargando: {numero(hechos)} de {plural(total, 'votante', 'votantes')}.{' '}
            {espera > 0 ? `Pausa por el límite de operaciones del panel: sigue en ${espera} s.` : restante}
          </p>
        </div>
        <p className="field-hint-dark">
          No cierres esta pestaña hasta que termine. Los PIN aparecen abajo a medida que se generan. Cada lote de{' '}
          {TAMANO_LOTE} se guarda completo: si la carga se corta, vuelve a cargar el mismo archivo; los que ya estén se
          informan como repetidos y no se modifican.
        </p>
        <button
          type="button"
          className="btn btn-outline"
          disabled={deteniendo}
          onClick={() => {
            detener.current = true;
            setDeteniendo(true);
          }}
        >
          {deteniendo ? 'Deteniendo…' : 'Detener después de este lote'}
        </button>
      </div>
    );
  }

  if (paso === 'listo') {
    const { agregados, yaEstaban, fallo, sinCargar, conErrores } = resultado;
    const partes = [
      agregados === 0 ? 'No se agregó ningún votante.' : `Se ${agregados === 1 ? 'agregó 1 votante' : `agregaron ${numero(agregados)} votantes`} al padrón.`,
      yaEstaban.length > 0 && `${plural(yaEstaban.length, 'ya estaba y no se modificó', 'ya estaban y no se modificaron')}.`,
      sinCargar > 0 && `Carga detenida: ${plural(sinCargar, 'quedó sin cargar', 'quedaron sin cargar')}.`,
      conErrores > 0 && `${plural(conErrores, 'fila con errores no se cargó', 'filas con errores no se cargaron')}.`,
    ];
    return (
      <div className="carga-padron">
        {fallo && (
          <div className="error-banner">
            La carga se detuvo en el lote que empieza en la fila {fallo.fila}: {fallo.mensaje} Los lotes anteriores
            quedaron cargados. Para seguir, vuelve a cargar el mismo archivo: los que ya están se informan como repetidos.
          </div>
        )}
        <div className="success-banner">{partes.filter(Boolean).join(' ')}</div>
        {yaEstaban.length > 0 && (
          <details className="detalle-carga">
            <summary>Cédulas que ya estaban en el padrón</summary>
            <p className="mono lista-cedulas">
              {yaEstaban.slice(0, FILAS_MOSTRADAS).join(', ')}
              {yaEstaban.length > FILAS_MOSTRADAS && ` y ${numero(yaEstaban.length - FILAS_MOSTRADAS)} más`}
            </p>
          </details>
        )}
        <button type="button" className="btn btn-outline" onClick={reiniciar}>Cargar otro archivo</button>
      </div>
    );
  }

  if (paso === 'revisar') {
    const { votantes, errores, repetidas, encabezados, ignoradas, separador } = revision;
    const asistidos = votantes.filter((v) => v.assisted).length;
    const puestos = contarPorPuesto(votantes);
    return (
      <div className="carga-padron">
        <p className="carga-origen">
          <strong>{origen}</strong> · separador: {nombreSeparador(separador)} ·{' '}
          {encabezados ? `columnas: ${encabezados.join(', ')}` : 'sin encabezados: cédula, nombre, puesto, mesa y voto asistido'}
          {ignoradas.length > 0 && ` · no se usan: ${ignoradas.join(', ')}`}
        </p>
        <ul className="conteo-carga">
          <li className="conteo-ok">
            <strong>{plural(votantes.length, 'votante listo', 'votantes listos')}</strong> para cargar
            {asistidos > 0 && `, ${numero(asistidos)} con voto asistido`}
          </li>
          {errores.length > 0 && (
            <li className="conteo-mal">{plural(errores.length, 'fila tiene errores', 'filas tienen errores')}: no se cargan</li>
          )}
          {repetidas.length > 0 && (
            <li>{plural(repetidas.length, 'cédula repetida', 'cédulas repetidas')} en el archivo: se carga solo la primera vez que aparece</li>
          )}
          {puestos.length > 0 && (
            <li>
              {plural(puestos.length, 'puesto', 'puestos')}: {puestos.slice(0, 6).map((p) => `${p.puesto} (${numero(p.votantes)})`).join(', ')}
              {puestos.length > 6 && ', …'}
            </li>
          )}
        </ul>

        {errores.length > 0 && (
          <details className="detalle-carga" open>
            <summary>Filas con errores</summary>
            <div className="tabla-desplazable">
              <table className="table">
                <thead><tr><th>Fila</th><th>Cédula</th><th>Qué corregir</th></tr></thead>
                <tbody>
                  {errores.slice(0, FILAS_MOSTRADAS).map((e) => (
                    <tr key={e.fila}><td>{e.fila}</td><td className="mono">{e.cedula}</td><td>{e.motivos.join('; ')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {errores.length > FILAS_MOSTRADAS && <p className="field-hint-dark">Y {numero(errores.length - FILAS_MOSTRADAS)} más.</p>}
          </details>
        )}
        {repetidas.length > 0 && (
          <details className="detalle-carga">
            <summary>Cédulas repetidas en el archivo</summary>
            <div className="tabla-desplazable">
              <table className="table">
                <thead><tr><th>Fila</th><th>Cédula</th><th>Ya estaba en la fila</th></tr></thead>
                <tbody>
                  {repetidas.slice(0, FILAS_MOSTRADAS).map((r) => (
                    <tr key={r.fila}><td>{r.fila}</td><td className="mono">{r.cedula}</td><td>{r.primera}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {votantes.length > 0 && (
          <>
            <h4 className="subtitulo-carga">Así se van a cargar{votantes.length > 5 ? ' (los primeros 5)' : ''}</h4>
            <div className="tabla-desplazable">
              <table className="table">
                <thead><tr><th>Fila</th><th>Cédula</th><th>Nombre</th><th>Puesto</th><th>Mesa</th><th>Voto asistido</th></tr></thead>
                <tbody>
                  {votantes.slice(0, 5).map((v) => (
                    <tr key={v.fila}>
                      <td>{v.fila}</td><td className="mono">{v.cedula}</td><td>{v.fullName}</td>
                      <td>{v.pollingPlace}</td><td>{v.votingTable}</td><td>{v.assisted ? 'Sí' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {campoVencimiento}
            <p className="field-hint-dark">
              Las cédulas que ya estén en el padrón no se modifican: al final se dice cuáles eran. Un puesto o una mesa
              escritos de otra forma («colegio andino», «2» por «Mesa 2») quedan como ya figuran. A cada votante nuevo se
              le genera su PIN, y eso toma un momento: {estimado(votantes.length * SEGUNDOS_POR_VOTANTE)} en total.
            </p>
          </>
        )}
        <div className="acciones-carga">
          {votantes.length > 0 && (
            <button type="button" className="btn btn-gold" onClick={cargar}>
              Cargar {plural(votantes.length, 'votante', 'votantes')} al padrón
            </button>
          )}
          <button type="button" className="btn btn-outline" onClick={reiniciar}>
            {votantes.length > 0 ? 'Cancelar' : 'Elegir otro archivo'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="carga-padron">
      {error && <div className="error-banner">{error}</div>}
      <p className="field-hint-dark carga-ayuda">
        Columnas: <strong>cédula, nombre completo, puesto y mesa</strong> y, si quieres, <strong>voto asistido</strong>{' '}
        (sí o no). El nombre puede venir en dos columnas, nombres y apellidos. Con encabezados en la primera fila, en
        cualquier orden; sin encabezados, en ese orden. Antes de cargar nada se muestra cómo quedó cada fila.
      </p>
      <div className="carga-opciones">
        <label
          className={`zona-archivo${arrastrando ? ' arrastrando' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setArrastrando(true);
          }}
          onDragLeave={() => setArrastrando(false)}
          onDrop={(e) => {
            e.preventDefault();
            setArrastrando(false);
            leerArchivo(e.dataTransfer.files[0]);
          }}
        >
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={(e) => {
              leerArchivo(e.target.files[0]);
              e.target.value = '';
            }}
          />
          <span className="zona-titulo">Elegir un archivo CSV</span>
          <span className="field-hint-dark">
            o arrastrarlo aquí. De Excel: «Guardar como» → «CSV UTF-8». De Google Sheets: «Archivo» → «Descargar» → CSV.
          </span>
        </label>
        <div className="field-dark pegar-celdas">
          <label htmlFor="pegar-padron">O pegar las celdas copiadas de la hoja de cálculo</label>
          <textarea
            id="pegar-padron"
            rows={5}
            value={texto}
            spellCheck={false}
            placeholder="Selecciona las celdas en Excel, Google Sheets o LibreOffice, cópialas (Ctrl+C) y pégalas aquí (Ctrl+V)"
            onChange={(e) => setTexto(e.target.value)}
          />
          <button type="button" className="btn btn-outline" disabled={!texto.trim()} onClick={() => revisar(texto, 'Las celdas pegadas')}>
            Revisar
          </button>
        </div>
      </div>
      <button type="button" className="link-button" onClick={() => descargarTexto('plantilla-padron.csv', plantillaCsv())}>
        Descargar la plantilla (CSV)
      </button>
    </div>
  );
}

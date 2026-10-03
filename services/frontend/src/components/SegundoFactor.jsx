import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

// Segundo paso del ingreso, después del PIN (votante) o de la contraseña
// (jurado). "paso" es lo que devolvió el primero:
//   next: 'registro' -> primer ingreso: escanear el QR y confirmar con un código
//   next: 'codigo'   -> el código de 6 dígitos de su app
//   next: 'jurado'   -> votante asistido: lo autoriza el jurado de su mesa
// Pensado también para quien usa poco el celular: un paso por vez, con letra
// grande, y la clave escrita por si no puede escanear el QR.

// La clave en grupos de 4: más fácil de copiar a mano.
const enGrupos = (clave) => clave.match(/.{1,4}/g).join(' ');

function CampoCodigo({ id, label, value, onChange, autoFocus = false }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input-codigo"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        placeholder="000000"
        required
        autoFocus={autoFocus}
      />
    </div>
  );
}

function Volver({ onVolver }) {
  return (
    <button type="button" className="link-button volver" onClick={onVolver}>
      Volver
    </button>
  );
}

export default function SegundoFactor({ paso, loading, onCodigo, onJurado, onVolver }) {
  const [codigo, setCodigo] = useState('');
  const [juradoUsuario, setJuradoUsuario] = useState('');
  const [juradoCodigo, setJuradoCodigo] = useState('');
  const esJurado = paso.quien === 'jurado';

  if (paso.next === 'jurado') {
    return (
      <form className="segundo-factor" onSubmit={(e) => { e.preventDefault(); onJurado(juradoUsuario, juradoCodigo); }}>
        <h2 className="segundo-factor-titulo">Voto asistido</h2>
        <p className="segundo-factor-texto">
          Llama al <strong>jurado de tu mesa</strong>: revisa tu cédula y autoriza tu ingreso con el código de su
          celular. Después se aparta y votas en privado; el jurado no ve tu voto.
        </p>
        <div className="field">
          <label htmlFor="jurado-usuario">Usuario del jurado</label>
          <input id="jurado-usuario" value={juradoUsuario} onChange={(e) => setJuradoUsuario(e.target.value)} autoComplete="off" required autoFocus />
        </div>
        <CampoCodigo id="jurado-codigo" label="Código del autenticador del jurado" value={juradoCodigo} onChange={setJuradoCodigo} />
        <button className="btn btn-primary" disabled={loading || juradoCodigo.length !== 6}>
          {loading ? 'Verificando…' : 'Autorizar el ingreso'}
        </button>
        <Volver onVolver={onVolver} />
      </form>
    );
  }

  const enviar = (e) => {
    e.preventDefault();
    onCodigo(codigo);
  };

  if (paso.next === 'registro') {
    return (
      <form className="segundo-factor" onSubmit={enviar}>
        <h2 className="segundo-factor-titulo">Primer ingreso: registra tu autenticador</h2>
        <p className="segundo-factor-texto">
          {esJurado
            ? 'Como jurado, autorizas los votos asistidos con un código de tu celular.'
            : 'Desde ahora, además de tu PIN, entrarás con un código de tu celular.'}{' '}
          Esto se hace una sola vez.
        </p>
        <ol className="pasos-registro">
          <li>Instala <strong>Microsoft Authenticator</strong> o <strong>Google Authenticator</strong> en tu celular. Son gratis.</li>
          <li>En la app, toca <strong>+</strong> (agregar cuenta), elige <strong>Otra cuenta</strong> y <strong>escanea este código</strong>:</li>
        </ol>
        <div className="qr-registro">
          <QRCodeSVG value={paso.otpauthUri} size={184} marginSize={2} title="Código QR para el autenticador" />
        </div>
        <details className="clave-manual">
          <summary>¿No puedes escanear? Escribe esta clave en la app</summary>
          <div className="mono">{enGrupos(paso.secret)}</div>
        </details>
        <ol className="pasos-registro" start={3}>
          <li>Escribe el <strong>código de 6 dígitos</strong> que muestra la app para LiveMetric:</li>
        </ol>
        <CampoCodigo id="codigo-registro" label="Código de la app" value={codigo} onChange={setCodigo} />
        <button className="btn btn-primary" disabled={loading || codigo.length !== 6}>
          {loading ? 'Verificando…' : 'Confirmar y entrar'}
        </button>
        <p className="field-hint">
          Consejo: Microsoft Authenticator puede pedir tu huella o tu rostro para abrirse (Configuración → Bloqueo de
          aplicación).
        </p>
        <Volver onVolver={onVolver} />
      </form>
    );
  }

  return (
    <form className="segundo-factor" onSubmit={enviar}>
      <h2 className="segundo-factor-titulo">Código de tu autenticador</h2>
      <p className="segundo-factor-texto">
        Abre Microsoft Authenticator (o la app que usaste al registrarte) y escribe los 6 dígitos de LiveMetric.
        Cambian cada 30 segundos.
      </p>
      <CampoCodigo id="codigo-2fa" label="Código de la app" value={codigo} onChange={setCodigo} autoFocus />
      <button className="btn btn-primary" disabled={loading || codigo.length !== 6}>
        {loading ? 'Verificando…' : 'Entrar'}
      </button>
      <p className="field-hint">
        {esJurado
          ? '¿Cambiaste o perdiste el celular? El administrador puede restablecer tu autenticador.'
          : '¿Cambiaste o perdiste el celular? Avisa al encargado de tu puesto: puede restablecer tu autenticador.'}
      </p>
      <Volver onVolver={onVolver} />
    </form>
  );
}

// Guía paso a paso para entrar con el autenticador, con Microsoft
// Authenticator o con Google Authenticator: un enlace que abre una ventana
// con una pestaña por app, cada paso con su ilustración. Está en el ingreso
// de votantes y en el del personal (para = 'votante' | 'personal'), y en las
// pantallas del segundo factor, donde se usa.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ILUSTRACIONES } from './IlustracionesAutenticador.jsx';

const APPS = [
  { id: 'microsoft', nombre: 'Microsoft Authenticator' },
  { id: 'google', nombre: 'Google Authenticator' },
];

const ROLES = {
  votante: {
    intro: 'La primera vez que entras, después de tu cédula y tu PIN, LiveMetric te muestra un código QR para registrar una app '
      + 'autenticadora en tu celular. Desde ahí, cada vez que entres te pide el código de 6 dígitos que muestra esa app. Sirve '
      + 'Microsoft Authenticator o Google Authenticator: elige la que prefieras.',
    primeraVez: 'en tu primer ingreso, después de tu cédula y tu PIN',
    despues: 'Después de tu cédula y tu PIN',
    recuperar: 'Avisa al encargado de tu puesto de votación: puede restablecer tu autenticador para que lo registres de nuevo.',
  },
  personal: {
    intro: 'El autenticador lo usa el jurado: el administrador y el auditor entran solo con su usuario y su contraseña. La primera '
      + 'vez que entras como jurado, después de tu usuario y tu contraseña, LiveMetric te muestra un código QR para registrar una '
      + 'app autenticadora en tu celular. Desde ahí la usas para entrar y para autorizar los votos asistidos. Sirve Microsoft '
      + 'Authenticator o Google Authenticator.',
    primeraVez: 'en tu primer ingreso como jurado, después de tu usuario y tu contraseña',
    despues: 'Después de tu usuario y tu contraseña',
    recuperar: 'Pide al administrador que restablezca tu autenticador, para registrarlo de nuevo.',
  },
};

// Los pasos de cada app. "ilus" es la ilustración (IlustracionesAutenticador.jsx).
function pasos(app, rol) {
  const comunes = [
    {
      ilus: 'pantalla-registro',
      titulo: 'Escríbelo en LiveMetric',
      texto: <>Escribe esos 6 dígitos en <strong>Código de la app</strong> y toca <strong>Confirmar y entrar</strong>. Listo: tu autenticador quedó registrado.</>,
    },
    {
      ilus: 'pantalla-ingreso',
      titulo: 'Las próximas veces',
      texto: <>{rol.despues}, LiveMetric te pide el código: abre la app, mira el de <strong>LiveMetric</strong>, escríbelo y toca <strong>Entrar</strong>.</>,
    },
  ];
  if (app === 'microsoft') {
    return [
      {
        ilus: 'tienda-microsoft',
        titulo: 'Instala la app',
        texto: <>En tu celular, abre <strong>Play Store</strong> (Android) o <strong>App Store</strong> (iPhone), busca <strong>Microsoft Authenticator</strong> e instálala. Es gratis.</>,
      },
      {
        ilus: 'inicio-microsoft',
        titulo: 'Agrega una cuenta',
        texto: <>Abre la app y toca <strong>+</strong>, arriba a la derecha. Si te muestra avisos de bienvenida o de privacidad, acéptalos: no hace falta iniciar sesión con una cuenta de Microsoft.</>,
      },
      {
        ilus: 'tipo-microsoft',
        titulo: 'Elige «Otra cuenta»',
        texto: <>Toca <strong>Otra cuenta (Google, Facebook, etc.)</strong>. No elijas «Cuenta personal» ni «Cuenta profesional o educativa»: esas son para cuentas de Microsoft.</>,
      },
      {
        ilus: 'escanear',
        titulo: 'Escanea el código QR',
        texto: <>Si la app pide usar la cámara, permítelo. Apunta al código QR que te muestra LiveMetric {rol.primeraVez}. Si la cámara no funciona, toca <strong>O escribir el código manualmente</strong>: en «Nombre de cuenta» pon <strong>LiveMetric</strong> y en «Clave secreta», la clave que LiveMetric muestra en «¿No puedes escanear?».</>,
      },
      {
        ilus: 'codigo-microsoft',
        titulo: 'Mira el código',
        texto: <>Aparece la cuenta <strong>LiveMetric</strong> con un código de 6 dígitos (si no lo ves, toca la cuenta). Cambia cada 30 segundos: si está por cambiar, espera el siguiente.</>,
      },
      ...comunes,
    ];
  }
  return [
    {
      ilus: 'tienda-google',
      titulo: 'Instala la app',
      texto: <>En tu celular, abre <strong>Play Store</strong> (Android) o <strong>App Store</strong> (iPhone), busca <strong>Google Authenticator</strong> e instálala. Es gratis.</>,
    },
    {
      ilus: 'inicio-google',
      titulo: 'Agrega un código',
      texto: <>Abre la app. La primera vez toca <strong>Comenzar</strong>; si te ofrece guardar tus códigos en tu cuenta de Google, puedes aceptar o usarla sin cuenta. Después toca <strong>+</strong>, abajo a la derecha.</>,
    },
    {
      ilus: 'tipo-google',
      titulo: 'Elige «Escanear un código QR»',
      texto: <>Toca <strong>Escanear un código QR</strong>.</>,
    },
    {
      ilus: 'escanear',
      titulo: 'Escanea el código QR',
      texto: <>Si la app pide usar la cámara, permítelo. Apunta al código QR que te muestra LiveMetric {rol.primeraVez}. Si la cámara no funciona, vuelve atrás y toca <strong>Ingresar una clave de configuración</strong>: en «Cuenta» pon <strong>LiveMetric</strong>, en «Clave», la clave que LiveMetric muestra en «¿No puedes escanear?», deja <strong>Basada en el tiempo</strong> y toca <strong>Agregar</strong>.</>,
    },
    {
      ilus: 'codigo-google',
      titulo: 'Mira el código',
      texto: <>Aparece <strong>LiveMetric</strong> con un código de 6 dígitos. El círculo de al lado muestra cuánto le queda: si está por terminar, espera el siguiente.</>,
    },
    ...comunes,
  ];
}

const ENFOCABLES = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function DialogoGuia({ para, onCerrar }) {
  const [app, setApp] = useState('microsoft');
  const dialogo = useRef(null);
  const rol = ROLES[para] || ROLES.votante; // eslint-disable-line security/detect-object-injection -- para es una de las dos claves fijas de ROLES

  useEffect(() => {
    // Mientras está abierta: la página de atrás no se desplaza, el foco
    // arranca en "Cerrar" y no sale de la ventana; Escape la cierra.
    const desplazamiento = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogo.current?.querySelector('.guia-cerrar')?.focus();
    const alTeclear = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCerrar();
        return;
      }
      if (e.key !== 'Tab' || !dialogo.current) return;
      // Sin los que se saltan con Tab (la pestaña inactiva tiene tabindex -1).
      const enfocables = [...dialogo.current.querySelectorAll(ENFOCABLES)].filter((el) => el.getAttribute('tabindex') !== '-1');
      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };
    document.addEventListener('keydown', alTeclear);
    return () => {
      document.body.style.overflow = desplazamiento;
      document.removeEventListener('keydown', alTeclear);
    };
  }, []);

  // Las flechas cambian de pestaña, como en cualquier lista de pestañas.
  function alTeclearPestana(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const otra = APPS[(APPS.findIndex((a) => a.id === app) + 1) % APPS.length].id;
    setApp(otra);
    dialogo.current?.querySelector(`#guia-pestana-${otra}`)?.focus();
  }

  return createPortal(
    <div className="guia-fondo" onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className="guia-dialogo" role="dialog" aria-modal="true" aria-labelledby="guia-titulo" ref={dialogo}>
        <div className="guia-encabezado">
          <h2 id="guia-titulo">Cómo entrar con el autenticador</h2>
          <button type="button" className="btn btn-outline guia-cerrar" onClick={onCerrar}>Cerrar</button>
        </div>
        <p className="guia-intro">{rol.intro}</p>

        <div className="guia-pestanas" role="tablist" aria-label="App autenticadora">
          {APPS.map((a) => (
            <button
              key={a.id}
              id={`guia-pestana-${a.id}`}
              type="button"
              role="tab"
              aria-selected={app === a.id}
              aria-controls="guia-panel"
              tabIndex={app === a.id ? 0 : -1}
              className={`guia-pestana${app === a.id ? ' activa' : ''}`}
              onClick={() => setApp(a.id)}
              onKeyDown={alTeclearPestana}
            >
              {a.nombre}
            </button>
          ))}
        </div>

        <div id="guia-panel" role="tabpanel" aria-labelledby={`guia-pestana-${app}`}>
          <ol className="guia-pasos">
            {pasos(app, rol).map((paso, i) => {
              const Ilustracion = ILUSTRACIONES[paso.ilus];
              return (
                <li key={paso.titulo} className="guia-paso">
                  <div className="guia-figura"><Ilustracion /></div>
                  <div>
                    <h3 className="guia-paso-titulo"><span className="guia-numero">{i + 1}</span>{paso.titulo}</h3>
                    <p className="guia-paso-texto">{paso.texto}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="guia-ayuda">
          <h3>¿El código no funciona?</h3>
          <ul>
            <li>Escribe el código que se ve en ese momento: cada uno sirve 30 segundos y una sola vez.</li>
            <li>La hora del celular tiene que estar en automático (<strong>Ajustes → Fecha y hora</strong>): si está adelantada o atrasada, los códigos no coinciden.</li>
            <li>¿Cambiaste o perdiste el celular? {rol.recuperar}</li>
            <li>Si tu app lo permite, protégela con tu huella o tu rostro (en Microsoft Authenticator: <strong>Configuración → Bloqueo de aplicación</strong>).</li>
          </ul>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function GuiaAutenticador({ para = 'votante' }) {
  const [abierta, setAbierta] = useState(false);
  const enlace = useRef(null);
  return (
    <>
      <button ref={enlace} type="button" className="link-button guia-enlace" onClick={() => setAbierta(true)}>
        Guía paso a paso: cómo entrar con el autenticador
      </button>
      {abierta && (
        <DialogoGuia
          para={para}
          onCerrar={() => {
            setAbierta(false);
            enlace.current?.focus();
          }}
        />
      )}
    </>
  );
}

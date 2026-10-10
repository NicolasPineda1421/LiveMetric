// Ilustraciones de la guía del autenticador (GuiaAutenticador.jsx): dibujos
// propios, simplificados, de las pantallas de cada paso. No son capturas ni
// usan los logos de Microsoft o Google: muestran dónde tocar (el recuadro
// ámbar) y qué se ve. Los colores salen de las variables del panel (ver
// .ilus-* en styles.css).

const RESALTADO = 'ilus-resaltado';

function Telefono({ etiqueta, titulo, children }) {
  return (
    <svg viewBox="0 0 160 300" role="img" aria-label={etiqueta} className="ilus ilus-telefono">
      <rect x="4" y="4" width="152" height="292" rx="22" className="ilus-marco" />
      <rect x="12" y="20" width="136" height="264" rx="10" className="ilus-pantalla" />
      <rect x="62" y="10" width="36" height="5" rx="2.5" className="ilus-parlante" />
      {titulo && <text x="22" y="44" className="ilus-titulo">{titulo}</text>}
      {children}
    </svg>
  );
}

// Un candado: el ícono genérico de las dos apps en estos dibujos.
function Candado({ x, y, escala = 1, className = 'ilus-trazo-claro' }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${escala})`} className={className}>
      <path d="M-6 -2 v-4 a6 6 0 0 1 12 0 v4" />
      <rect x="-8" y="-2" width="16" height="12" rx="2" />
      <circle cx="0" cy="4" r="1.5" />
    </g>
  );
}

function Mas({ cx, cy, r }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} className="ilus-boton" />
      <path d={`M${cx - r / 2.2} ${cy} h${r / 1.1} M${cx} ${cy - r / 2.2} v${r / 1.1}`} className="ilus-trazo-claro" />
    </g>
  );
}

function Tienda({ app }) {
  const [primera, segunda] = app.split(' ');
  return (
    <Telefono etiqueta={`La tienda de apps con ${app} y el botón Instalar resaltado`} titulo="Tienda de apps">
      <rect x="22" y="54" width="116" height="18" rx="9" className="ilus-campo" />
      <circle cx="33" cy="63" r="3.5" className="ilus-trazo-tenue" />
      <path d="M35.5 65.5 l3 3" className="ilus-trazo-tenue" />
      <text x="42" y="66" className="ilus-tenue">{app}</text>
      <rect x="22" y="86" width="34" height="34" rx="8" className="ilus-icono-app" />
      <Candado x={39} y={102} />
      <text x="62" y="98" className="ilus-texto ilus-negrita">{primera}</text>
      <text x="62" y="109" className="ilus-texto ilus-negrita">{segunda}</text>
      <text x="62" y="119" className="ilus-tenue">Gratis</text>
      <rect x="22" y="132" width="116" height="22" rx="11" className="ilus-boton" />
      <text x="80" y="146" textAnchor="middle" className="ilus-texto-boton">Instalar</text>
      <rect x="17" y="127" width="126" height="32" rx="16" className={RESALTADO} />
      <rect x="22" y="172" width="54" height="96" rx="6" className="ilus-relleno" />
      <rect x="84" y="172" width="54" height="96" rx="6" className="ilus-relleno" />
    </Telefono>
  );
}

function InicioMicrosoft() {
  return (
    <Telefono etiqueta="Microsoft Authenticator sin cuentas, con el botón + de arriba a la derecha resaltado" titulo="Authenticator">
      <Mas cx={132} cy={40} r={8} />
      <circle cx="132" cy="40" r="13" className={RESALTADO} />
      <Candado x={80} y={140} escala={2.2} className="ilus-trazo-tenue" />
      <text x="80" y="185" textAnchor="middle" className="ilus-tenue">Aún no hay cuentas</text>
    </Telefono>
  );
}

function InicioGoogle() {
  return (
    <Telefono etiqueta="Google Authenticator sin cuentas, con el botón + de abajo a la derecha resaltado" titulo="Authenticator">
      <Candado x={80} y={130} escala={2.2} className="ilus-trazo-tenue" />
      <text x="80" y="175" textAnchor="middle" className="ilus-tenue">Agrega tu primer código</text>
      <Mas cx={122} cy={252} r={14} />
      <circle cx="122" cy="252" r="20" className={RESALTADO} />
    </Telefono>
  );
}

function Fila({ y, lineas, resaltada = false }) {
  const alto = lineas.length > 1 ? 32 : 24;
  return (
    <g>
      <rect x="22" y={y} width="116" height={alto} rx="6" className="ilus-fila" />
      {lineas.map((linea, i) => (
        <text key={linea} x="30" y={y + 15 + i * 10} className={i === 0 ? 'ilus-texto ilus-negrita' : 'ilus-tenue'}>{linea}</text>
      ))}
      {resaltada && <rect x="17" y={y - 5} width="126" height={alto + 10} rx="9" className={RESALTADO} />}
    </g>
  );
}

function TipoMicrosoft() {
  return (
    <Telefono etiqueta="Los tipos de cuenta de Microsoft Authenticator, con «Otra cuenta» resaltada" titulo="Agregar cuenta">
      <text x="22" y="62" className="ilus-tenue">¿Qué tipo de cuenta?</text>
      <Fila y={74} lineas={['Cuenta personal']} />
      <Fila y={106} lineas={['Cuenta profesional', 'o educativa']} />
      <Fila y={150} lineas={['Otra cuenta', '(Google, Facebook, etc.)']} resaltada />
    </Telefono>
  );
}

function TipoGoogle() {
  return (
    <Telefono etiqueta="Las dos formas de agregar un código en Google Authenticator, con «Escanear un código QR» resaltada" titulo="Authenticator">
      <rect x="12" y="20" width="136" height="264" rx="10" className="ilus-velo" />
      <rect x="12" y="176" width="136" height="108" rx="12" className="ilus-hoja" />
      <rect x="66" y="183" width="28" height="3" rx="1.5" className="ilus-parlante" />
      <rect x="28" y="200" width="12" height="10" rx="2" className="ilus-trazo-tenue" />
      <circle cx="34" cy="205" r="2.5" className="ilus-trazo-tenue" />
      <text x="48" y="208" className="ilus-texto ilus-negrita">Escanear un código QR</text>
      <rect x="20" y="192" width="122" height="26" rx="8" className={RESALTADO} />
      <rect x="28" y="234" width="12" height="9" rx="2" className="ilus-trazo-tenue" />
      <text x="48" y="238" className="ilus-texto">Ingresar una clave</text>
      <text x="48" y="248" className="ilus-texto">de configuración</text>
    </Telefono>
  );
}

// Un QR inventado (no se puede escanear): tres marcas de esquina y módulos
// al azar con una semilla fija, para que el dibujo no cambie.
function modulosQr() {
  const lado = 21;
  let semilla = 7;
  const azar = () => {
    semilla = (semilla * 1103515245 + 12345) % 2147483648;
    return semilla / 2147483648;
  };
  const enMarca = (f, c) => [[0, 0], [0, 14], [14, 0]].some(([mf, mc]) => f >= mf && f < mf + 7 && c >= mc && c < mc + 7);
  const marca = (f, c) => {
    const [mf, mc] = f < 7 ? (c < 7 ? [0, 0] : [0, 14]) : [14, 0];
    const df = f - mf;
    const dc = c - mc;
    return df === 0 || df === 6 || dc === 0 || dc === 6 || (df >= 2 && df <= 4 && dc >= 2 && dc <= 4);
  };
  const oscuros = [];
  for (let f = 0; f < lado; f += 1) {
    for (let c = 0; c < lado; c += 1) {
      if (enMarca(f, c) ? marca(f, c) : azar() < 0.45) oscuros.push([f, c]);
    }
  }
  return oscuros;
}
const MODULOS_QR = modulosQr();

function Escanear() {
  const tam = 3.2;
  const x0 = 80 - (21 * tam) / 2;
  const y0 = 140 - (21 * tam) / 2;
  return (
    <Telefono etiqueta="La cámara del celular apuntando al código QR que muestra LiveMetric">
      <rect x="12" y="20" width="136" height="264" rx="10" className="ilus-camara" />
      <rect x={x0 - 6} y={y0 - 6} width={21 * tam + 12} height={21 * tam + 12} rx="3" className="ilus-qr-fondo" />
      {MODULOS_QR.map(([f, c]) => (
        <rect key={`${f}-${c}`} x={x0 + c * tam} y={y0 + f * tam} width={tam} height={tam} className="ilus-qr" />
      ))}
      <path d="M36 96 v-12 h12 M112 84 h12 v12 M124 184 v12 h-12 M48 196 h-12 v-12" className="ilus-esquina" />
      <text x="80" y="232" textAnchor="middle" className="ilus-texto-claro">Apunta al código QR</text>
      <text x="80" y="244" textAnchor="middle" className="ilus-tenue">de la pantalla de LiveMetric</text>
    </Telefono>
  );
}

function CodigoMicrosoft() {
  return (
    <Telefono etiqueta="La cuenta LiveMetric en Microsoft Authenticator, con su código de 6 dígitos resaltado" titulo="Authenticator">
      <rect x="22" y="56" width="116" height="78" rx="8" className="ilus-fila" />
      <rect x="30" y="64" width="20" height="20" rx="5" className="ilus-icono-app" />
      <text x="40" y="78" textAnchor="middle" className="ilus-texto-boton">LM</text>
      <text x="56" y="73" className="ilus-texto ilus-negrita">LiveMetric</text>
      <text x="56" y="83" className="ilus-tenue">Código de un solo uso</text>
      <text x="32" y="117" className="ilus-codigo">482 913</text>
      <circle cx="128" cy="111" r="7" className="ilus-reloj" />
      <text x="128" y="113.5" textAnchor="middle" className="ilus-mini">21</text>
      <rect x="26" y="96" width="88" height="30" rx="6" className={RESALTADO} />
      <text x="22" y="156" className="ilus-tenue">Cambia cada 30 segundos.</text>
    </Telefono>
  );
}

function CodigoGoogle() {
  return (
    <Telefono etiqueta="El código de LiveMetric en Google Authenticator, con su código de 6 dígitos resaltado" titulo="Authenticator">
      <text x="22" y="72" className="ilus-tenue">LiveMetric</text>
      <text x="22" y="98" className="ilus-codigo">482 913</text>
      <circle cx="126" cy="92" r="8" className="ilus-reloj" />
      <path d="M126 92 L126 84 A8 8 0 0 1 133.6 94.5 Z" className="ilus-reloj-resto" />
      <rect x="16" y="76" width="100" height="30" rx="6" className={RESALTADO} />
      <line x1="22" y1="118" x2="138" y2="118" className="ilus-linea" />
      <text x="22" y="134" className="ilus-tenue">El círculo muestra cuánto falta</text>
      <text x="22" y="144" className="ilus-tenue">para que cambie.</text>
    </Telefono>
  );
}

// La pantalla de LiveMetric donde se escribe el código (en el equipo de
// votación o en el panel del jurado).
function Pantalla({ boton }) {
  return (
    <svg viewBox="0 0 200 150" role="img" aria-label={`LiveMetric con el código escrito y el botón ${boton} resaltado`} className="ilus ilus-pantalla-pc">
      <rect x="6" y="6" width="188" height="124" rx="8" className="ilus-marco" />
      <rect x="12" y="12" width="176" height="112" rx="4" className="ilus-pantalla" />
      <circle cx="20" cy="19" r="2" className="ilus-parlante" />
      <circle cx="27" cy="19" r="2" className="ilus-parlante" />
      <circle cx="34" cy="19" r="2" className="ilus-parlante" />
      <text x="100" y="38" textAnchor="middle" className="ilus-texto ilus-negrita">LiveMetric</text>
      <text x="44" y="56" className="ilus-tenue">Código de la app</text>
      <rect x="44" y="61" width="112" height="22" rx="5" className="ilus-campo" />
      <text x="100" y="76" textAnchor="middle" className="ilus-texto-codigo">4 8 2 9 1 3</text>
      <rect x="44" y="91" width="112" height="20" rx="5" className="ilus-boton" />
      <text x="100" y="104" textAnchor="middle" className="ilus-texto-boton">{boton}</text>
      <rect x="39" y="86" width="122" height="30" rx="8" className={RESALTADO} />
      <path d="M80 130 l-6 14 h52 l-6 -14" className="ilus-base" />
    </svg>
  );
}

export const ILUSTRACIONES = {
  'tienda-microsoft': () => <Tienda app="Microsoft Authenticator" />,
  'tienda-google': () => <Tienda app="Google Authenticator" />,
  'inicio-microsoft': InicioMicrosoft,
  'inicio-google': InicioGoogle,
  'tipo-microsoft': TipoMicrosoft,
  'tipo-google': TipoGoogle,
  escanear: Escanear,
  'codigo-microsoft': CodigoMicrosoft,
  'codigo-google': CodigoGoogle,
  'pantalla-registro': () => <Pantalla boton="Confirmar y entrar" />,
  'pantalla-ingreso': () => <Pantalla boton="Entrar" />,
};

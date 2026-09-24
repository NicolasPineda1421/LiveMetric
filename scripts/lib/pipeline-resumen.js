#!/usr/bin/env node
// LiveMetric - Interpreta la salida de cada control del pipeline local y la
// resume en una linea facil de leer (con colores), mas el cuadro final.
//
// Lo usan tanto scripts/pipeline-local.sh como scripts/pipeline-local.bat:
// esos scripts solo corren las herramientas (guardando su salida completa
// en un log) y le pasan a este archivo el codigo de salida y el log. Asi la
// interpretacion (contar CVE, hallazgos, pruebas, etc.) existe una sola vez
// y se ve igual en Linux y en Windows. Node.js ya es requisito de los dos
// scripts (npm audit y las pruebas corren en el host), y esto no usa
// ninguna dependencia externa.
//
// Uso:
//   node pipeline-resumen.js inicio    <resultados.jsonl>
//   node pipeline-resumen.js paso      <n>
//   node pipeline-resumen.js resultado <resultados.jsonl> <control> <servicio|-> <codigo> <log> [sarif]
//   node pipeline-resumen.js omitido   <resultados.jsonl> <control> <servicio|-> <motivo>
//   node pipeline-resumen.js final     <resultados.jsonl> <carpeta-de-logs>
//
// Los textos de cada paso tambien viven aca (y no en los scripts): cmd.exe
// no lee los .bat como UTF-8, asi que los acentos escritos en un .bat salen
// desfigurados, mientras que Node los muestra bien en las dos plataformas.
//
// <control>: gitleaks, semgrep, npm-audit, trivy-fs, build, trivy-image, pruebas.
// "final" termina con codigo 1 si algun control que bloquea fallo.
// Con PIPELINE_MOSTRAR_LOG=1, "resultado" imprime ademas el log completo
// antes de la linea de resultado (el modo --detalle de pipeline-local.bat,
// que no puede mostrar la salida en vivo como hace la version bash).

'use strict';

const fs = require('fs');
const path = require('path');

const {
  TTY,
  SIMBOLO,
  COLOR_ESTADO,
  ANCHO,
  verde,
  rojo,
  amarillo,
  azul,
  gris,
  negrita,
  escribir,
  rellenar,
  plural,
  duracion,
} = require('./consola');

const NOMBRE = {
  gitleaks: 'Gitleaks',
  semgrep: 'Semgrep',
  'npm-audit': 'npm audit',
  'trivy-fs': 'Trivy (deps)',
  build: 'docker build',
  'trivy-image': 'Trivy (imagen)',
  pruebas: 'Pruebas',
};

const PASOS = [
  ['Secretos en el repositorio', 'Gitleaks busca contraseñas, tokens o claves subidas por error a git.'],
  ['Código fuente', 'Semgrep busca patrones inseguros (OWASP Top 10, Express, JWT). No bloquea.'],
  ['Dependencias de cada servicio', 'npm audit y Trivy buscan CVE altas o críticas en las librerías.'],
  ['Imágenes Docker', 'Construye las 6 imágenes reales; Trivy busca CVE altas o críticas.'],
  ['Pruebas unitarias', 'Jest + Supertest sobre los 5 servicios de backend.'],
];

// Parte una linea larga en renglones de hasta <ancho> caracteres (cortando
// en un espacio cuando se puede), con un maximo de <max> renglones: en los
// mensajes de error lo importante suele estar al final.
function envolver(texto, ancho = ANCHO - 10, max = 3) {
  const renglones = [];
  let resto = texto;
  while (resto.length > ancho && renglones.length < max - 1) {
    let corte = resto.lastIndexOf(' ', ancho);
    if (corte < ancho / 2) corte = ancho;
    renglones.push(resto.slice(0, corte));
    resto = resto.slice(corte).trimStart();
  }
  renglones.push(resto.length > ancho ? `${resto.slice(0, ancho - 1)}…` : resto);
  return renglones;
}

// --- Lectura de logs -----------------------------------------------------------

function leer(ruta) {
  try {
    return fs.readFileSync(ruta, 'utf8');
  } catch {
    return '';
  }
}

// Quita colores ANSI y se queda con el ultimo estado de las lineas que las
// herramientas reescriben con \r (barras de progreso).
function lineas(texto) {
  return texto
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.split('\r').filter(Boolean).pop() || '')
    .map((l) => l.trimEnd());
}

// Cuando una herramienta falla por algo que no es un hallazgo (sin red, un
// error de configuracion, etc.), las lineas que mencionan el error suelen
// explicar mas que el final del log (que en Python, por ejemplo, es un
// traceback).
function lineasDeError(ls, max = 6) {
  const conError = ls.filter((l) =>
    /\b(error|fatal|failed|denied|not found|no such|cannot|unable|refused)\b/i.test(l),
  );
  const elegidas = conError.length ? conError : ls.filter((l) => l.trim());
  // Sin la marca de tiempo y el nivel con que Trivy empieza cada linea.
  const limpias = elegidas.map((l) =>
    l.replace(/\t+/g, ' ').replace(/^\S*\d{4}-\d\d-\d\dT[\d:.]+Z?\s+(INFO|WARN|ERROR|FATAL)\s+/, '').trim(),
  );
  return [...new Set(limpias)].slice(-max);
}

function pistaDeRed(texto) {
  return /Name does not resolve|NameResolutionError|Temporary failure in name resolution|no such host|ENOTFOUND|EAI_AGAIN/.test(texto)
    ? ['→ Parece un problema de red/DNS: revisá la conexión a internet y volvé a intentar.']
    : [];
}

// --- Interpretacion de cada control -----------------------------------------------
// Cada funcion devuelve { estado, detalle, celda, extracto }:
//   estado:   ok | aviso (no bloquea) | falla (bloquea)
//   detalle:  frase corta para la linea de resultado
//   celda:    texto cortisimo para el cuadro final (ej. "3 CVE")
//   extracto: lineas extra que explican el por que (solo si hacen falta)
//   notas:    lineas que no se parten al imprimirlas (rutas de archivos)

function gitleaks(codigo, log) {
  const ls = lineas(leer(log));
  const commits = ls.join('\n').match(/(\d+) commits scanned/);
  if (codigo === 0) {
    return {
      estado: 'ok',
      detalle: `sin secretos expuestos${commits ? ` (${commits[1]} commits revisados)` : ''}`,
    };
  }

  const hallazgos = [];
  for (const l of ls) {
    if (/^Finding:/.test(l)) hallazgos.push({});
    const campo = l.match(/^(RuleID|File|Line|Commit):\s*(.+)$/);
    if (campo && hallazgos.length) hallazgos[hallazgos.length - 1][campo[1]] = campo[2].trim();
  }
  if (!hallazgos.length) {
    return {
      estado: 'falla',
      detalle: 'no pudo completar el análisis',
      celda: 'error',
      extracto: lineasDeError(ls),
    };
  }
  return {
    estado: 'falla',
    detalle: `${plural(hallazgos.length, 'posible secreto expuesto', 'posibles secretos expuestos')}`,
    celda: String(hallazgos.length),
    extracto: [
      ...hallazgos.slice(0, 8).map(
        (h) => `• ${h.RuleID || '?'} en ${h.File || '?'}:${h.Line || '?'}${h.Commit ? ` (commit ${h.Commit.slice(0, 7)})` : ''}`,
      ),
      ...(hallazgos.length > 8 ? [`… y ${hallazgos.length - 8} más`] : []),
      '→ Si es real, rotá esa credencial (sacarla del código no alcanza: queda en el historial).',
      '→ Si es un falso positivo, agregalo a .gitleaks.toml.',
    ],
  };
}

const SEVERIDAD_SEMGREP = {
  error: { orden: 0, nombre: 'alta', uno: 'alto', varios: 'altos' },
  warning: { orden: 1, nombre: 'media', uno: 'medio', varios: 'medios' },
  note: { orden: 2, nombre: 'info', uno: 'informativo', varios: 'informativos' },
};

function semgrep(codigo, log, sarif) {
  const texto = leer(log);
  let datos = null;
  try {
    datos = JSON.parse(fs.readFileSync(sarif, 'utf8'));
  } catch {
    // Sin SARIF valido el escaneo no termino: se trata como falla abajo.
  }
  if (codigo !== 0 || !datos) {
    return {
      estado: 'falla',
      detalle: 'no pudo completar el análisis',
      celda: 'error',
      extracto: [...lineasDeError(lineas(texto), 3), ...pistaDeRed(texto)],
    };
  }

  // En el SARIF de Semgrep la severidad no viene en cada hallazgo sino en la
  // regla que lo genero (defaultConfiguration.level).
  const corrida = (datos.runs && datos.runs[0]) || {};
  const reglas = (corrida.tool && corrida.tool.driver && corrida.tool.driver.rules) || [];
  const nivelDeRegla = new Map(reglas.map((r) => [r.id, r.defaultConfiguration && r.defaultConfiguration.level]));
  // Los silenciados en el codigo con "nosemgrep" (con su justificacion al
  // lado) igual vienen en el SARIF, marcados con "suppressions": no cuentan.
  const hallazgos = (corrida.results || [])
    .filter((r) => !(r.suppressions && r.suppressions.length))
    .map((r) => {
      const ubicacion = (r.locations && r.locations[0] && r.locations[0].physicalLocation) || {};
      const nivel = r.level || nivelDeRegla.get(r.ruleId);
      return {
        regla: String(r.ruleId || '?').split('.').pop(),
        severidad: SEVERIDAD_SEMGREP[nivel] ? nivel : 'warning',
        archivo: (ubicacion.artifactLocation && ubicacion.artifactLocation.uri) || '?',
        linea: (ubicacion.region && ubicacion.region.startLine) || '?',
        mensaje: (r.message && r.message.text) || '',
      };
    });

  if (!hallazgos.length) {
    return { estado: 'ok', detalle: 'sin hallazgos' };
  }

  // Los de severidad INFO no son problemas: son avisos de contexto, y en
  // p/nodejsscan casi todos confirman una proteccion que SI esta ("HSTS
  // header is present", "has API rate limiting controls", etc.). Se
  // cuentan aparte y no hacen amarillo el resultado.
  const informativos = hallazgos.filter((h) => h.severidad === 'note').length;
  const aRevisar = hallazgos.length - informativos;

  const porSeveridad = { error: 0, warning: 0, note: 0 };
  const porRegla = new Map();
  for (const h of hallazgos) {
    porSeveridad[h.severidad] += 1;
    if (!porRegla.has(h.regla)) porRegla.set(h.regla, []);
    porRegla.get(h.regla).push(h);
  }
  const grupos = [...porRegla.values()].sort(
    (a, b) => SEVERIDAD_SEMGREP[a[0].severidad].orden - SEVERIDAD_SEMGREP[b[0].severidad].orden || b.length - a.length,
  );

  const listado = path.join(path.dirname(sarif), 'semgrep-hallazgos.txt');
  escribirListadoSemgrep(listado, hallazgos.length, grupos);

  const notas = ['Lista completa, con la explicación de cada uno:', `  ${listado}`];
  const masInformativos = informativos ? ` · ${plural(informativos, 'informativo', 'informativos')}` : '';
  if (!aRevisar) {
    return { estado: 'ok', detalle: `sin hallazgos para revisar${masInformativos}`, notas };
  }

  const desglose = ['error', 'warning']
    .filter((nivel) => porSeveridad[nivel])
    .map((nivel) => plural(porSeveridad[nivel], SEVERIDAD_SEMGREP[nivel].uno, SEVERIDAD_SEMGREP[nivel].varios))
    .join(' · ');
  const relevantes = grupos.filter((g) => g[0].severidad !== 'note');
  const MAX_REGLAS = 5;
  return {
    estado: 'aviso',
    detalle: `${plural(aRevisar, 'hallazgo', 'hallazgos')} para revisar (${desglose})${masInformativos} — no bloquean`,
    celda: String(aRevisar),
    extracto: [
      ...relevantes.slice(0, MAX_REGLAS).map((g) => {
        const primero = g[0];
        const donde = `${primero.archivo}:${primero.linea}${g.length > 1 ? ` y ${g.length - 1} más` : ''}`;
        return `${String(g.length).padStart(3)}× ${SEVERIDAD_SEMGREP[primero.severidad].nombre.padEnd(5)} ${primero.regla} — ${donde}`;
      }),
      ...(relevantes.length > MAX_REGLAS ? [`      … y ${relevantes.length - MAX_REGLAS} reglas más`] : []),
    ],
    notas,
  };
}

function escribirListadoSemgrep(ruta, total, grupos) {
  const salida = [`Hallazgos de Semgrep: ${total} (ordenados por severidad)`, ''];
  for (const g of grupos) {
    const { severidad, regla, mensaje } = g[0];
    salida.push(`[${SEVERIDAD_SEMGREP[severidad].nombre.toUpperCase()}] ${regla} (${g.length})`);
    salida.push(`  ${mensaje.replace(/\s+/g, ' ').trim()}`);
    for (const h of g) salida.push(`    - ${h.archivo}:${h.linea}`);
    salida.push('');
  }
  try {
    fs.writeFileSync(ruta, salida.join('\n'));
  } catch {
    // El listado es un extra: si no se puede escribir, el resumen sigue.
  }
}

const SEVERIDAD_NPM = { low: 'baja', moderate: 'moderada', high: 'alta', critical: 'crítica' };

function npmAudit(codigo, log, servicio) {
  const ls = lineas(leer(log));
  const texto = ls.join('\n');
  if (/found 0 vulnerabilities/.test(texto)) {
    return { estado: 'ok', detalle: 'sin vulnerabilidades conocidas' };
  }

  // Ej.: "3 vulnerabilities (1 moderate, 2 high)"
  const total = texto.match(/(\d+) (?:\w+ severity )?vulnerabilit(?:y|ies)(?: \(([^)]+)\))?/);
  if (!total) {
    return {
      estado: 'falla',
      detalle: 'no pudo completar el análisis',
      celda: 'error',
      extracto: [...lineasDeError(ls), ...pistaDeRed(texto)],
    };
  }
  const n = Number(total[1]);
  const desglose = (total[2] || '')
    .replace(/(\d+) (low|moderate|high|critical)/g, (_, k, sev) => `${k} ${SEVERIDAD_NPM[sev]}${k === '1' ? '' : 's'}`);

  if (codigo === 0) {
    return {
      estado: 'aviso',
      detalle: `${plural(n, 'vulnerabilidad', 'vulnerabilidades')} de severidad baja o moderada — no bloquean`,
      celda: `${n} vuln.`,
    };
  }

  // En el reporte de texto, cada paquete afectado es la linea anterior a
  // "Severity: ..." y el titulo del aviso, la siguiente.
  const paquetes = [];
  ls.forEach((l, i) => {
    const sev = l.match(/^Severity:\s*(\w+)/);
    if (sev && i > 0) {
      paquetes.push(`• ${ls[i - 1].trim()} (${SEVERIDAD_NPM[sev[1]] || sev[1]})${ls[i + 1] ? `: ${ls[i + 1].trim()}` : ''}`);
    }
  });
  return {
    estado: 'falla',
    detalle: `${plural(n, 'vulnerabilidad', 'vulnerabilidades')}${desglose ? ` (${desglose})` : ''}`,
    celda: `${n} vuln.`,
    extracto: [
      ...paquetes.slice(0, 6),
      ...(paquetes.length > 6 ? [`… y ${paquetes.length - 6} más`] : []),
      `→ Probá: cd services/${servicio} && npm audit fix`,
    ],
  };
}

function trivy(codigo, log, _servicio, control) {
  const ls = lineas(leer(log));
  const texto = ls.join('\n');
  if (codigo === 0) {
    return { estado: 'ok', detalle: 'sin CVE altas ni críticas' };
  }

  // Trivy imprime "Total: N (HIGH: x, CRITICAL: y)" por cada objetivo
  // escaneado (paquetes del sistema base, package-lock.json, etc.).
  let altas = 0;
  let criticas = 0;
  for (const m of texto.matchAll(/Total: \d+ \(([^)]*)\)/g)) {
    altas += Number((m[1].match(/HIGH: (\d+)/) || [0, 0])[1]);
    criticas += Number((m[1].match(/CRITICAL: (\d+)/) || [0, 0])[1]);
  }
  if (!altas && !criticas) {
    return {
      estado: 'falla',
      detalle: 'no pudo completar el análisis',
      celda: 'error',
      extracto: [...lineasDeError(ls), ...pistaDeRed(texto)],
    };
  }

  // Filas de la tabla: Library │ Vulnerability │ Severity │ Status │
  // Installed │ Fixed │ Title. Trivy deja vacias las celdas de libreria y
  // version instalada cuando se repiten en la fila siguiente.
  const cves = [];
  let libreria = '';
  let instalada = '';
  for (const l of ls) {
    if (!l.startsWith('│')) continue;
    const celdas = l.split('│').slice(1, -1).map((c) => c.trim());
    if (celdas.length < 6) continue;
    if (celdas[0]) libreria = celdas[0];
    if (celdas[4]) instalada = celdas[4];
    if (/^(CVE|GHSA)-/.test(celdas[1])) {
      cves.push(`• ${libreria} ${instalada} → ${celdas[5] || 'sin arreglo'}: ${celdas[1]} (${celdas[2]})`);
    }
  }
  const n = altas + criticas;
  const desglose = [criticas && plural(criticas, 'crítica', 'críticas'), altas && plural(altas, 'alta', 'altas')]
    .filter(Boolean)
    .join(', ');
  return {
    estado: 'falla',
    detalle: `${plural(n, 'CVE', 'CVE')} (${desglose})`,
    celda: `${n} CVE`,
    extracto: [
      ...cves.slice(0, 6),
      ...(cves.length > 6 ? [`… y ${cves.length - 6} más`] : []),
      control === 'trivy-image'
        ? '→ Actualizá la imagen base (FROM del Dockerfile) o la librería afectada.'
        : '→ Actualizá la librería en package.json, o justificá la excepción en .trivyignore.',
    ],
  };
}

function build(codigo, log) {
  if (codigo === 0) return { estado: 'ok', detalle: 'imagen construida' };
  const ls = lineas(leer(log));
  const errores = ls.filter((l) => /ERROR|error:|failed to solve|npm ERR!/i.test(l));
  return {
    estado: 'falla',
    detalle: 'no se pudo construir la imagen',
    celda: 'error',
    extracto: [...new Set((errores.length ? errores : ls.filter((l) => l.trim())).map((l) => l.trim()))].slice(-8),
  };
}

function pruebas(codigo, log) {
  const ls = lineas(leer(log));
  const resumen = (ls.find((l) => /^Tests:/.test(l)) || '').replace(/^Tests:\s*/, '');
  const cuenta = (clave) => Number((resumen.match(new RegExp(`(\\d+) ${clave}`)) || [0, 0])[1]);
  const pasaron = cuenta('passed');
  const fallaron = cuenta('failed');
  const total = cuenta('total');

  if (codigo === 0) {
    return {
      estado: 'ok',
      detalle: resumen ? `${plural(pasaron, 'prueba pasó', 'pruebas pasaron')}` : 'pruebas pasaron',
      celda: resumen ? String(pasaron) : '',
    };
  }
  if (!resumen) {
    return {
      estado: 'falla',
      detalle: 'las pruebas no pudieron ejecutarse',
      celda: 'error',
      extracto: lineasDeError(ls),
    };
  }
  // Jest marca cada prueba fallida con "● Suite › prueba" (y usa el mismo
  // simbolo para los console.log, que no interesan aca).
  const fallidas = [...new Set(ls.filter((l) => /^\s*● /.test(l) && !/● Console/.test(l)).map((l) => l.trim()))];
  return {
    estado: 'falla',
    detalle: `${fallaron} de ${total} pruebas fallaron`,
    celda: `${fallaron} fallan`,
    extracto: [...fallidas.slice(0, 8), ...(fallidas.length > 8 ? [`… y ${fallidas.length - 8} más`] : [])],
  };
}

const INTERPRETAR = {
  gitleaks,
  semgrep: (codigo, log, _servicio, _control, sarif) => semgrep(codigo, log, sarif),
  'npm-audit': npmAudit,
  'trivy-fs': trivy,
  build,
  'trivy-image': trivy,
  pruebas,
};

// --- Comandos --------------------------------------------------------------------------

function lineaDeResultado({ control, servicio, estado, detalle }) {
  const color = COLOR_ESTADO[estado];
  const etiqueta = servicio === '-' ? rellenar(NOMBRE[control], 28) : `${rellenar(servicio, 12)}${rellenar(NOMBRE[control], 16)}`;
  // \r + borrar linea: pisa el indicador "en curso" que dejo el script.
  return `${TTY ? '\r\x1b[2K' : ''}   ${color(SIMBOLO[estado])} ${etiqueta}${estado === 'ok' ? detalle : color(detalle)}`;
}

function guardar(archivo, registro) {
  fs.appendFileSync(archivo, `${JSON.stringify(registro)}\n`);
}

function comandoInicio([archivo]) {
  fs.writeFileSync(archivo, `${JSON.stringify({ inicio: Date.now() })}\n`);
}

function comandoPaso([n]) {
  const [titulo, descripcion] = PASOS[Number(n) - 1];
  escribir();
  escribir(azul(negrita(` ${SIMBOLO.paso} ${n}/${PASOS.length}  ${titulo}`)));
  escribir(gris(`     ${descripcion}`));
}

function comandoResultado([archivo, control, servicio, codigoTexto, log, sarif]) {
  if (!INTERPRETAR[control]) throw new Error(`control desconocido: ${control}`);
  const codigo = Number(codigoTexto);

  if (process.env.PIPELINE_MOSTRAR_LOG === '1') {
    if (TTY) process.stdout.write('\r\x1b[2K');
    for (const l of lineas(leer(log))) escribir(`     ${gris('│')} ${l}`);
  }

  const r = INTERPRETAR[control](codigo, log, servicio, control, sarif);
  const registro = { control, servicio, log, estado: r.estado, detalle: r.detalle, celda: r.celda || '' };
  escribir(lineaDeResultado(registro));
  for (const l of r.extracto || []) {
    envolver(l).forEach((renglon, i) => escribir(`       ${i ? '  ' : ''}${gris(renglon)}`));
  }
  for (const l of r.notas || []) escribir(`       ${gris(l)}`);
  guardar(archivo, registro);
}

function comandoOmitido([archivo, control, servicio, motivo]) {
  const registro = { control, servicio, estado: 'omitido', detalle: `no se corrió (${motivo})`, celda: '' };
  escribir(lineaDeResultado(registro));
  guardar(archivo, registro);
}

function comandoFinal([archivo, carpetaLogs]) {
  const lineasArchivo = leer(archivo)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const inicio = (lineasArchivo.find((r) => r.inicio) || {}).inicio;
  const registros = lineasArchivo.filter((r) => r.control);
  const buscar = (control, servicio) => registros.find((r) => r.control === control && r.servicio === servicio);
  const servicios = [...new Set(registros.map((r) => r.servicio).filter((s) => s !== '-'))];

  const raya = azul('━'.repeat(Math.min(ANCHO, 76)));
  escribir();
  escribir(raya);
  escribir(negrita('  RESULTADO DEL ANÁLISIS DE SEGURIDAD'));
  escribir(raya);

  // Controles sobre todo el repositorio.
  escribir();
  escribir(negrita('  Todo el repositorio'));
  for (const [control, titulo] of [['gitleaks', 'Secretos  · Gitleaks'], ['semgrep', 'Código    · Semgrep']]) {
    const r = buscar(control, '-');
    if (!r) continue;
    const color = COLOR_ESTADO[r.estado];
    escribir(`   ${color(SIMBOLO[r.estado])} ${rellenar(titulo, 24)}${r.estado === 'ok' ? r.detalle : color(r.detalle)}`);
  }

  // Cuadro por servicio: una fila por servicio, una columna por control.
  const COLUMNAS = ['npm-audit', 'trivy-fs', 'build', 'trivy-image', 'pruebas'];
  const celda = (r) => {
    if (!r) return gris(rellenar('—', 12));
    return COLOR_ESTADO[r.estado](rellenar(`${SIMBOLO[r.estado]} ${r.celda}`.trim(), 12));
  };
  escribir();
  escribir(negrita(`  ${rellenar('Por servicio', 14)}${rellenar('Dependencias', 24)}${rellenar('Imagen Docker', 24)}Pruebas`));
  escribir(gris(`  ${rellenar('', 14)}${['npm audit', 'Trivy', 'build', 'Trivy', 'Jest'].map((t) => rellenar(t, 12)).join('')}`));
  for (const s of servicios) {
    escribir(`  ${rellenar(s, 14)}${COLUMNAS.map((c) => celda(buscar(c, s))).join('')}`);
  }
  escribir(
    gris(
      `  ${SIMBOLO.ok} pasó   ${SIMBOLO.aviso} para revisar (no bloquea)   ${SIMBOLO.falla} falló (bloquea)   — no se corrió`,
    ),
  );

  // Que hacer: primero lo que bloquea, despues lo que conviene revisar.
  const fallas = registros.filter((r) => r.estado === 'falla');
  // Los avisos de Gitleaks/Semgrep ya se ven completos en "Todo el
  // repositorio"; aca solo los de cada servicio, que en el cuadro son un
  // simbolo.
  const avisos = registros.filter((r) => r.estado === 'aviso' && r.servicio !== '-');
  const omitidos = registros.filter((r) => r.estado === 'omitido');
  const describir = (r) => `${NOMBRE[r.control]}${r.servicio === '-' ? '' : ` · ${r.servicio}`}: ${r.detalle}`;
  if (fallas.length || avisos.length || omitidos.length) escribir();
  if (fallas.length) {
    escribir(rojo(negrita(`  ${SIMBOLO.falla} ${plural(fallas.length, 'control falló', 'controles fallaron')} (el detalle está arriba, debajo de cada uno):`)));
    for (const r of fallas) {
      escribir(rojo(`     • ${describir(r)}`) + (r.log ? gris(`  → ${path.basename(r.log)}`) : ''));
    }
  }
  if (avisos.length) {
    escribir(amarillo(`  ${SIMBOLO.aviso} Para revisar, sin bloquear:`));
    for (const r of avisos) escribir(amarillo(`     • ${describir(r)}`));
  }
  for (const r of omitidos) escribir(gris(`  ${SIMBOLO.omitido} ${describir(r)}`));

  escribir();
  escribir(gris('  No se revisan localmente (solo en GitHub Actions): Checkov, despliegue con Terraform y DAST con OWASP ZAP.'));
  escribir(gris(`  Logs completos de cada paso: ${carpetaLogs}`));
  if (inicio) {
    escribir(gris(`  Duración: ${duracion(Math.round((Date.now() - inicio) / 1000))}`));
  }
  escribir();
  if (fallas.length) {
    escribir(rojo(negrita(`  ${SIMBOLO.falla} Hay controles en rojo: corregilos antes de hacer push.`)));
    process.exitCode = 1;
  } else {
    escribir(verde(negrita(`  ${SIMBOLO.ok} Todos los controles que bloquean pasaron. Es seguro hacer push.`)));
  }
}

const COMANDOS = {
  inicio: comandoInicio,
  paso: comandoPaso,
  resultado: comandoResultado,
  omitido: comandoOmitido,
  final: comandoFinal,
};
const [comando, ...argumentos] = process.argv.slice(2);
if (!COMANDOS[comando]) {
  process.stderr.write('Uso: pipeline-resumen.js inicio|paso|resultado|omitido|final ... (ver el comentario al inicio del archivo)\n');
  process.exit(2);
}
COMANDOS[comando](argumentos);

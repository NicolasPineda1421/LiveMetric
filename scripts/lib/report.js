#!/usr/bin/env node
// LiveMetric - Interpreta los logs que guardan scripts/pipeline-local.sh y
// scripts/pipeline-local.bat, para mostrar en pantalla un resumen legible
// ("2 HIGH, 1 CRITICAL", "11/12 pruebas OK", ...) en vez de la salida cruda
// de cada herramienta. Es un unico helper en Node (que ya es requisito para
// npm audit / npm test) para no duplicar el parseo en bash y en batch.
//
// La salida es ASCII a proposito: cmd.exe no siempre usa UTF-8.
//
// Uso:
//   node scripts/lib/report.js summary <tipo> <archivo>      -> una linea
//   node scripts/lib/report.js details <tipo> <archivo> [n]  -> hasta n items
//   node scripts/lib/report.js tail <archivo> [n]            -> ultimas n lineas
//
// Tipos: gitleaks, semgrep (archivo SARIF), npm-audit, trivy, build, jest.

'use strict';

const fs = require('fs');

const [, , mode, kindOrFile, fileArg, nArg] = process.argv;

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  } catch {
    return '';
  }
}

function lines(text) {
  return text.split(/\r?\n/);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function clip(s, max = 90) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// --- Gitleaks --------------------------------------------------------------
function gitleaksFindings(text) {
  const out = [];
  let cur = null;
  for (const l of lines(text)) {
    const m = l.match(/^\s*(RuleID|File|Line):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'RuleID') { cur = { rule: m[2].trim() }; out.push(cur); }
    else if (cur) cur[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

const gitleaks = {
  summary(text) {
    if (/no leaks found/i.test(text)) return 'sin secretos detectados';
    const m = text.match(/leaks found:\s*(\d+)/i);
    const n = m ? Number(m[1]) : gitleaksFindings(text).length;
    if (n > 0) return `${plural(n, 'posible secreto', 'posibles secretos')} en el codigo`;
    return 'no se pudo leer el resultado (ver log)';
  },
  details(text, n) {
    return gitleaksFindings(text).slice(0, n)
      .map((f) => `${f.rule || '?'}  ->  ${f.file || '?'}:${f.line || '?'}`);
  },
};

// --- Semgrep (SARIF) -------------------------------------------------------
function semgrepResults(file) {
  let sarif;
  try { sarif = JSON.parse(read(file)); } catch { return null; }
  const run = (sarif.runs || [])[0] || {};
  const rules = {};
  for (const r of ((run.tool || {}).driver || {}).rules || []) {
    rules[r.id] = ((r.defaultConfiguration || {}).level) || 'warning';
  }
  return (run.results || []).map((r) => {
    const loc = (((r.locations || [])[0] || {}).physicalLocation) || {};
    const rule = String(r.ruleId || '?');
    return {
      level: r.level || rules[r.ruleId] || 'warning',
      rule: rule.split('.').pop(),
      file: (loc.artifactLocation || {}).uri || '?',
      line: (loc.region || {}).startLine || '?',
    };
  });
}

const semgrep = {
  summary(_text, file) {
    const res = semgrepResults(file);
    if (!res) return 'no se genero el reporte SARIF (ver log)';
    if (res.length === 0) return 'sin hallazgos';
    const by = {};
    for (const r of res) by[r.level] = (by[r.level] || 0) + 1;
    const parts = ['error', 'warning', 'note'].filter((k) => by[k]).map((k) => `${by[k]} ${k}`);
    return `${plural(res.length, 'hallazgo', 'hallazgos')} a revisar (${parts.join(', ')}) - informativo`;
  },
  details(_text, n, file) {
    const order = { error: 0, warning: 1, note: 2 };
    return (semgrepResults(file) || [])
      .sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
      .slice(0, n)
      .map((r) => `[${r.level}] ${r.file}:${r.line}  ${r.rule}`);
  },
};

// --- npm audit -------------------------------------------------------------
const npmAudit = {
  summary(text) {
    if (/found 0 vulnerabilities/i.test(text)) return 'sin vulnerabilidades';
    const m = text.match(/(\d+)\s+(?:(low|moderate|high|critical)\s+severity\s+)?vulnerabilit(?:y|ies)(?:\s*\(([^)]*)\))?/i);
    if (m) {
      const detail = m[3] || (m[2] ? `${m[1]} ${m[2]}` : '');
      return `${plural(Number(m[1]), 'vulnerabilidad', 'vulnerabilidades')}${detail ? ` (${detail})` : ''}`;
    }
    if (/npm (ERR!|error)/i.test(text)) return 'error al ejecutar npm audit (ver log)';
    return 'sin resumen de npm audit (ver log)';
  },
  details(text, n) {
    const out = [];
    const ls = lines(text);
    for (let i = 0; i < ls.length; i++) {
      const sev = ls[i].match(/^Severity:\s*(\w+)/i);
      if (!sev) continue;
      const pkg = (ls[i - 1] || '').trim();
      out.push(`${pkg}  [${sev[1]}]`);
    }
    return out.slice(0, n);
  },
};

// --- Trivy (fs e image) ----------------------------------------------------
function trivyRows(text) {
  // La tabla de Trivy combina celdas repetidas (misma libreria, version,
  // estado) dejandolas vacias en las filas siguientes: se heredan de la fila
  // anterior. Las columnas se ubican por su titulo, porque varian segun la
  // version de Trivy (por ejemplo, "Status" no siempre esta).
  const rows = [];
  let cols = null;
  let prev = {};
  for (const l of lines(text)) {
    if (!l.includes('│')) continue;
    const cells = l.split('│').map((c) => c.trim());
    if (cells.includes('Vulnerability')) {
      cols = {};
      cells.forEach((c, i) => { if (c) cols[c] = i; });
      prev = {};
      continue;
    }
    const idx = cells.findIndex((c) => /^(CVE|GHSA)-[\w-]+$/.test(c));
    if (idx < 0) continue;
    const at = (name, fallback) => {
      const i = cols && cols[name] !== undefined ? cols[name] : fallback;
      return i === undefined ? '' : (cells[i] || '');
    };
    const row = {
      id: cells[idx],
      sev: at('Severity', idx + 1) || '?',
      lib: at('Library', idx - 1) || prev.lib || '?',
      installed: at('Installed Version') || prev.installed || '?',
      fixed: at('Fixed Version') || '',
    };
    prev = row;
    rows.push(row);
  }
  return rows;
}

const trivy = {
  summary(text) {
    let high = 0; let crit = 0; let found = false;
    for (const m of text.matchAll(/Total:\s*\d+\s*\(([^)]*)\)/g)) {
      found = true;
      const h = m[1].match(/HIGH:\s*(\d+)/); const c = m[1].match(/CRITICAL:\s*(\d+)/);
      high += h ? Number(h[1]) : 0; crit += c ? Number(c[1]) : 0;
    }
    if (!found) {
      const rows = trivyRows(text);
      high = rows.filter((r) => r.sev === 'HIGH').length;
      crit = rows.filter((r) => r.sev === 'CRITICAL').length;
    }
    if (high + crit > 0) return `${crit} CRITICAL, ${high} HIGH`;
    if (/\bFATAL\b|\berror\b.*\bscan\b/i.test(text)) return 'error al ejecutar Trivy (ver log)';
    return 'sin CVEs HIGH/CRITICAL';
  },
  details(text, n) {
    const seen = new Set();
    return trivyRows(text)
      .filter((r) => !seen.has(r.id + r.lib) && seen.add(r.id + r.lib))
      .sort((a, b) => (a.sev === 'CRITICAL' ? 0 : 1) - (b.sev === 'CRITICAL' ? 0 : 1))
      .slice(0, n)
      .map((r) => `${r.id} [${r.sev}] ${r.lib} ${r.installed}${r.fixed ? ` -> actualizar a ${r.fixed}` : ' (sin version corregida)'}`);
  },
};

// --- docker build ----------------------------------------------------------
const build = {
  summary(text) {
    const err = lines(text).find((l) => /\bERROR\b|error:/i.test(l));
    return err ? `fallo el build: ${clip(err, 70)}` : 'imagen construida';
  },
  details(text, n) {
    return lines(text).filter((l) => /\bERROR\b|error:/i.test(l)).slice(0, n).map((l) => clip(l));
  },
};

// --- Jest ------------------------------------------------------------------
const jest = {
  summary(text) {
    const m = text.match(/^Tests:\s*(.*)$/m);
    if (!m) {
      if (/npm (ERR!|error)/i.test(text)) return 'error al ejecutar npm test (ver log)';
      return 'sin resumen de Jest (ver log)';
    }
    const get = (k) => { const x = m[1].match(new RegExp(`(\\d+) ${k}`)); return x ? Number(x[1]) : 0; };
    const total = get('total'); const passed = get('passed'); const failed = get('failed');
    return failed > 0
      ? `${plural(failed, 'prueba fallo', 'pruebas fallaron')} (${passed}/${total} OK)`
      : `${passed}/${total} pruebas OK`;
  },
  details(text, n) {
    return lines(text).filter((l) => /^\s*●\s/.test(l) && !/Console/.test(l))
      .map((l) => clip(l.replace(/^\s*●\s*/, '')))
      .filter((l, i, a) => a.indexOf(l) === i)
      .slice(0, n);
  },
};

const kinds = { gitleaks, semgrep, 'npm-audit': npmAudit, trivy, build, jest };

if (mode === 'tail') {
  const n = Number(fileArg) || 15;
  const ls = lines(read(kindOrFile)).filter((l) => l.trim() !== '');
  process.stdout.write(ls.slice(-n).map((l) => clip(l, 110)).join('\n') + (ls.length ? '\n' : ''));
  process.exit(0);
}

const kind = kinds[kindOrFile];
if (!kind || !['summary', 'details'].includes(mode)) {
  process.stderr.write('Uso: report.js summary|details <gitleaks|semgrep|npm-audit|trivy|build|jest> <archivo> [n]\n');
  process.exit(2);
}

const text = read(fileArg);
if (mode === 'summary') {
  process.stdout.write(`${kind.summary(text, fileArg)}\n`);
} else {
  const items = kind.details(text, Number(nArg) || 5, fileArg);
  if (items.length) process.stdout.write(`${items.join('\n')}\n`);
}

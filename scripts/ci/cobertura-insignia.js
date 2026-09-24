#!/usr/bin/env node
// LiveMetric - Junta la cobertura de las pruebas de cada servicio (los
// coverage-summary.json que genera Jest en el job "unit-tests" del
// pipeline) y arma lo que el job "coverage-badge" publica en GitHub Pages,
// de donde sale la insignia de cobertura del README:
//   <salida>/coverage.json  formato "endpoint" de shields.io
//   <salida>/index.html     detalle por servicio
//
// Se mide la cobertura de LÍNEAS sumando las de todos los servicios, no
// promediando sus porcentajes: un servicio de 60 líneas no puede pesar lo
// mismo que uno de 500.
//
// Uso: node scripts/ci/cobertura-insignia.js <carpeta-con-artefactos> <salida>
//   <carpeta-con-artefactos>/coverage-<servicio>/coverage-summary.json

'use strict';

const fs = require('fs');
const path = require('path');

const [entrada, salida] = process.argv.slice(2);
if (!entrada || !salida) {
  console.error('Uso: node scripts/ci/cobertura-insignia.js <carpeta-con-artefactos> <salida>');
  process.exit(2);
}

const servicios = fs
  .readdirSync(entrada)
  .filter((dir) => dir.startsWith('coverage-'))
  .map((dir) => {
    const resumen = JSON.parse(fs.readFileSync(path.join(entrada, dir, 'coverage-summary.json'), 'utf8'));
    return { servicio: dir.replace(/^coverage-/, ''), ...resumen.total.lines };
  })
  .sort((a, b) => a.servicio.localeCompare(b.servicio));

if (!servicios.length) {
  console.error(`No se encontró ningún coverage-<servicio>/coverage-summary.json en ${entrada}`);
  process.exit(1);
}

const cubiertas = servicios.reduce((s, x) => s + x.covered, 0);
const totales = servicios.reduce((s, x) => s + x.total, 0);
const porcentaje = totales ? (cubiertas / totales) * 100 : 0;

// Mismos cortes que usan las insignias de cobertura habituales.
const color =
  porcentaje >= 80 ? 'brightgreen' : porcentaje >= 70 ? 'green' : porcentaje >= 60 ? 'yellowgreen' : porcentaje >= 50 ? 'yellow' : 'red';

fs.mkdirSync(salida, { recursive: true });
fs.writeFileSync(
  path.join(salida, 'coverage.json'),
  `${JSON.stringify({ schemaVersion: 1, label: 'cobertura', message: `${porcentaje.toFixed(1)}%`, color })}\n`,
);

const commit = (process.env.GITHUB_SHA || '').slice(0, 7);
const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : '';
const filas = servicios
  .map((s) => `<tr><td>${s.servicio}</td><td>${s.covered} / ${s.total}</td><td>${s.pct}%</td></tr>`)
  .join('\n        ');

fs.writeFileSync(
  path.join(salida, 'index.html'),
  `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LiveMetric · cobertura de pruebas</title>
  <style>
    :root { color-scheme: light dark; --borde: #8884; }
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--borde); }
    td:nth-child(n+2), th:nth-child(n+2) { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 600; }
    small { opacity: 0.7; }
  </style>
</head>
<body>
  <h1>Cobertura de pruebas</h1>
  <p>Líneas de código de cada microservicio ejecutadas por sus pruebas (Jest + Supertest), en el último pipeline de <code>main</code>.</p>
  <table>
    <thead><tr><th>Servicio</th><th>Líneas cubiertas</th><th>Cobertura</th></tr></thead>
    <tbody>
        ${filas}
    </tbody>
    <tfoot><tr><td>Total</td><td>${cubiertas} / ${totales}</td><td>${porcentaje.toFixed(1)}%</td></tr></tfoot>
  </table>
  <p><small>Generado el ${new Date().toISOString().slice(0, 10)}${commit ? ` · commit <code>${commit}</code>` : ''}${repo ? ` · <a href="${repo}">repositorio</a>` : ''}</small></p>
</body>
</html>
`,
);

console.log(`Cobertura total: ${porcentaje.toFixed(1)}% (${cubiertas}/${totales} líneas)`);
for (const s of servicios) console.log(`  ${s.servicio.padEnd(10)} ${s.pct}% (${s.covered}/${s.total})`);

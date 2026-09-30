#!/usr/bin/env node
// LiveMetric - Genera docs/informe-tecnico.pdf a partir de
// docs/informe-tecnico.md: el Markdown pasa a HTML, Chromium dibuja los
// diagramas Mermaid y lo imprime en A4, con índice, marcadores y números de
// página. El Markdown es la fuente: el PDF se regenera, nunca se edita.
//
// Uso (una vez: npm ci && npx playwright install chromium):
//   cd scripts/informe && npm run pdf

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import { chromium } from 'playwright';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(aqui, '../../docs');
const ORIGEN = path.join(docs, 'informe-tecnico.md');
const DESTINO = path.join(docs, 'informe-tecnico.pdf');
const mermaidJs = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');

const escapar = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textoPlano = (html) => html.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
const slug = (t) =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Los títulos de nivel 2 y 3 arman el índice; los bloques ```mermaid quedan
// como texto para que Mermaid los dibuje en el navegador.
const indice = [];
const marked = new Marked({ gfm: true });
marked.use({
  renderer: {
    code({ text, lang }) {
      return lang === 'mermaid' ? `<pre class="mermaid">${escapar(text)}</pre>\n` : false;
    },
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      const id = slug(textoPlano(html));
      if (depth === 2 || depth === 3) indice.push({ depth, id, html });
      return `<h${depth} id="${id}">${html}</h${depth}>\n`;
    },
  },
});

let cuerpo = marked.parse(await readFile(ORIGEN, 'utf8'));
// Un párrafo que es solo "*Figura N. ...*" o "*Tabla N. ...*" es un pie.
cuerpo = cuerpo.replace(/<p><em>((?:Figura|Tabla) \d+\.[\s\S]*?)<\/em><\/p>/g, '<p class="pie">$1</p>');
const nav = indice
  .map((h) => `<li class="n${h.depth}"><a href="#${h.id}">${h.html}</a></li>`)
  .join('\n');
cuerpo = cuerpo.replace('<!-- indice -->', `<nav class="indice"><h2 class="sin-salto">Contenido</h2><ol>${nav}</ol></nav>`);

const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<base href="${pathToFileURL(docs).href}/">
<title>LiveMetric — Informe técnico</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
  :root { --tinta: #1b2530; --oro: #9a7208; --gris: #5b6570; --linea: #d6dbe0; --fondo: #f4f6f8; }
  @page { size: A4; margin: 20mm 19mm 20mm 19mm;
    @bottom-left { content: "LiveMetric — Informe técnico"; font: 8pt 'IBM Plex Sans', sans-serif; color: #5b6570; }
    @bottom-right { content: counter(page) " / " counter(pages); font: 8pt 'IBM Plex Sans', sans-serif; color: #5b6570; } }
  @page :first { @bottom-left { content: none; } @bottom-right { content: none; } }
  html { font-family: 'IBM Plex Sans', 'Noto Sans', 'DejaVu Sans', sans-serif; font-size: 10pt; color: var(--tinta); line-height: 1.5; }
  body { margin: 0; }
  h1, h2, h3, h4 { line-height: 1.25; font-weight: 700; break-after: avoid; }
  h2 { font-size: 17pt; margin: 0 0 10pt; padding-bottom: 5pt; border-bottom: 2pt solid var(--oro); break-before: page; }
  h2.sin-salto { break-before: auto; }
  h3 { font-size: 12.5pt; margin: 16pt 0 6pt; }
  h4 { font-size: 10.5pt; margin: 12pt 0 4pt; color: var(--gris); }
  p, li { orphans: 3; widows: 3; }
  p { margin: 0 0 7pt; text-align: justify; hyphens: auto; }
  ul, ol { margin: 0 0 7pt; padding-left: 16pt; }
  li { margin-bottom: 2pt; }
  a { color: inherit; text-decoration: none; border-bottom: 0.5pt solid var(--linea); }
  strong { font-weight: 600; }
  code { font-family: 'IBM Plex Mono', monospace; font-size: 8.6pt; background: var(--fondo); padding: 0 2pt; border-radius: 2pt; }
  pre:not(.mermaid) { font-family: 'IBM Plex Mono', monospace; font-size: 7.8pt; line-height: 1.4; background: var(--fondo);
    border-left: 2pt solid var(--oro); padding: 6pt 8pt; margin: 0 0 9pt; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: inherit; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 10pt; font-size: 8.6pt; line-height: 1.35; }
  thead { display: table-header-group; }
  th { text-align: left; background: var(--tinta); color: #fff; font-weight: 600; padding: 4pt 5pt; }
  td { padding: 3.5pt 5pt; border-bottom: 0.5pt solid var(--linea); vertical-align: top; }
  tr { break-inside: avoid; }
  tbody tr:nth-child(even) td { background: #fafbfc; }
  img { display: block; max-width: 100%; max-height: 205mm; margin: 4pt auto 3pt; break-inside: avoid; }
  pre.mermaid { display: flex; justify-content: center; margin: 4pt 0 3pt; break-inside: avoid; background: none; }
  pre.mermaid svg { max-width: 100% !important; max-height: 215mm; height: auto; }
  /* Las etiquetas de Mermaid son <p> dentro del SVG: sin el estilo de los párrafos del texto. */
  pre.mermaid p { margin: 0; text-align: center; hyphens: none; orphans: 1; widows: 1; }
  .pie { text-align: center; font-size: 8.5pt; color: var(--gris); font-style: italic; margin: 0 0 12pt; }
  blockquote { margin: 0 0 9pt; padding: 5pt 10pt; border-left: 2pt solid var(--linea); color: var(--gris); }
  blockquote p:last-child { margin: 0; }
  /* Portada */
  .portada { height: 255mm; display: flex; flex-direction: column; }
  .portada .marca { font-size: 11pt; letter-spacing: 3pt; color: var(--oro); font-weight: 600; text-transform: uppercase; }
  .portada .titulo { font-size: 34pt; font-weight: 700; margin: 42mm 0 4mm; line-height: 1.1; }
  .portada .subtitulo { font-size: 14pt; color: var(--gris); margin-bottom: 14mm; max-width: 150mm; }
  .portada .curso { font-size: 11pt; border-top: 2pt solid var(--oro); padding-top: 5mm; max-width: 150mm; }
  .portada dl { margin-top: auto; display: grid; grid-template-columns: 38mm 1fr; row-gap: 3pt; font-size: 10pt; }
  .portada dt { color: var(--gris); }
  .portada dd { margin: 0; }
  /* Índice */
  .indice ol { list-style: none; padding: 0; margin: 0; }
  .indice li { margin: 0; padding: 0.5pt 0; border-bottom: 0.5pt dotted var(--linea); line-height: 1.3; }
  .indice li.n2 { font-weight: 600; padding-top: 3.5pt; }
  .indice li.n3 { padding-left: 14pt; font-size: 8.8pt; }
  .indice a { border: none; }
</style>
</head>
<body>
${cuerpo}
<script src="${pathToFileURL(mermaidJs).href}"></script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', fontFamily: 'IBM Plex Sans, sans-serif',
    flowchart: { htmlLabels: true, useMaxWidth: true }, sequence: { useMaxWidth: true }, er: { useMaxWidth: true } });
  // Después de las fuentes: Mermaid mide cada etiqueta al dibujar, y con la
  // fuente de reserva las cajas quedarían más chicas que el texto final.
  document.fonts.ready
    .then(() => mermaid.run({ querySelector: 'pre.mermaid' }))
    .then(() => { window.__listo = 'ok'; })
    .catch((e) => { window.__listo = 'error: ' + (e && e.message ? e.message : e); });
</script>
</body>
</html>`;

const carpeta = await mkdtemp(path.join(tmpdir(), 'informe-'));
const archivo = path.join(carpeta, 'informe.html');
await writeFile(archivo, html);

const navegador = await chromium.launch();
try {
  const pagina = await navegador.newPage();
  const errores = [];
  pagina.on('pageerror', (e) => errores.push(e.message));
  await pagina.goto(pathToFileURL(archivo).href, { waitUntil: 'networkidle' });
  await pagina.waitForFunction(() => window.__listo, null, { timeout: 60000 });
  const estado = await pagina.evaluate(() => window.__listo);
  if (estado !== 'ok') throw new Error(`Mermaid no pudo dibujar un diagrama: ${estado}`);
  await pagina.evaluate(() => document.fonts.ready);
  const rotas = await pagina.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')));
  if (rotas.length) throw new Error(`Imágenes que no cargan: ${rotas.join(', ')}`);
  if (errores.length) throw new Error(`Errores en la página: ${errores.join(' | ')}`);
  await pagina.pdf({ path: DESTINO, preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
  console.log(`PDF generado: ${path.relative(process.cwd(), DESTINO)}`);
} finally {
  await navegador.close();
  await rm(carpeta, { recursive: true, force: true });
}

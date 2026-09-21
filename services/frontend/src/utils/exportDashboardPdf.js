import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { DATA_SOURCE_LABELS } from '../components/widgets/labels.js';

// Párrafo introductorio del PDF: qué es este documento, de qué elección y
// tablero viene, y una aclaración importante en un sistema de votación —
// esta exportación es una foto del tablero, no el acta oficial certificada.
export function buildIntro(dashboardName, election, widgets) {
  const count = widgets.length;
  const sources = [...new Set(widgets.map((w) => DATA_SOURCE_LABELS[w.dataSource] || w.dataSource))];
  const electionPart = election
    ? `la elección "${election.title}" (estado: ${election.status})`
    : 'la elección seleccionada';

  return (
    `Este documento es una exportación del tablero de reportes "${dashboardName}" para ${electionPart}, ` +
    `generado desde el panel de LiveMetric. Incluye ${count} widget${count === 1 ? '' : 's'}` +
    (sources.length ? ` con datos de: ${sources.join(', ')}.` : '.') +
    ' Los valores reflejan el estado del sistema en el momento de generar este documento y no reemplazan el ' +
    'acta oficial de escrutinio, que solo se emite una vez certificada la elección.'
  );
}

export function slugify(text) {
  return (text || 'tablero')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'tablero';
}

// Cada Widget muestra un placeholder con la clase "widget-loading" mientras
// su propio fetch está en curso (ver Widget.jsx). Antes de capturar hay que
// esperar a que no quede ninguno, si no el PDF sale con tarjetas a medio
// cargar (carrera real observada: el export podía disparar antes de que
// resolvieran los fetches de cada widget).
async function waitForWidgetsReady(container, timeoutMs = 8000) {
  const start = Date.now();
  while (container.querySelector('.widget-loading')) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // Un frame extra para que Recharts termine de pintar tras el último
  // cambio de estado (los gráficos ya tienen isAnimationActive={false},
  // pero el layout/paint del DOM todavía necesita un tick).
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// Captura `element` (el lienzo de widgets, ya renderizado, retematizado a
// fondo blanco vía la clase "pdf-export-mode" que le pone el llamador antes
// de invocar esta función) como imagen y arma un PDF en A4 con una portada
// de texto (título, metadatos, párrafo introductorio) seguida del tablero,
// paginando verticalmente si no cabe en una sola hoja.
export async function exportDashboardToPdf(element, { title, subtitle, intro, filename }) {
  if (!element) throw new Error('No hay tablero para exportar');

  await waitForWidgetsReady(element);

  const canvas = await html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: 1.5,
    useCORS: true,
  });

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const usableWidth = pageWidth - margin * 2;

  let cursorY = margin;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor(11, 11, 11);
  pdf.text(title || 'Tablero', margin, cursorY);
  cursorY += 7;

  pdf.setFont('helvetica', 'normal');
  if (subtitle) {
    pdf.setFontSize(9.5);
    pdf.setTextColor(90, 90, 90);
    pdf.text(subtitle, margin, cursorY);
    cursorY += 6;
  }

  if (intro) {
    cursorY += 2;
    pdf.setFontSize(9.5);
    pdf.setTextColor(55, 55, 55);
    const introLines = pdf.splitTextToSize(intro, usableWidth);
    pdf.text(introLines, margin, cursorY);
    cursorY += introLines.length * 4.3;
  }

  cursorY += 4;
  pdf.setDrawColor(225, 224, 217);
  pdf.line(margin, cursorY, pageWidth - margin, cursorY);
  cursorY += 6;

  const imgWidthMm = usableWidth;
  const imgHeightMm = (canvas.height * imgWidthMm) / canvas.width;
  const pxPerMm = canvas.width / imgWidthMm;

  const availableFirstPage = pageHeight - cursorY - margin;
  const availableOtherPages = pageHeight - margin * 2;

  let renderedMm = 0;
  let pageIndex = 0;

  while (renderedMm < imgHeightMm - 0.01) {
    const available = pageIndex === 0 ? availableFirstPage : availableOtherPages;
    const sliceMm = Math.min(available, imgHeightMm - renderedMm);
    const sliceHeightPx = Math.max(1, Math.round(sliceMm * pxPerMm));
    const srcYPx = Math.round(renderedMm * pxPerMm);

    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = sliceHeightPx;
    sliceCanvas.getContext('2d').drawImage(
      canvas, 0, srcYPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx
    );

    if (pageIndex > 0) pdf.addPage();
    const y = pageIndex === 0 ? cursorY : margin;
    pdf.addImage(sliceCanvas.toDataURL('image/jpeg', 0.85), 'JPEG', margin, y, imgWidthMm, sliceMm);

    renderedMm += sliceMm;
    pageIndex += 1;
  }

  pdf.save(filename);
}

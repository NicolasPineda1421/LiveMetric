const PDFDocument = require('pdfkit');

const INK = '#1b2530';
const GOLD = '#b8860b';
const MUTED = '#5b6470';
const BORDER = '#d9d0bd';

function pct(votes, total) {
  if (!total) return '0.0%';
  return `${((votes / total) * 100).toFixed(1)}%`;
}

// Genera el ACTA DE ESCRUTINIO OFICIAL de una elección ya certificada y la
// escribe directamente sobre la respuesta HTTP (streaming, sin archivo
// temporal en disco). El contenido del acta es exactamente el mismo dato
// certificado que ya vive en scrutiny_ledger — este módulo solo le da
// forma de documento imprimible, nunca recalcula ni reinterpreta resultados.
function streamActaPdf(res, { election, certification }) {
  const { overall, byTable, winner } = certification.results;
  const totalVotes = certification.total_votes;

  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="acta-escrutinio-eleccion-${election.id}.pdf"`
  );
  doc.pipe(res);

  // ---------- Encabezado ----------
  doc
    .fillColor(INK)
    .fontSize(20)
    .font('Helvetica-Bold')
    .text('ACTA DE ESCRUTINIO ELECTORAL', { align: 'center' });
  doc
    .moveDown(0.2)
    .fontSize(10)
    .font('Helvetica')
    .fillColor(MUTED)
    .text('Generada automáticamente por LiveMetric — Módulo de Escrutinio (Microservicio D)', {
      align: 'center',
    });
  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(BORDER).stroke();
  doc.moveDown(0.8);

  // ---------- Datos de la elección ----------
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Elección: ', { continued: true });
  doc.font('Helvetica').text(election.title);
  doc.font('Helvetica-Bold').text('ID de elección: ', { continued: true });
  doc.font('Helvetica').text(String(election.id));
  doc.font('Helvetica-Bold').text('Certificada el: ', { continued: true });
  doc.font('Helvetica').text(new Date(certification.certified_at).toLocaleString('es-CO'));
  doc.font('Helvetica-Bold').text('Total de votos escrutados: ', { continued: true });
  doc.font('Helvetica').text(String(totalVotes));
  doc.moveDown(1);

  // ---------- Ganador ----------
  if (winner) {
    doc.rect(50, doc.y, 512, 54).fillAndStroke('#f6efd9', GOLD);
    const boxTop = doc.y + 8;
    doc
      .fillColor(INK)
      .fontSize(9)
      .font('Helvetica-Bold')
      .text(winner.tie ? 'RESULTADO: EMPATE EN PRIMER LUGAR' : 'CANDIDATO / OPCIÓN GANADORA', 62, boxTop);
    doc
      .fontSize(14)
      .text(
        `${winner.candidateNumber ? `N.° ${winner.candidateNumber} — ` : ''}${winner.label}`,
        62,
        boxTop + 14
      );
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(MUTED)
      .text(`${winner.votes} votos (${pct(winner.votes, totalVotes)} del total)`, 62, boxTop + 32);
    doc.y = boxTop + 54;
    doc.x = 50;
    doc.moveDown(1.2);
  } else {
    doc.fontSize(10).fillColor(MUTED).text('No se registraron votos en esta elección.');
    doc.moveDown(1);
  }

  // ---------- Resultados globales ----------
  doc.fontSize(13).font('Helvetica-Bold').fillColor(INK).text('Resultados consolidados');
  doc.moveDown(0.4);
  drawTable(
    doc,
    ['N.°', 'Candidato / Opción', 'Votos', '%'],
    overall.map((o) => [o.candidateNumber || '—', o.label, String(o.votes), pct(o.votes, totalVotes)]),
    [40, 300, 80, 92]
  );
  doc.moveDown(1);

  // ---------- Desglose por mesa ----------
  if (byTable && byTable.length > 0) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor(INK).text('Desglose por mesa de votación');
    doc.moveDown(0.3);
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(MUTED)
      .text('Consolidación independiente por puesto y mesa, calculada directamente desde los votos crudos.');
    doc.moveDown(0.4);

    for (const t of byTable) {
      if (doc.y > 680) doc.addPage();
      doc
        .fontSize(11)
        .font('Helvetica-Bold')
        .fillColor(INK)
        .text(`${t.pollingPlace} — ${t.votingTable}  ·  ${t.totalVotes} votos`);
      doc.moveDown(0.2);
      drawTable(
        doc,
        ['N.°', 'Candidato / Opción', 'Votos'],
        t.results.map((r) => [r.candidateNumber || '—', r.label, String(r.votes)]),
        [40, 380, 92],
        { compact: true }
      );
      doc.moveDown(0.6);
    }
  }

  // ---------- Verificación criptográfica ----------
  if (doc.y > 620) doc.addPage();
  doc.moveDown(0.6);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(BORDER).stroke();
  doc.moveDown(0.5);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Verificación de integridad');
  doc.moveDown(0.2);
  doc
    .fontSize(8.5)
    .font('Helvetica')
    .fillColor(MUTED)
    .text(
      'Esta acta forma parte de un libro de escrutinio encadenado por hash SHA-256 (append-only). ' +
        'Cualquier persona puede verificar que ningún acta fue alterada consultando GET /verify en el ' +
        'servicio de Escrutinio, que recalcula la cadena completa desde el origen.'
    );
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('Hash de este acta (record_hash):');
  doc.font('Courier').fontSize(8.5).fillColor(INK).text(certification.record_hash);
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('Hash del acta anterior (previous_hash):');
  doc.font('Courier').fontSize(8.5).fillColor(INK).text(certification.previous_hash);

  // ---------- Firmas ----------
  doc.moveDown(2);
  const sigY = doc.y;
  doc.moveTo(60, sigY).lineTo(260, sigY).strokeColor(INK).stroke();
  doc.moveTo(340, sigY).lineTo(540, sigY).strokeColor(INK).stroke();
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor(MUTED)
    .text('Jurado de mesa (firma)', 60, sigY + 4, { width: 200 })
    .text('Testigo electoral (firma)', 340, sigY + 4, { width: 200 });

  // ---------- Pie de página ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `LiveMetric · Acta generada automáticamente · Página ${i + 1} de ${range.count}`,
        50,
        730,
        { align: 'center', width: 512, lineBreak: false }
      );
  }

  doc.end();
}

// Dibuja una tabla simple con encabezado sombreado. No usa librerías extra:
// pdfkit no trae tablas nativas, así que se calculan las celdas a mano.
function drawTable(doc, headers, rows, colWidths, opts = {}) {
  const startX = 50;
  const rowHeight = opts.compact ? 16 : 20;
  let y = doc.y;

  doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(INK);
  let x = startX;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff');
  headers.forEach((h, i) => {
    doc.text(h, x + 6, y + (opts.compact ? 4 : 6), { width: colWidths[i] - 8 });
    x += colWidths[i];
  });
  y += rowHeight;

  doc.font('Helvetica').fontSize(9);
  rows.forEach((row, rIdx) => {
    if (y > 730) {
      doc.addPage();
      y = 50;
    }
    if (rIdx % 2 === 1) {
      doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill('#f3ede0');
    }
    x = startX;
    doc.fillColor(INK);
    row.forEach((cellText, i) => {
      doc.text(cellText, x + 6, y + (opts.compact ? 4 : 6), { width: colWidths[i] - 8 });
      x += colWidths[i];
    });
    y += rowHeight;
  });

  doc.rect(startX, doc.y, colWidths.reduce((a, b) => a + b, 0), y - doc.y).strokeColor(BORDER).stroke();
  doc.x = startX;
  doc.y = y;
}

module.exports = { streamActaPdf };

const { GENESIS_HASH, computeRecordHash } = require('./hashChain');
const { signatureStatus } = require('./actaSignature');

// Verifica el libro de actas completo, en el orden en que se certificaron
// (filas de scrutiny_ledger ordenadas por id). Por cada acta: si su
// contenido coincide con su hash (hashOk), si enlaza con la anterior
// (linkOk) y el estado de su firma digital (ver actaSignature.js). El
// veredicto de cada acta es:
//   'verificada'  hash, enlace y firma correctos, y nada roto antes que ella
//   'sin_firma'   hash y enlace correctos pero sin firma (certificada antes
//                 de la firma digital): íntegra frente a la cadena, pero sin
//                 prueba de que la emitió esta instalación
//   'alterada'    cualquier otra cosa; "problems" dice qué, en palabras
function verifyLedger(rows, publicKey, keyId) {
  let expectedPrevious = GENESIS_HASH;
  let firstBroken = null;

  return rows.map((row) => {
    const electionId = Number(row.election_id);
    const hashOk =
      computeRecordHash({
        previousHash: row.previous_hash,
        electionId: row.election_id,
        totalVotes: row.total_votes,
        results: row.results,
      }) === row.record_hash;
    const linkOk = row.previous_hash === expectedPrevious;
    const signature = signatureStatus(row, publicKey, keyId);

    const problems = [];
    if (!hashOk) problems.push('El contenido del acta no coincide con su hash: fue modificada después de certificarse.');
    if (!linkOk) problems.push('El acta no enlaza con la anterior: la cadena se rompe justo en esta acta.');
    if (signature === 'invalida') {
      problems.push('La firma digital no corresponde al acta: se cambió su hash o su firma después de certificarla.');
    }
    if (signature === 'otra_clave') {
      problems.push('El acta dice estar firmada con una clave que esta instalación no reconoce.');
    }
    const ownOk = problems.length === 0;
    if (firstBroken !== null) {
      problems.push(`La cadena ya está rota antes de esta acta (elección #${firstBroken}), así que su historial no es confiable.`);
    }

    let verdict = 'alterada';
    if (!problems.length) verdict = signature === 'valida' ? 'verificada' : 'sin_firma';

    if (!ownOk && firstBroken === null) firstBroken = electionId;
    expectedPrevious = row.record_hash;
    return { electionId, title: row.title, certifiedAt: row.certified_at, hashOk, linkOk, signature, verdict, problems };
  });
}

module.exports = { verifyLedger };

const crypto = require('crypto');

const GENESIS_HASH = '0'.repeat(64); // hash "cero" para el primer registro de la cadena

// Serialización determinística: mismo input SIEMPRE produce el mismo string,
// sin importar el orden de las llaves del objeto (JSON.stringify normal NO
// garantiza esto). Es indispensable para que el hash sea reproducible por
// cualquiera que quiera auditar el resultado de forma independiente.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `"${k}":${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// record_hash = SHA256(previous_hash + electionId + totalVotes + resultados_serializados)
function computeRecordHash({ previousHash, electionId, totalVotes, results }) {
  const payload = `${previousHash}|${electionId}|${totalVotes}|${stableStringify(results)}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { GENESIS_HASH, computeRecordHash, stableStringify };

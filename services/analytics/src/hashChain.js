const crypto = require('crypto');

// Copia EXACTA del algoritmo de services/scrutiny/src/hashChain.js. Esta a
// proposito en analytics y no se le pregunta a scrutiny-service: la
// "integridad del acta" (ver advancedStats.js) la verifica un servicio
// distinto del que la certifico, recalculando cada hash por su cuenta. Si
// el algoritmo de scrutiny cambia, este tiene que cambiar igual (lo vigila
// la prueba "hashChain de analytics coincide con el de scrutiny").

const GENESIS_HASH = '0'.repeat(64); // hash "cero" para el primer registro de la cadena

// Serialización determinística: mismo input SIEMPRE produce el mismo string,
// sin importar el orden de las llaves del objeto (JSON.stringify normal NO
// garantiza esto).
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

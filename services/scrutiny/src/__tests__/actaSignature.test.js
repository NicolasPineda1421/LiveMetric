// Pruebas unitarias de la firma digital de las actas (actaSignature.js) y
// de la verificación del libro completo (ledgerVerification.js): funciones
// puras, sin base de datos, con un par de claves propio de estas pruebas.
const crypto = require('crypto');
const {
  loadPrivateKey,
  loadPublicKey,
  keyIdOf,
  signRecordHash,
  signatureStatus,
} = require('../actaSignature');
const { verifyLedger } = require('../ledgerVerification');
const { GENESIS_HASH, computeRecordHash } = require('../hashChain');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const keyId = keyIdOf(publicKey);
const base64 = (base64url) => Buffer.from(base64url, 'base64url').toString('base64');

// Un acta firmada como lo hace scrutiny-service al certificar.
function acta({ electionId, previousHash, votes, key = privateKey }) {
  const results = { overall: [{ optionId: 1, label: 'A', votes }], byTable: [], winner: null };
  const recordHash = computeRecordHash({ previousHash, electionId, totalVotes: votes, results });
  return {
    election_id: electionId,
    total_votes: votes,
    results,
    previous_hash: previousHash,
    record_hash: recordHash,
    signature: key ? signRecordHash(key, recordHash) : null,
    signing_key_id: key ? keyIdOf(crypto.createPublicKey(key)) : null,
  };
}

describe('actaSignature', () => {
  it('lee las claves del .env (32 bytes en base64) y firma lo que verifica la pública', () => {
    const priv = loadPrivateKey(base64(privateKey.export({ format: 'jwk' }).d));
    const pub = loadPublicKey(base64(publicKey.export({ format: 'jwk' }).x));
    expect(keyIdOf(pub)).toBe(keyId);
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    const hash = 'ab'.repeat(32);
    expect(signatureStatus({ record_hash: hash, signature: signRecordHash(priv, hash), signing_key_id: keyId }, pub)).toBe('valida');
  });

  it('rechaza claves que no son de 32 bytes', () => {
    expect(() => loadPrivateKey('')).toThrow(/ACTA_SIGNING_KEY/);
    expect(() => loadPublicKey(crypto.randomBytes(16).toString('base64'))).toThrow(/ACTA_PUBLIC_KEY/);
  });

  it('distingue firma inválida, de otra clave y ausente', () => {
    const row = acta({ electionId: 1, previousHash: GENESIS_HASH, votes: 3 });
    expect(signatureStatus({ ...row, record_hash: 'cd'.repeat(32) }, publicKey)).toBe('invalida');
    expect(signatureStatus({ ...row, signature: 'no-es-una-firma' }, publicKey)).toBe('invalida');
    expect(signatureStatus({ ...row, signing_key_id: '0'.repeat(16) }, publicKey)).toBe('otra_clave');
    expect(signatureStatus({ ...row, signature: null }, publicKey)).toBe('sin_firma');
  });
});

describe('verifyLedger', () => {
  function ledger() {
    const first = acta({ electionId: 1, previousHash: GENESIS_HASH, votes: 3 });
    const second = acta({ electionId: 2, previousHash: first.record_hash, votes: 5 });
    return [first, second];
  }

  it('actas encadenadas y firmadas → "verificada"', () => {
    expect(verifyLedger(ledger(), publicKey, keyId).map((r) => r.verdict)).toEqual(['verificada', 'verificada']);
  });

  it('un acta modificada sin rehacer su hash → "alterada", y las siguientes pierden confianza', () => {
    const rows = ledger();
    rows[0].results.overall[0].votes = 99;
    const [first, second] = verifyLedger(rows, publicKey, keyId);
    expect(first).toMatchObject({ verdict: 'alterada', hashOk: false, signature: 'valida' });
    expect(second.verdict).toBe('alterada');
    expect(second.problems.join(' ')).toMatch(/rota antes de esta acta \(elección #1\)/);
  });

  it('actas sin firma y sin problemas → "sin_firma", nunca "verificada"', () => {
    const first = acta({ electionId: 1, previousHash: GENESIS_HASH, votes: 3, key: null });
    const [record] = verifyLedger([first], publicKey, keyId);
    expect(record).toMatchObject({ verdict: 'sin_firma', signature: 'sin_firma', problems: [] });
  });
});

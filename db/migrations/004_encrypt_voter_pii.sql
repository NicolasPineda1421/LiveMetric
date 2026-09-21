-- Migración 004: prepara "voters" para guardar cedula/polling_place/
-- voting_table cifrados (AES-256-GCM, ver services/auth/src/voterCrypto.js).
-- "full_name" queda sin tocar, en texto plano.
--
-- Esto es SOLO el cambio de esquema (ensanchar columnas para que quepa el
-- texto cifrado en base64, más largo que el original). Los datos ya
-- existentes se re-escriben aparte, corriendo UNA vez:
--   docker compose run --rm auth-service node src/scripts/backfillVoterEncryption.js
-- (después de este ALTER TABLE, y de que VOTERS_ENCRYPTION_KEY ya esté en
-- el entorno de auth-service y analytics-service, y ANTES de desplegar el
-- código nuevo que ya asume que estas columnas vienen cifradas).

ALTER TABLE voters ALTER COLUMN cedula TYPE TEXT;
ALTER TABLE voters ALTER COLUMN polling_place TYPE TEXT;
ALTER TABLE voters ALTER COLUMN voting_table TYPE TEXT;

-- Migración 005: firma digital (Ed25519) de las actas de escrutinio.
--
-- scrutiny-service firma el record_hash de cada acta nueva con su clave
-- privada (ACTA_SIGNING_KEY) y guarda la firma y el id de la clave pública
-- que la verifica (ACTA_PUBLIC_KEY). Ver services/scrutiny/src/actaSignature.js.
--
-- db/init.sql ya incluye estas columnas: esto solo hace falta para una base
-- creada con una versión anterior. Es seguro re-ejecutarlo.
--
-- Las actas que ya existían quedan SIN firma, a propósito: la tabla es
-- append-only (el trigger prevent_row_mutation bloquea UPDATE), y firmarlas
-- ahora sería certificar como auténtico algo que no se firmó al momento de
-- certificarlo. El panel las muestra como "Sin firma digital", distintas de
-- las verificadas.

ALTER TABLE scrutiny_ledger ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE scrutiny_ledger ADD COLUMN IF NOT EXISTS signing_key_id CHAR(16);

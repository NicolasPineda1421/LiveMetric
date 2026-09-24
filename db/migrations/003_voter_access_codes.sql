-- Migración 003: reemplaza "cédula como contraseña" por un PIN de acceso
-- real, asignado por el administrador al cargar el padrón (no hay registro
-- de cuentas self-service). Aditiva y segura de re-ejecutar.

ALTER TABLE voters ADD COLUMN IF NOT EXISTS access_code_hash TEXT;

-- Los votantes cargados ANTES de esta migración quedan con
-- access_code_hash NULL: no podrán iniciar sesión hasta que un admin les
-- genere un PIN (botón "Regenerar PIN" en la pestaña Padrón, o
-- POST /admin/voters/:id/reset-pin). Es intencional: fallar cerrado en vez
-- de dejarlos entrar con la cédula como antes.

-- Esto incluye a los 5 votantes de demostración de db/init.sql: ningún
-- archivo del repositorio asigna un PIN (ni su hash). Para probar con ellos,
-- un admin les genera uno desde la pestaña "Padrón".

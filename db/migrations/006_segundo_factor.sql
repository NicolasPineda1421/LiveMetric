-- Migración 006: segundo factor del votante (TOTP) y voto asistido.
--
-- El votante entra con cédula + PIN y, además, con el código de 6 dígitos
-- de su app autenticadora (Microsoft Authenticator, Google Authenticator,
-- Authy: TOTP, RFC 6238), que registra en su primer ingreso. Quien no puede
-- usar una app vota "asistido": el jurado de su mesa verifica su cédula en
-- persona y autoriza el ingreso con el código de SU autenticador. El jurado
-- es de una mesa, o de todo su puesto si no tiene mesa. Ver
-- services/auth/src/totp.js y las rutas /login/voter/* de auth-service.
--
-- db/init.sql ya incluye todo esto: solo hace falta para una base creada con
-- una versión anterior. Es seguro re-ejecutarlo.

ALTER TABLE voters ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE voters ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
ALTER TABLE voters ADD COLUMN IF NOT EXISTS assisted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE admins ADD COLUMN IF NOT EXISTS polling_place TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS voting_table TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;

-- El rol "jurado" se suma a los existentes. Las bases viejas tienen el CHECK
-- del rol con el nombre que le dio PostgreSQL (o la migración 002): se
-- reemplazan todos los CHECK de la tabla que mencionan el rol.
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'admins'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%role%'
    LOOP
        EXECUTE format('ALTER TABLE admins DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

ALTER TABLE admins ADD CONSTRAINT admins_role_check
    CHECK (role IN ('admin', 'auditor', 'jurado'));
ALTER TABLE admins ADD CONSTRAINT admins_jurado_mesa_check
    CHECK (role <> 'jurado' OR polling_place IS NOT NULL);

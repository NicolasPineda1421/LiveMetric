-- Migración 007: vencimiento del PIN del votante.
--
-- El PIN que entrega el administrador vence en una fecha que se elige al
-- generarlo (por defecto, el cierre de la última elección programada), y
-- además solo sirve mientras hay una votación abierta o desde una hora antes
-- de que abra (esa regla vive en auth-service, /login/voter). Así un PIN
-- filtrado no sirve fuera de la votación, y uno viejo no sirve en elecciones
-- futuras.
--
-- Los PIN generados antes de esta migración quedan sin fecha (NULL): siguen
-- funcionando, pero solo durante la votación. Regenerarlos les pone fecha.
--
-- db/init.sql ya incluye la columna: solo hace falta para una base creada con
-- una versión anterior. Es seguro re-ejecutarlo.

ALTER TABLE voters ADD COLUMN IF NOT EXISTS access_code_expires_at TIMESTAMPTZ;

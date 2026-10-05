-- Migración 007: vencimiento del PIN del votante.
--
-- El PIN que entrega el administrador vence en una fecha que se elige al
-- generarlo (por defecto, el cierre de la última elección programada). Así
-- uno viejo no sirve en elecciones futuras. (Esta versión además lo limitaba
-- a la ventana de la votación; esa regla se quitó: ver la migración 008.
-- Hoy no hay fecha para elegir: vence PIN_VIGENCIA_HORAS después de
-- generarlo, ver services/auth/src/vigenciaPin.js.)
--
-- Los PIN generados antes de esta migración quedan sin fecha (NULL); la
-- migración 008 se la pone.
--
-- db/init.sql ya incluye la columna: solo hace falta para una base creada con
-- una versión anterior. Es seguro re-ejecutarlo.

ALTER TABLE voters ADD COLUMN IF NOT EXISTS access_code_expires_at TIMESTAMPTZ;

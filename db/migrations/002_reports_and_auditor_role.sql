-- Migración 002: rol "auditor" (solo lectura) + tableros de reportes configurables.
--
-- Este proyecto no tiene runner de migraciones: init.sql se corrió una vez a
-- mano contra Supabase. Este archivo se debe correr también a mano (psql o
-- el SQL Editor de Supabase) contra la misma base. Es seguro re-ejecutarlo:
-- usa IF NOT EXISTS / guarda condicional para el ALTER TABLE.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'admins' AND column_name = 'role'
    ) THEN
        ALTER TABLE admins
            ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'admin'
                CHECK (role IN ('admin', 'auditor'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS report_dashboards (
    id           SERIAL PRIMARY KEY,
    election_id  INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    name         VARCHAR(120) NOT NULL,
    layout       JSONB NOT NULL DEFAULT '{"widgets": []}'::jsonb,
    created_by   INTEGER REFERENCES admins(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_dashboards_election ON report_dashboards(election_id);

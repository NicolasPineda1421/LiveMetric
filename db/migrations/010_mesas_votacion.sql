-- Migración 010: las mesas de votación creadas desde la pestaña "Puestos".
--
-- Una mesa existe en el padrón cuando algún votante la tiene (va cifrada en
-- "voters", como el puesto). Esta tabla guarda las que el administrador crea
-- antes de tener votantes, para asignarles votantes y jurados. El panel
-- muestra las dos juntas, reconocidas por "clave": la mesa sin mayúsculas,
-- tildes ni el prefijo "Mesa" ("1" y "Mesa 1" son la misma; ver
-- services/auth/src/lugares.js). "puesto_clave" es la clave del puesto, el
-- mismo criterio de puestos_votacion: no es una llave foránea, porque un
-- puesto del padrón puede no tener ubicación todavía.
--
-- No va cifrada: dice qué mesas tiene un puesto, no quién vota en ellas.
--
-- Es seguro re-ejecutarlo.

CREATE TABLE IF NOT EXISTS mesas_votacion (
    id            SERIAL PRIMARY KEY,
    puesto_clave  VARCHAR(150) NOT NULL,
    nombre        VARCHAR(50)  NOT NULL,
    clave         VARCHAR(50)  NOT NULL,
    created_by    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT mesas_puesto_clave_unica UNIQUE (puesto_clave, clave)
);

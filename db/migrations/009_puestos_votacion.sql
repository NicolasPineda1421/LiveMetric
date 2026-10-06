-- Migración 009: la ubicación de cada puesto de votación.
--
-- Cada puesto tiene país, departamento, municipio, localidad (opcional) y
-- zona (urbana o rural). El departamento y el municipio salen de la
-- Divipola del DANE: se guarda el código del municipio y los nombres
-- oficiales (ver services/auth/src/divipola.js). "clave" es el nombre del
-- puesto sin mayúsculas, tildes ni espacios de más, el mismo criterio con
-- el que el padrón reconoce un puesto escrito de otra forma: por eso un
-- nombre identifica a un solo puesto en todo el país, y dos puestos de
-- municipios distintos necesitan nombres distintos.
--
-- No va cifrada, a diferencia del puesto de cada votante: dice dónde queda
-- un puesto, no quién vota en él. Los puestos que ya estaban en el padrón
-- quedan sin ubicación hasta que un administrador la complete en la
-- pestaña "Puestos".
--
-- Es seguro re-ejecutarlo.

CREATE TABLE IF NOT EXISTS puestos_votacion (
    id                SERIAL PRIMARY KEY,
    nombre            VARCHAR(150) NOT NULL,
    clave             VARCHAR(150) NOT NULL UNIQUE,
    pais              VARCHAR(60)  NOT NULL DEFAULT 'Colombia',
    codigo_municipio  CHAR(5)      NOT NULL,
    departamento      VARCHAR(80)  NOT NULL,
    municipio         VARCHAR(80)  NOT NULL,
    localidad         VARCHAR(80),
    zona              VARCHAR(6)   NOT NULL,
    created_by        INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT puestos_zona_check CHECK (zona IN ('urbana', 'rural')),
    CONSTRAINT puestos_codigo_municipio_check CHECK (codigo_municipio ~ '^[0-9]{5}$')
);

-- LiveMetric - Esquema de base de datos
-- Se ejecuta automáticamente al primer arranque del contenedor de PostgreSQL

CREATE TABLE IF NOT EXISTS admins (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  UNIQUE NOT NULL,
    password_hash TEXT         NOT NULL,          -- bcrypt hash, nunca texto plano
    role          VARCHAR(20)  NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'auditor')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Padrón electoral: votantes pre-cargados por un administrador. El login es
-- cédula + un PIN de acceso (columna "access_code_hash", ver migración
-- 003_voter_access_codes.sql): el admin lo genera al cargar el padrón y lo
-- distribuye en el puesto de votación. No hay registro de cuentas
-- self-service; la cédula solo identifica, el PIN es el secreto real. Ver
-- docs/decisiones-y-riesgos.md para el análisis de riesgo y los controles
-- compensatorios (rate limiting agresivo, JWT de vida muy corta, y que el
-- anti-doble-voto se ancle a la identidad real en vez de a un fingerprint).
--
-- "polling_place" (puesto de votación) y "voting_table" (mesa de votación)
-- identifican DÓNDE está habilitado cada votante. Estos dos valores viajan
-- luego dentro del JWT de votante y se copian a cada voto emitido (ver
-- "votes" más abajo), para que el escrutinio pueda consolidar el conteo
-- por mesa sin necesitar jamás la cédula del votante.
-- ---------------------------------------------------------------------------

-- "cedula", "polling_place" y "voting_table" se guardan CIFRADOS (AES-256-GCM,
-- ver services/auth/src/voterCrypto.js) con una clave que solo conocen
-- auth-service y analytics-service (VOTERS_ENCRYPTION_KEY). "full_name" es
-- la única columna de datos del votante que queda en texto plano. Por eso
-- son TEXT y no VARCHAR corto: el texto cifrado en base64 ocupa más que el
-- original.
CREATE TABLE IF NOT EXISTS voters (
    id                SERIAL PRIMARY KEY,
    cedula            TEXT UNIQUE NOT NULL,
    full_name         VARCHAR(200) NOT NULL,
    polling_place     TEXT NOT NULL,
    voting_table      TEXT NOT NULL,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    access_code_hash  TEXT,                          -- bcrypt del PIN; NULL hasta que un admin lo genere
    created_by        INTEGER REFERENCES admins(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voters_cedula ON voters(cedula);

-- ---------------------------------------------------------------------------
-- Plantillas: separan "la pregunta" de "cuándo se vota". Pueden ser
-- "generic" (una pregunta con opciones de texto libre, como antes) o
-- "presidential" (formato de elección presidencial: cada opción es un
-- candidato con número, nombre y logo/foto). El admin arma una plantilla
-- una vez y la reutiliza para instanciar elecciones concretas.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS election_templates (
    id             SERIAL PRIMARY KEY,
    name           VARCHAR(200) NOT NULL,
    description    TEXT,
    template_type  VARCHAR(20) NOT NULL DEFAULT 'generic'
                   CHECK (template_type IN ('generic', 'presidential')),
    created_by     INTEGER REFERENCES admins(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "candidate_number" y "logo" solo se usan en plantillas "presidential";
-- quedan NULL en plantillas "generic". "logo" almacena una imagen como
-- data URI base64 (ej. "data:image/png;base64,...") directamente en la
-- fila: coherente con Local-First (sin bucket S3/MinIO externo) y
-- suficiente para el tamaño de archivo de un logo de candidato.
CREATE TABLE IF NOT EXISTS template_options (
    id               SERIAL PRIMARY KEY,
    template_id      INTEGER REFERENCES election_templates(id) ON DELETE CASCADE,
    label            VARCHAR(150) NOT NULL,
    candidate_number VARCHAR(10),
    logo             TEXT
);

-- ---------------------------------------------------------------------------
-- Elecciones: instancias con ventana de tiempo obligatoria. "status" es
-- gestionado por el worker scheduler (scheduled -> active -> closed) y
-- también puede pasar directo a "closed" si un admin la detiene
-- manualmente antes de tiempo (ver /admin/elections/:id/stop en Voting). La
-- columna se usa también como defensa adicional en las validaciones del
-- servicio Voting (defensa en profundidad, junto con las marcas de tiempo).
-- ---------------------------------------------------------------------------

CREATE TYPE election_status AS ENUM ('scheduled', 'active', 'closed');

CREATE TABLE IF NOT EXISTS elections (
    id               SERIAL PRIMARY KEY,
    title            VARCHAR(200) NOT NULL,
    template_id      INTEGER REFERENCES election_templates(id),
    status           election_status NOT NULL DEFAULT 'scheduled',
    scheduled_start  TIMESTAMPTZ NOT NULL,
    scheduled_end    TIMESTAMPTZ NOT NULL,
    stopped_manually BOOLEAN NOT NULL DEFAULT false,
    created_by       INTEGER REFERENCES admins(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valid_time_window CHECK (scheduled_end > scheduled_start)
);

-- Snapshot de las opciones/candidatos de la plantilla EN EL MOMENTO en que
-- se instanció la elección (si luego se edita la plantilla, las elecciones
-- ya creadas no cambian retroactivamente).
CREATE TABLE IF NOT EXISTS election_options (
    id               SERIAL PRIMARY KEY,
    election_id          INTEGER REFERENCES elections(id) ON DELETE CASCADE,
    label            VARCHAR(150) NOT NULL,
    candidate_number VARCHAR(10),
    logo             TEXT
);

-- ---------------------------------------------------------------------------
-- Votos: "voter_id_hash" es SHA-256(cedula + salt-privado-de-Auth), calculado
-- UNA sola vez por Auth al emitir el JWT de votante y propagado dentro del
-- token. Voting nunca ve la cédula en texto plano ni conoce el salt: solo
-- lee este hash ya calculado desde el JWT verificado. La restricción UNIQUE
-- sobre (election_id, voter_id_hash) es lo que garantiza "un votante, un voto"
-- por identidad real, en vez de por huella de IP/navegador.
--
-- "polling_place" y "voting_table" viajan también en el JWT de votante
-- (copiados del padrón por Auth al momento del login) y se graban en cada
-- voto para que el escrutinio pueda consolidar el conteo por mesa SIN
-- volver a tocar la tabla "voters" ni la cédula del votante.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS votes (
    id             SERIAL PRIMARY KEY,
    election_id        INTEGER REFERENCES elections(id) ON DELETE CASCADE,
    option_id      INTEGER REFERENCES election_options(id) ON DELETE CASCADE,
    voter_id_hash  CHAR(64) NOT NULL,
    polling_place  VARCHAR(150) NOT NULL,
    voting_table   VARCHAR(50) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_vote_per_election UNIQUE (election_id, voter_id_hash)
);

CREATE INDEX IF NOT EXISTS idx_votes_election_id ON votes(election_id);
CREATE INDEX IF NOT EXISTS idx_votes_option_id ON votes(option_id);
CREATE INDEX IF NOT EXISTS idx_votes_table ON votes(election_id, voting_table);
CREATE INDEX IF NOT EXISTS idx_polls_status_window ON elections(status, scheduled_start, scheduled_end);

-- ---------------------------------------------------------------------------
-- Tableros de reportes: builder tipo Power BI, por elección. "layout" es el
-- arreglo de widgets (tipo, fuente de datos, posición en la grilla) que arma
-- el admin; ver services/analytics para las fuentes de datos disponibles.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Escrutinio: libro de actas append-only. Cada fila certifica el resultado
-- FINAL de una elección ya cerrada, con un hash SHA-256 encadenado al
-- resultado certificado anterior (estilo blockchain simple).
--
-- "results" ahora guarda una estructura enriquecida (no solo un arreglo
-- plano), para que el acta consolide el conteo por mesa y determine un
-- ganador:
--   {
--     "overall":  [{optionId, candidateNumber, label, logo, votes}, ...],
--     "byTable":  [{pollingPlace, votingTable, totalVotes,
--                   results:[{optionId, candidateNumber, label, votes}]}, ...],
--     "winner":   {optionId, candidateNumber, label, votes, tie, tiedWith}
--   }
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scrutiny_ledger (
    id              SERIAL PRIMARY KEY,
    election_id         INTEGER NOT NULL UNIQUE REFERENCES elections(id),
    total_votes     INTEGER NOT NULL,
    results         JSONB NOT NULL,
    previous_hash   CHAR(64) NOT NULL,        -- hash del registro anterior (o "genesis")
    record_hash     CHAR(64) NOT NULL,        -- sha256(previous_hash + election_id + results + total_votes)
    certified_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scrutiny_election_id ON scrutiny_ledger(election_id);

-- ---------------------------------------------------------------------------
-- Auditoría: registro inmutable de eventos de inicio de sesión y de gestión
-- de identidad (creación de admins, carga del padrón, detener una elección).
-- Mitiga la categoría STRIDE "Repudiation": nadie puede negar haber
-- intentado entrar al sistema, ni un admin puede negar haber creado un
-- usuario, cargado votantes o detenido una elección.
--
-- Importante: "actor_ref" NUNCA contiene una cédula en texto plano. Para
-- votantes se guarda el mismo voter_id_hash usado en "votes"; para intentos
-- fallidos de login de votante (cédula que no existe en el padrón) se guarda
-- un hash del valor recibido, nunca el valor crudo.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    event_type  VARCHAR(50) NOT NULL,   -- LOGIN_SUCCESS_ADMIN, LOGIN_FAILURE_VOTER, ADMIN_USER_CREATED, VOTERS_BULK_UPLOADED, POLL_STOPPED_MANUALLY, ...
    actor_type  VARCHAR(10) NOT NULL,   -- 'admin' | 'voter' | 'system'
    actor_ref   VARCHAR(100),           -- username (admin) o hash (voter); nunca PII cruda
    ip_address  VARCHAR(64),
    user_agent  TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ref ON audit_log(actor_ref);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Función genérica de "append-only": se reutiliza en scrutiny_ledger y en
-- audit_log. Ni siquiera con las credenciales de aplicación se puede
-- modificar o borrar un registro ya escrito.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_row_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% es append-only: % no está permitido', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scrutiny_no_update ON scrutiny_ledger;
CREATE TRIGGER trg_scrutiny_no_update
    BEFORE UPDATE OR DELETE ON scrutiny_ledger
    FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_log;
CREATE TRIGGER trg_audit_no_update
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Nota: no se hardcodea ningún admin/contraseña ni cédula real aquí. Los
-- administradores y el padrón se cargan mediante los endpoints /admin/*
-- de Auth, ya autenticados con JWT de administrador.

-- ---------------------------------------------------------------------------
-- SEED de arranque: para que el sistema sea usable con solo "docker compose
-- up", se crea UN admin por defecto y datos de demostración. Esto es
-- SOLO para entorno local de evaluación/desarrollo (Local-First), nunca
-- para producción real. Es un riesgo aceptado y documentado explícitamente
-- en docs/decisiones-y-riesgos.md.
--
--   usuario:    admin
--   contraseña: Admin123!
--
-- El hash de abajo corresponde exactamente a esa contraseña (bcrypt, costo 12).
-- ---------------------------------------------------------------------------

INSERT INTO admins (username, password_hash)
VALUES ('admin', '$2b$12$YLIAL2uDCaAs5y/mwRj6WuNCk/dmxsNyZitdBPlvTi/Tqyn598bHS')
ON CONFLICT (username) DO NOTHING;

-- Padrón de demostración: 5 cédulas ficticias, repartidas en 2 mesas de un
-- mismo puesto, para que el acta de escrutinio tenga algo real que
-- consolidar entre mesas al certificar una elección de prueba. Mismo riesgo
-- aceptado que el admin de arriba: PIN fijo "123456", solo para demo local.
--
-- IMPORTANTE en una instalación NUEVA: este INSERT no puede cifrar
-- "cedula"/"polling_place"/"voting_table" (ese SQL no conoce
-- VOTERS_ENCRYPTION_KEY, que se genera por instalación). Quedan en texto
-- plano hasta que se corra, una vez levantado el stack:
--   docker compose run --rm auth-service node src/scripts/backfillVoterEncryption.js
-- Ese script detecta cualquier valor sin cifrar (de este seed, o de datos
-- previos a esta migración) y lo cifra en el sitio; es seguro correrlo
-- más de una vez.
INSERT INTO voters (cedula, full_name, polling_place, voting_table, access_code_hash, created_by)
SELECT v.cedula, v.full_name, v.polling_place, v.voting_table,
       '$2a$12$Ggbitu7PTzh/kWQEfrN77O6Dpx.3ZaXnIJen37XVNuLYOTSQU0Yru', -- bcrypt('123456')
       (SELECT id FROM admins WHERE username = 'admin')
FROM (VALUES
    ('1000000001', 'Votante Demo Uno',     'Puesto Central', 'Mesa 1'),
    ('1000000002', 'Votante Demo Dos',     'Puesto Central', 'Mesa 1'),
    ('1000000003', 'Votante Demo Tres',    'Puesto Central', 'Mesa 2'),
    ('1000000004', 'Votante Demo Cuatro',  'Puesto Central', 'Mesa 2'),
    ('1000000005', 'Votante Demo Cinco',   'Puesto Norte',   'Mesa 1')
) AS v(cedula, full_name, polling_place, voting_table)
ON CONFLICT (cedula) DO NOTHING;

-- Plantilla genérica de demostración (formato libre, como antes).
INSERT INTO election_templates (id, name, description, template_type, created_by)
VALUES (1, 'Elección de ejemplo', 'Plantilla genérica de demostración', 'generic', (SELECT id FROM admins WHERE username = 'admin'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO template_options (template_id, label)
SELECT 1, label FROM (VALUES ('Opción A'), ('Opción B'), ('Opción C')) AS o(label)
WHERE NOT EXISTS (SELECT 1 FROM template_options WHERE template_id = 1);

-- Plantilla presidencial de demostración: 3 candidatos con número y nombre
-- (sin logo precargado; se puede editar/crear una nueva con fotos reales
-- desde la pestaña "Plantillas" del panel de administración).
INSERT INTO election_templates (id, name, description, template_type, created_by)
VALUES (2, 'Elección Presidencial de Ejemplo', 'Plantilla en formato de elección presidencial', 'presidential', (SELECT id FROM admins WHERE username = 'admin'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO template_options (template_id, label, candidate_number)
SELECT 2, label, candidate_number
FROM (VALUES
    ('Candidato Demo Uno', '1'),
    ('Candidato Demo Dos', '2'),
    ('Candidato Demo Tres', '3')
) AS o(label, candidate_number)
WHERE NOT EXISTS (SELECT 1 FROM template_options WHERE template_id = 2);

-- Evita colisiones de secuencia tras los INSERT con id explícito arriba.
SELECT setval('election_templates_id_seq', GREATEST((SELECT MAX(id) FROM election_templates), 1));

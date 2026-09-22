# LiveMetric

**Sistema de Elecciones y Votación en Tiempo Real** — arquitectura de microservicios, diseñado bajo un enfoque **Local-First**: todo el stack (aplicación + pipeline DevSecOps) se ejecuta con herramientas open source, sin depender de ningún servicio en la nube.

Proyecto universitario que demuestra un ciclo DevSecOps completo: **Infraestructura como Código → Contenerización segura → Pipeline de seguridad automatizado (shift-left)**.

---

## 1. Arquitectura

LiveMetric permite al administrador **cargar plantillas de elección reutilizables**, **instanciarlas con una ventana de tiempo** (hora de inicio y hora de fin), obtener **resultados certificados automáticamente** al cierre mediante un módulo de escrutinio independiente, y gestionar la identidad de administradores y votantes con **auditoría inmutable** de cada intento de acceso.

```
                                  ┌───────────────┐
                        Navegador │   Frontend    │  http://localhost:3000
                         (SPA) ──▶│  React + nginx│
                                  └───────┬───────┘
                                          │ fetch() directo a cada API (CORS)
                    ┌─────────────────────┼─────────────────────────────────┐
                    │                 app-net (bridge)                       │
                    │                                                        │
   Host :3001 ──▶   │  ┌───────┐  ┌────────┐  ┌───────────┐  ┌──────────┐   │
   Host :3002 ──▶   │  │ Auth  │  │ Voting │  │ Analytics │  │ Scrutiny │   │
   Host :3003 ──▶   │  │(login │  │(templa-│  │  (lee en  │  │ (D: hash │   │
   Host :3004 ──▶   │  │dual + │  │tes+vote│  │ vivo o   │  │  chain)  │   │
                    │  │padrón)│  │+admin) │  │ certific.)│  └────┬─────┘   │
                    │  └───┬───┘  └───┬────┘  └─────┬─────┘       │  ▲     │
                    │      │          │             │             │  │x-internal-token
                    │      │          │             │       ┌─────▼──┴────┐ │
                    │      │          │             │       │  Scheduler  │ │
                    │      │          │             │       │  (worker,   │ │
                    │      │          │             │       │  node-cron, │ │
                    │      │          │             │       │  sin puerto)│ │
                    │      │          │             │       └──────┬──────┘ │
                    └──────┼──────────┼─────────────┼──────────────┼────────┘
                           │          │              │              │
                    ┌──────┼──────────┼──────────────┼──────────────┼────────┐
                    │      │          │  db-net (internal)          │        │
                    │      └──────────┴──────────────┴──────────────┘        │
                    │                          │                             │
                    │                   ┌──────▼──────┐                     │
                    │                   │  PostgreSQL │                     │
                    │                   │ (aislado,   │                     │
                    │                   │ sin acceso  │                     │
                    │                   │ al host, con│                     │
                    │                   │ audit_log)  │                     │
                    │                   └─────────────┘                     │
                    └───────────────────────────────────────────────────────┘
```

### Componentes

| Componente | Responsabilidad | Tecnología | Seguridad clave |
|---|---|---|---|
| **Frontend** | SPA para administradores y votantes | React 18 + Vite, servido por nginx | Sin `localStorage`: la sesión (JWT) vive solo en memoria de React; se pierde al recargar, evitando dejar tokens en equipos compartidos |
| **Microservicio A — Auth** | Login dual (admin y votante), gestión de identidad, auditoría | Node.js / Express | `bcrypt` para admins, hash SHA-256 de cédula para votantes (nunca en texto plano), JWT de votante de vida muy corta, rate limiting agresivo, log de auditoría append-only |
| **Microservicio B — Voting** | Votación pública **+** administración de plantillas (genéricas o **presidenciales** con candidatos) y elecciones, incluyendo detenerlas manualmente (`/admin/*`, JWT admin) | Node.js / Express | Exige JWT de **votante** para votar; ancla el anti-doble-voto a la identidad real (`voter_id_hash`), no a IP/navegador; ventana de tiempo verificada a nivel de query; detener una elección exige el mismo JWT de admin que el resto de `/admin/*` |
| **Microservicio C — Analytics** | Sirve resultados: en vivo si la elección está activa, **certificados** (con desglose por mesa y ganador) si ya cerró | Node.js / Express | Rutas `/api/*` protegidas por JWT; para elecciones cerradas nunca recalcula, sirve el acta ya certificada |
| **Microservicio D — Scrutiny** | Recuento **independiente** desde los votos crudos, consolidación por **mesa de votación**, determinación del **ganador**, y certificación con cadena de hashes SHA-256 | Node.js / Express | `/internal/certify` solo acepta un token de servicio (`X-Internal-Token`, comparación *timing-safe*), nunca un JWT de usuario |
| **Worker — Scheduler** | Proceso asíncrono (`node-cron`) que activa/cierra elecciones según su horario y dispara la certificación | Node.js + `node-cron` | Sin puerto publicado al host; solo se comunica con Scrutiny dentro de `app-net` |
| **PostgreSQL** | Persistencia, incluye el libro de escrutinio y el log de auditoría, ambos append-only | Contenedor Docker aislado | Sin puertos publicados al host; trigger a nivel de motor que bloquea `UPDATE`/`DELETE` sobre `scrutiny_ledger` y `audit_log` |

### Redes Docker

- **`db-net` (internal: true)**: PostgreSQL solo es alcanzable por los microservicios y el worker. No tiene salida a Internet ni es accesible desde el host — mitiga movimiento lateral y exfiltración directa de datos.
- **`app-net` (bridge)**: conecta los servicios entre sí (incluida la llamada interna `scheduler-worker → scrutiny-service`) y expone únicamente los puertos necesarios, y solo en `127.0.0.1` (nunca `0.0.0.0`). El frontend corre en el navegador del usuario, así que llama a cada API directamente por su puerto publicado; por eso cada backend valida `FRONTEND_ORIGIN` vía CORS en vez de aceptar cualquier origen (`*`).

### Gestión de secretos

Ningún secreto (`JWT_SECRET`, contraseñas de BD, `VOTER_ID_SALT`, `INTERNAL_SERVICE_TOKEN`) está hardcodeado en `docker-compose.yml`, `main.tf` ni en el código fuente. Todos se inyectan vía variables de entorno cargadas desde un archivo `.env` **local**, excluido en `.gitignore`. Se provee `.env.example` como plantilla sin valores reales.

**Excepción documentada:** el sistema arranca con un usuario administrador y un padrón de demostración precargados (ver sección 3) para que sea usable con un solo `docker compose up`. Esa credencial **sí** es pública y conocida a propósito — está pensada para cambiarse en el primer uso — y se documenta como riesgo aceptado en la sección 6.

---

## 1.1 Flujo funcional (de punta a punta)

```
0) [SETUP] Admin abre el padrón/plantilla/usuario de arranque (seed en init.sql)
   → usuario admin de arranque (credencial fija, ver db/init.sql)  → cambiar de inmediato (ver sección 3)

1) Admin hace login       → POST /login/admin (Auth)         → JWT rol "admin", ~1h
   Votante hace login     → POST /login/voter (Auth)         → JWT rol "voter", ~10min
   (todo intento, exitoso o fallido, se registra en audit_log sin PII cruda)

2) Admin crea una PLANTILLA en Voting     → POST /admin/templates   (JWT admin)
3) Admin instancia una ELECCIÓN           → POST /admin/elections       (JWT admin)
   con scheduledStart / scheduledEnd      → la elección nace en estado "scheduled"

4) Scheduler-worker (cada minuto, node-cron):
   - si ya llegó scheduledStart  → election pasa a "active"
   - si ya pasó scheduledEnd     → election pasa a "closed"
                                  → llama a Scrutiny: POST /internal/certify/:electionId

5) Mientras está "active": el votante ya autenticado vota → POST /vote (JWT votante)
   - Voting exige status=active Y now() dentro de la ventana horaria
   - triple defensa contra doble voto: JWT de identidad + transacción + UNIQUE en BD
     sobre voter_id_hash (no sobre IP/navegador)

6) Scrutiny, al certificar:
   - recuenta los votos DIRECTO desde la tabla "votes" (recuento independiente)
   - calcula record_hash = SHA256(previous_hash + resultados)
   - inserta el acta en "scrutiny_ledger" (append-only, no editable ni borrable)

7) Analytics, al pedir resultados de esa elección:
   - si sigue "active"  → responde con el conteo en vivo (recalculado siempre)
   - si ya está "closed" → responde con el acta CERTIFICADA de Scrutiny
     (nunca un recálculo propio, para que el número mostrado sea siempre el oficial)

8) Cualquier admin puede pedir GET /verify en Scrutiny para confirmar que
   TODA la cadena de actas es íntegra desde el origen hasta la última elección,
   y GET /admin/audit-log en Auth para revisar quién intentó entrar y cuándo.
```

---

## 2. Estructura del repositorio

```
LiveMetric/
├── docker-compose.yml           # Orquestación local segura
├── .env.example                 # Plantilla de variables de entorno (sin secretos reales)
├── .gitignore
├── .gitleaks.toml                # Config de reglas de Gitleaks
├── db/
│   └── init.sql                 # Esquema + seed de arranque (admin y padrón demo)
├── services/
│   ├── frontend/                 # SPA en React (Vite) + nginx — admin y votantes
│   ├── auth/                    # Microservicio A — login dual, identidad, auditoría
│   ├── voting/                  # Microservicio B — votación + /admin (plantillas y elecciones)
│   ├── analytics/                # Microservicio C — resultados en vivo o certificados
│   ├── scrutiny/                 # Microservicio D — certificación con cadena de hashes SHA-256
│   └── scheduler/                # Worker — node-cron, abre/cierra elecciones y dispara certificación
├── infra/
│   └── terraform/
│       ├── main.tf              # IaC equivalente con provider Docker
│       └── variables.tfvars.example
├── scripts/
│   └── setup-branch-protection.sh  # Aplica branch protection en "main" vía gh CLI
└── .github/
    ├── CODEOWNERS                  # Revisores obligatorios por área
    ├── pull_request_template.md    # Checklist de seguridad en cada PR
    └── workflows/
        └── devsecops.yml           # Pipeline DevSecOps
```

---

## 3. Cómo levantar el entorno local

### Requisitos previos

- Docker y Docker Compose v2
- (Opcional, para la vía IaC) Terraform >= 1.5 y el plugin `kreuzwerker/docker`

### Puesta en marcha (un solo comando)

```bash
git clone <URL_DEL_REPOSITORIO>
cd LiveMetric

# 1. Crear el archivo de variables de entorno local
cp .env.example .env
# Editar .env y reemplazar los cuatro valores "CAMBIA_ESTE_VALOR_LOCALMENTE"
# (JWT_SECRET, VOTER_ID_SALT, INTERNAL_SERVICE_TOKEN, VOTERS_ENCRYPTION_KEY)
# por secretos generados localmente. Usa el comando que corresponda a tu sistema:
```

| Sistema | Comando para generar un secreto |
|---|---|
| macOS / Linux / Git Bash en Windows | `openssl rand -base64 48` |
| Windows PowerShell (sin instalar nada) | `$b=New-Object byte[] 48; [System.Security.Cryptography.RNGCryptoServiceProvider]::new().GetBytes($b); [Convert]::ToBase64String($b)` |
| Cualquier sistema con Node.js | `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |

Genera un valor **distinto** para cada uno de esos tres secretos (no reutilices el mismo).

`VOTERS_ENCRYPTION_KEY` es distinto: tiene que decodificar a **exactamente 32 bytes** (es una clave AES-256), no cualquier longitud sirve. Genéralo así:

```bash
openssl rand -base64 32
# o, con Node.js: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
# 2. Levantar todo el stack (backend + worker + frontend)
docker compose up --build

# 3. Cifrar el padrón de demostración sembrado por db/init.sql (cedula,
#    puesto y mesa quedan en texto plano hasta correr esto una vez —
#    ver comentario en db/init.sql):
docker compose run --rm auth-service node src/scripts/backfillVoterEncryption.js

# 4. Abrir el frontend
#    http://localhost:3000
```

**No hace falta cargar nada a mano para empezar a probar el sistema.** El primer arranque de PostgreSQL ejecuta el seed de `db/init.sql`, que ya deja listos:

| Elemento | Valor |
|---|---|
| Usuario administrador de arranque | credencial fija definida en `db/init.sql` (ver ese archivo) |
| Padrón de votantes demo | cédulas `1000000001` a `1000000005`, repartidas en "Puesto Central" (Mesa 1 y Mesa 2) y "Puesto Norte" (Mesa 1); PIN de acceso definido en `db/init.sql`/`db/migrations/003_voter_access_codes.sql` |
| Plantilla genérica de ejemplo | "Elección de ejemplo" (3 opciones de texto libre) |
| Plantilla presidencial de ejemplo | "Elección Presidencial de Ejemplo" (3 candidatos numerados, sin foto precargada) |

> ⚠️ El seed crea una cuenta admin y votantes de demostración con credenciales fijas y conocidas (ver `db/init.sql`), solo para el primer uso: entra, ve a la pestaña **Usuarios** del panel y crea tu propio administrador antes de usar el sistema con datos reales. Ver el análisis de riesgo completo en la sección 6.

Verificación rápida por línea de comandos (opcional, el frontend ya hace esto internamente):

```bash
curl http://127.0.0.1:3001/health   # auth-service
curl http://127.0.0.1:3002/health   # voting-service
curl http://127.0.0.1:3003/health   # analytics-service
curl http://127.0.0.1:3004/health   # scrutiny-service
docker compose logs -f scheduler-worker   # el worker no expone puerto; se verifica por logs
```

PostgreSQL **no** expone ningún puerto al host (por diseño); solo es accesible desde dentro de la red `db-net` por los microservicios y el worker.

### Windows como servidor central (WSL2 + Docker Desktop)

Para dejar LiveMetric corriendo de forma persistente en una PC con Windows
(accesible desde el resto de la red local), el camino recomendado es
**Docker Desktop con el backend WSL2**: los contenedores son Linux y
corren exactamente igual sin importar el sistema operativo anfitrión, y
`scripts/start.sh` **no necesita ningún cambio** — se ejecuta tal cual, en
un entorno bash real.

1. Instalar WSL2 (una sola vez, requiere reiniciar):

   ```powershell
   wsl --install
   ```

2. Instalar [Docker Desktop para Windows](https://www.docker.com/products/docker-desktop/)
   y, en **Settings → General**, confirmar que "Use the WSL 2 based engine"
   esté activo. En **Settings → Resources → WSL Integration**, activar la
   integración con la distribución que instaló `wsl --install` (por
   defecto, Ubuntu).
3. Abrir una terminal de **WSL** (no PowerShell ni CMD) y clonar el
   repositorio **dentro del sistema de archivos de Linux** (no en
   `/mnt/c/...`, que es mucho más lento y puede dar problemas de permisos
   con los volúmenes de Docker):

   ```bash
   cd ~
   git clone <URL_DEL_REPOSITORIO>
   cd LiveMetric
   ```

4. Seguir la puesta en marcha normal de la sección anterior (`.env` +
   `./scripts/start.sh`), exactamente igual que en Linux/macOS.

**Para que otros equipos de la red lo vean:** Windows Firewall bloquea por
defecto las conexiones entrantes a puertos nuevos. La primera vez que se
levanta el stack, aceptar el aviso de firewall de Docker Desktop, o
agregar manualmente una regla de entrada para el puerto **3000/TCP**
(Panel de control → Firewall de Windows Defender → Configuración
avanzada → Reglas de entrada → Nueva regla → Puerto → TCP → 3000).
Verificar la IP de la PC Windows en esa misma red con `ipconfig` (buscar
"Dirección IPv4") y compartirla: `http://<esa-ip>:3000`.

**Para que sobreviva un reinicio de la PC:** en Docker Desktop →
**Settings → General**, activar "Start Docker Desktop when you log in".
Todos los servicios ya tienen `restart: unless-stopped` (ver
`docker-compose.yml`), así que al volver a estar disponible el motor de
Docker, el stack completo se levanta solo — `start.sh` solo hace falta
correrlo la primera vez, o después de un cambio de código.

### Opción alternativa — Terraform (Infraestructura como Código)

```bash
cd infra/terraform
cp variables.tfvars.example terraform.tfvars
# Editar terraform.tfvars con valores locales (nunca commitear este archivo)

terraform init
terraform plan  -var-file="terraform.tfvars"
terraform apply -var-file="terraform.tfvars"

# Para destruir el entorno:
terraform destroy -var-file="terraform.tfvars"
```

### Recorrido guiado por la interfaz (recomendado para la sustentación)

1. Entra a **http://localhost:3000** → pestaña "Administrador" → usuario `admin` con la credencial de arranque (ver `db/init.sql`).
2. En **Usuarios**, crea tu propio administrador (contraseña ≥10 caracteres) — así dejas de depender de la credencial de arranque.
3. En **Plantillas**, usa "Elección Presidencial de Ejemplo" ya cargada, o crea una nueva de tipo "Elección presidencial" agregando candidatos con número, nombre y logo (una foto).
4. En **Elecciones**, instancia una elección con una ventana corta (2–3 minutos) para ver el ciclo completo rápido.
5. Abre una segunda pestaña/ventana en modo incógnito → pestaña "Votante" → cédula `1000000001` con su PIN de demo (ver `db/init.sql`/`db/migrations/003_voter_access_codes.sql`) (Puesto Central, Mesa 1) → vota en la elección activa. Repite en una tercera ventana con la cédula `1000000003` (mismo PIN de demo) (Puesto Central, Mesa 2) para tener votos en más de una mesa.
6. De vuelta en el panel de admin, en **Elecciones** puedes pulsar "Detener" en cualquier momento para cerrar la elección antes de su hora programada — no hace falta esperar a `scheduledEnd`.
7. En **Resultados**: mientras la elección sigue activa verás "En vivo"; tras cerrarla (por tiempo o manualmente), el mismo panel mostrará "✓ Certificado", el candidato/opción **ganador**, y el desglose del acta **por mesa de votación**.
8. En **Escrutinio**, pulsa "Verificar cadena de escrutinio" para confirmar que ningún acta fue alterada.
9. En **Auditoría**, revisa el registro de todos los intentos de login (exitosos y fallidos) de esta sesión.

### Flujo por línea de comandos (equivalente, para pruebas automatizadas)

```bash
# Login de admin (reemplaza <password> por la credencial de arranque de db/init.sql)
curl -X POST http://127.0.0.1:3001/login/admin \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<password>"}'
# → { "token": "...", "role": "admin" }

# Login de votante (cédula + PIN de acceso asignado por el admin; reemplaza
# <pin> por el PIN de demo de db/init.sql/db/migrations/003_voter_access_codes.sql)
curl -X POST http://127.0.0.1:3001/login/voter \
  -H "Content-Type: application/json" \
  -d '{"cedula":"1000000001","pin":"<pin>"}'
# → { "token": "...", "role": "voter" }

# Crear una elección a partir de la plantilla de ejemplo (id=1)
curl -X POST http://127.0.0.1:3002/admin/elections \
  -H "Authorization: Bearer <TOKEN_ADMIN>" -H "Content-Type: application/json" \
  -d '{"templateId":1,"title":"Elección 2026","scheduledStart":"2026-09-05T15:00:00Z","scheduledEnd":"2026-09-05T15:02:00Z"}'

# Votar (requiere el token de VOTANTE, no el de admin)
curl -X POST http://127.0.0.1:3002/vote \
  -H "Authorization: Bearer <TOKEN_VOTANTE>" -H "Content-Type: application/json" \
  -d '{"electionId":1,"optionId":1}'
# Repetir la misma petición debe devolver 409 (ya votaste)
# Votar antes de scheduledStart o después de scheduledEnd debe devolver 403

# Resultados certificados tras el cierre automático
curl http://127.0.0.1:3003/api/elections/1/results -H "Authorization: Bearer <TOKEN_ADMIN>"
# certified: true, incluye recordHash y previousHash

# Verificar la integridad de toda la cadena de escrutinio
curl http://127.0.0.1:3004/verify -H "Authorization: Bearer <TOKEN_ADMIN>"
# { "valid": true, "totalRecords": 1, "brokenAt": [] }
```

---

## 4. Estrategia de ramas (GitHub Flow)

LiveMetric usa **GitHub Flow**: una sola rama larga (`main`), que debe estar **siempre desplegable**, y ramas de corta duración para cada cambio.

```
main ●───────●───────────────●───────────────●──▶  (siempre desplegable, protegida)
      \       \               \               \
       ● feature/jwt-rate-limit ● fix/vote-race-condition ● chore/bump-trivy-action
       (PR → checks → review → squash merge → borrar rama)
```

### Convención de nombres

| Prefijo | Uso |
|---|---|
| `feature/<descripcion-corta>` | Nueva funcionalidad (ej. `feature/dashboard-live-updates`) |
| `fix/<descripcion-corta>` | Corrección de bug (ej. `fix/vote-race-condition`) |
| `hotfix/<descripcion-corta>` | Corrección urgente directo sobre `main` (ej. `hotfix/jwt-secret-rotation`) |
| `chore/<descripcion-corta>` | Infraestructura, pipeline, dependencias, docs (ej. `chore/bump-trivy-action`) |

### Flujo de trabajo

1. Crear la rama desde `main` actualizado: `git checkout -b feature/mi-cambio main`.
2. Desarrollar y hacer commits pequeños y descriptivos.
3. Abrir un **Pull Request hacia `main`** (se rellena automáticamente con `.github/pull_request_template.md`).
4. El pipeline `devsecops.yml` corre automáticamente sobre el PR; el job `security-gate` debe quedar en verde.
5. Al menos un **CODEOWNER** (ver `.github/CODEOWNERS`) debe aprobar los cambios en el área correspondiente (infraestructura, auth, etc.).
6. Merge por **squash** (historial lineal) y borrado automático de la rama.

### Protección de la rama `main`

GitHub no permite declarar branch protection como un archivo dentro del repo, así que esto se automatiza con `scripts/setup-branch-protection.sh` (usa GitHub CLI) en vez de configurarlo manualmente "a mano" en cada repo:

```bash
gh auth login
./scripts/setup-branch-protection.sh <tu-usuario-u-org>/LiveMetric
```

Esto aplica sobre `main`:
- Prohibido el push directo (todo cambio entra por Pull Request).
- Check requerido: **`Security Gate (resumen)`** debe pasar en verde (agrega Gitleaks + npm audit + SAST + Trivy + Checkov).
- Al menos 1 aprobación, con revisión obligatoria de CODEOWNERS.
- Historial lineal, sin `force-push` ni borrado de la rama `main`.

---

## 5. Pipeline DevSecOps — `.github/workflows/devsecops.yml`

El pipeline sigue el enfoque **shift-left**: los controles de seguridad se ejecutan en cada `push` y `pull_request`, antes de que el código llegue a producción. Cubre las 6 fases de un pipeline DevSecOps (Fase 6 — observabilidad — queda fuera de este alcance, es la única marcada como opcional en el enunciado):

**Fase 1 — Planificación.** Modelado de amenazas en `docs/threat-model/` (no es un job de CI, es un artefacto versionado): `livemetric.threatdragon.json` (abrir en [OWASP Threat Dragon](https://www.threatdragon.com/)) con DFD nivel 0 y nivel 1, y `STRIDE-analysis.md` con la misma información en tabla legible. Cada amenaza está anclada a un flujo/proceso real del sistema, no es un ejemplo genérico.

**Fase 2 — Codificación.**

| Job | Herramienta | Qué detiene |
|---|---|---|
| `secrets-scan` | **Gitleaks** | Commits con secretos, tokens o credenciales hardcodeadas. Se ejecuta primero: si falla, ningún otro job corre. También corre **localmente antes de cada commit** vía `scripts/git-hooks/pre-commit` (instalar una vez con `./scripts/install-hooks.sh`) — el mismo control, pero "shift-left" hasta el commit, no solo hasta el push. |
| `dependency-audit` | **npm audit** | Vulnerabilidades conocidas (CVE) en dependencias de los 6 servicios; falla ante severidad `high` o superior. |
| `sast-scan` | **Semgrep** (reglas OWASP Top 10, Express, JWT) | Patrones de inyección SQL (queries no parametrizadas) y debilidades en el middleware de autenticación (verificación de JWT, uso de `alg: none`, secretos débiles). |
| `sca-scan` | **Trivy** (modo `fs`, sobre cada `package.json`) | Igual que `dependency-audit` pero con la herramienta que pide explícitamente el enunciado ("OWASP Dependency-Check o Trivy sobre archivos de dependencias"); mismo umbral `CRITICAL`/`HIGH`. |

**Fase 3 — Integración/Build.**

| Job | Herramienta | Qué detiene |
|---|---|---|
| `container-scan` | **Trivy** (modo imagen) | Construye las 6 imágenes Docker reales y escanea vulnerabilidades `CRITICAL`/`HIGH` (SO base + dependencias). Cualquier excepción documentada y justificada va en `.trivyignore` (por defecto, vacío: nada está exceptuado). |

**Fase 4 — Pruebas.**

| Job | Herramienta | Qué cubre |
|---|---|---|
| `unit-tests` | **Jest + Supertest** | Pruebas de integración reales contra la app de Express en memoria de cada servicio (`services/*/src/__tests__/*.test.js`), usando la Supabase real (sin base de staging separada — decisión explícita del proyecto). Todo dato de prueba usa el prefijo `CITEST-<servicio>` y se borra en un `afterAll`; ver la nota sobre `scrutiny_ledger` más abajo. Correr localmente: `cd services/<nombre> && npm test`. |
| `staging-deploy-and-dast` | **OWASP ZAP** (baseline scan) | Levanta el stack completo (`docker compose`, Supabase real) y ataca `http://localhost:3000` como caja negra. El reporte se sube como artifact del job; por ahora es un gate de **reporte** (`continue-on-error`), no bloqueante — revisar el artifact `zap-baseline-report` en cada corrida. |

**Fase 5 — Despliegue.**

| Job | Herramienta | Qué cubre |
|---|---|---|
| `iac-scan` | **Checkov** | Malas prácticas en `infra/terraform/main.tf`: redes no aisladas, contenedores privilegiados, falta de límites de recursos, secretos en `.tf`, etc. |
| `iac-deploy` | **Terraform** | Despliegue automatizado real: `terraform apply` levanta el stack completo (con su propio Postgres local efímero, nunca la Supabase real — ver nota abajo), un smoke test confirma que los 4 microservicios responden, y `terraform destroy` limpia todo al final. |

| Job final | — |
|---|---|
| `security-gate` | Resume el estado de **todos** los jobs anteriores (incluidos los nuevos); falla si cualquiera falló. Recomendado como *required check* en la protección de `main`. |

Todos los hallazgos de SAST, Trivy y Checkov se suben en formato **SARIF** a la pestaña **Security → Code scanning alerts** de GitHub para trazabilidad.

> **Nota sobre `iac-deploy` vs. Supabase real**: `infra/terraform/main.tf` aprovisiona su propio Postgres local efímero (documentado en la sección 3 como alternativa Local-First a `docker compose`), nunca la Supabase real — así que `iac-deploy` es una demostración segura de "IaC puede desplegar todo el sistema" que no puede tocar datos reales por diseño. El staging que sí usa Supabase real (`unit-tests`, `staging-deploy-and-dast`) usa `docker compose`, no Terraform, porque así lo pidió explícitamente el equipo del proyecto — implica que cada corrida del pipeline escribe y borra datos de prueba en la base real (siempre con el prefijo `CITEST-`).
>
> **Nota sobre `scrutiny_ledger`**: es una tabla append-only (trigger `prevent_row_mutation`, ver sección 6) — las pruebas de `scrutiny-service` que certifican una elección de prueba dejan esa acta **permanentemente** en la base (no se puede ni se debe borrar; sería subvertir la misma garantía de integridad que el sistema existe para dar). Es un costo pequeño y esperado, no un olvido de limpieza.

### Cómo validar que el pipeline detiene vulnerabilidades reales

Para que el evaluador compruebe que los controles **realmente bloquean** el pipeline (no son cosméticos), se recomienda esta secuencia de pruebas, cada una en una rama/PR separada:

1. **Gitleaks** — En cualquier archivo, agregar temporalmente una línea como `const JWT_SECRET = "sk_live_abcdef1234567890"` y hacer commit. El job `secrets-scan` debe fallar y bloquear el resto del pipeline.
2. **npm audit** — En `services/voting/package.json`, fijar una versión antigua y vulnerable de una dependencia (por ejemplo, degradar `express` a una versión con CVEs conocidos) y correr `npm install` para regenerar el lockfile. El job `dependency-audit` debe fallar con severidad `high`/`critical`.
3. **SAST (Semgrep)** — En `services/voting/src/index.js`, reemplazar temporalmente una query parametrizada por concatenación de strings, p. ej. `` `SELECT * FROM votes WHERE election_id = ${electionId}` ``. Semgrep debe marcarlo como hallazgo de inyección SQL.
4. **Trivy** — Cambiar temporalmente la imagen base de un `Dockerfile` a una versión antigua conocida por tener CVEs (por ejemplo `node:18.0.0` en vez de `node:20-alpine`). El job `container-scan` debe fallar.
5. **Checkov** — En `infra/terraform/main.tf`, quitar temporalmente `internal = true` de la red `db_net` (exponiendo la base de datos). Checkov debe reportar el hallazgo y fallar el job `iac-scan`.

Revertir cada cambio después de la prueba y confirmar que, con el código original, todos los jobs pasan en verde.

### Cómo validar las funcionalidades de ventana de tiempo y escrutinio (funcional, no del pipeline)

Estas pruebas verifican que la lógica de negocio nueva es correcta, además de la seguridad:

1. **Ventana de tiempo respetada** — Crear una elección con `scheduledStart` en el futuro y votar inmediatamente: debe responder `403` ("aún no abre"). Repetir con `scheduledEnd` ya pasado: debe responder `403` ("ya cerró").
2. **Cierre automático sin intervención manual** — Crear una elección con una ventana de 1–2 minutos y no tocar nada: revisar `docker compose logs -f scheduler-worker` y confirmar que, sin ninguna llamada manual, la elección pasa de `scheduled` → `active` → `closed`, y que `scrutiny-service` recibe la llamada de certificación automáticamente.
3. **Resultado congelado tras el cierre** — Antes del cierre, `GET /api/elections/:id/results` en Analytics debe recalcular en cada llamada (`certified: false`). Después del cierre, debe devolver siempre el mismo `recordHash` sin importar cuántas veces se consulte (`certified: true`).
4. **Detección de manipulación en el libro de actas** — Con acceso directo a PostgreSQL, intentar `UPDATE scrutiny_ledger SET total_votes = 9999 WHERE election_id = 1;`. El trigger `trg_scrutiny_no_update` debe rechazar la operación con una excepción. Si en cambio se simula una alteración fuera de ese camino (por ejemplo, restaurando un backup editado a mano), `GET /verify` en Scrutiny debe reportar `valid: false` y señalar en qué `electionId` se rompió la cadena.
5. **Endpoint interno protegido** — Intentar `POST /internal/certify/1` en Scrutiny sin el header `X-Internal-Token` (o con uno incorrecto): debe responder `401`, incluso desde dentro de la red `app-net`.

### Cómo validar el login dual y el módulo de auditoría

1. **PIN incorrecto** — Intentar `POST /login/voter` con la `cedula` correcta y un `pin` equivocado: debe responder `401` genérico ("Cédula o PIN incorrectos"), igual que si la cédula no existiera (evita dar pistas a quien intenta adivinar). Un votante sin PIN asignado (`access_code_hash` nulo, p. ej. cargado antes de esta migración) debe fallar igual, nunca aceptar la cédula como contraseña.
2. **Cédula fuera del padrón** — Intentar con una cédula que no exista en `voters`: `401` genérico, y debe quedar un evento `LOGIN_FAILURE_VOTER` en `GET /admin/audit-log` (pestaña "Auditoría" en el frontend), identificado solo por `voter_id_hash`, nunca por la cédula real.
3. **Token de rol equivocado** — Intentar votar (`POST /vote`) usando un JWT de **administrador** en vez de uno de **votante**: debe responder `403` ("Este token no es válido para votar"). Intentar usar un token de **votante** contra una ruta `/admin/*` de Voting o Auth: debe responder `403` también.
4. **Expiración corta del token de votante** — Iniciar sesión como votante, esperar a que pase `VOTER_JWT_EXPIRES_IN` (10 minutos por defecto) y luego intentar votar: debe responder `401` ("expirada, inicia sesión de nuevo").
5. **Append-only del log de auditoría** — Igual que con `scrutiny_ledger`: `UPDATE audit_log SET actor_ref = 'x' WHERE id = 1;` directo en PostgreSQL debe ser rechazado por el trigger `trg_audit_no_update`.
6. **Nada de PII en el log** — Revisar cualquier fila de `audit_log` para eventos de tipo `*_VOTER`: la columna `actor_ref` debe contener siempre un hash SHA-256 (64 caracteres hexadecimales), nunca un número de cédula reconocible.

### Cómo validar: detener elección, plantilla presidencial, mesas de votación y acta de escrutinio

1. **Detener una elección antes de tiempo** — En "Elecciones", crea una con ventana larga (ej. 1 hora) y pulsa "Detener" mientras está `scheduled` o `active`. Debe quedar `closed` de inmediato, con `stopped_manually: true`. En menos de un minuto (`SCHEDULER_CRON`), `scheduler-worker` la certifica igual que a una cerrada por tiempo — revisa `docker compose logs -f scheduler-worker` para confirmarlo, y luego "Resultados" debe mostrar `certified: true`.
2. **Nadie puede votar después de detenerla** — Justo después de detener una elección que estaba `active`, intenta `POST /vote` contra ella: debe responder `403`, igual que si hubiera cerrado por tiempo.
3. **Plantilla presidencial con candidatos** — En "Plantillas", crea una del tipo "Elección presidencial" con al menos 2 candidatos (número, nombre, logo opcional). Verifica que `GET /admin/templates` devuelva cada opción con `candidateNumber` y `logo` (o `null` si no se cargó foto).
4. **Los candidatos viajan a la elección y a la boleta** — Instancia una elección desde esa plantilla; `GET /elections/active` y `GET /elections/:id/options` deben incluir `candidate_number` y `logo` por cada opción, y la boleta del votante (pestaña "Votante" del frontend) debe mostrar la foto y el número, no solo un texto plano.
5. **Puesto y mesa asociados al votante** — Al cargar el padrón (`/admin/voters/bulk`) sin `pollingPlace` o `votingTable`, debe responder `400`. Con ambos campos presentes, `GET /admin/voters` debe devolverlos, y el login de ese votante (`/login/voter`) debe incluirlos en la respuesta y en el JWT.
6. **El voto queda etiquetado con la mesa real, no con lo que diga el cliente** — Inspecciona la tabla `votes` tras emitir un voto: `polling_place` y `voting_table` deben coincidir con el padrón, nunca con un valor que el navegador pudiera enviar directamente (Voting los toma del JWT verificado, no del body de la petición).
7. **El acta consolida por mesa y determina un ganador** — Con votantes de al menos 2 mesas distintas (el padrón de demostración ya trae "Mesa 1" y "Mesa 2"), vota desde cédulas de ambas mesas en la misma elección presidencial y espera la certificación. `GET /certifications/:electionId` en Scrutiny debe devolver `results.byTable` con una entrada por mesa (y su propio conteo por candidato) y `results.winner` con el candidato de más votos a nivel global.
8. **Empates se reportan, no se ocultan** — Fuerza un empate exacto entre dos candidatos (mismo número de votos) y certifica la elección: `winner.tie` debe ser `true` y `winner.tiedWith` debe listar al otro candidato empatado, en vez de elegir uno arbitrariamente.

---

## 6. Decisiones de diseño relevantes para el evaluador

- **Local-First**: ningún archivo del proyecto asume un proveedor cloud (AWS/Azure/GCP). El provider de Terraform es `kreuzwerker/docker`, que habla directamente con el daemon Docker local.
- **Defensa en profundidad en Voting**: la validación ocurre en tres capas — validación de entrada en la API, lógica transaccional en el servicio, y restricción `UNIQUE` a nivel de base de datos — para que ni siquiera una condición de carrera permita doble voto.
- **Principio de mínimo privilegio en contenedores**: los 5 microservicios Node.js y el worker corren con usuario no-root explícito, `read_only: true` en el sistema de archivos raíz, y `no-new-privileges` activado. El contenedor del **frontend (nginx) es una excepción documentada**: su proceso maestro arranca como root (necesario para abrir el puerto 80 y preparar `/var/cache/nginx`), pero los procesos *worker* que realmente procesan las peticiones de red —la superficie de ataque real— corren sin privilegios bajo el usuario `nginx` ya definido por la imagen oficial. Es el mismo modelo que usa nginx sin modificar en la gran mayoría de despliegues en producción; forzar un usuario no-root en el proceso maestro rompe ese diseño sin ganar seguridad real.
- **Aislamiento de red por defecto**: la base de datos nunca está en la misma red que el host ni expuesta por `ports:` — solo se comunica con los microservicios vía `db-net`.
- **Escrutinio como servicio separado, no como función de Analytics**: certificar resultados es una responsabilidad distinta a *servir* resultados. Si estuvieran en el mismo servicio, un bug o compromiso en el código que sirve el dashboard también podría alterar el conteo certificado. Al separarlos, Scrutiny hace su propio recuento desde cero, sin confiar en nada que haya calculado Analytics.
- **Cadena de hashes en vez de solo un registro plano**: encadenar cada acta con la anterior (`previous_hash`) significa que alterar un resultado certificado antiguo rompe visiblemente la cadena hacia adelante — no basta con corregir una sola fila para ocultar la manipulación, como sí pasaría con un simple campo `checksum` por registro.
- **El worker nunca certifica directamente en la base de datos**: `scheduler-worker` cambia el `status` de la elección, pero delega la certificación a `scrutiny-service` vía HTTP interno. Esto mantiene una única fuente de verdad para el algoritmo de conteo y de hash (vive solo en Scrutiny), en vez de duplicar esa lógica en dos servicios distintos.
- **Cifrado en reposo del padrón (`voters.cedula`, `polling_place`, `voting_table`)**: AES-256-GCM a nivel de aplicación (`services/auth/src/voterCrypto.js`), con la clave (`VOTERS_ENCRYPTION_KEY`) conocida solo por `auth-service` y `analytics-service` (los dos únicos que leen esa tabla). `full_name` queda en texto plano a propósito, para que el padrón siga siendo legible/gestionable por nombre en el panel de admin. El nonce de GCM es **determinístico** (HMAC-SHA256 del texto plano, no aleatorio): mismo valor cifra siempre igual, lo que permite seguir haciendo `WHERE cedula = ...` y mantener la restricción `UNIQUE` sin descifrar toda la tabla para buscar. Trade-off consciente: quien tenga acceso directo a Postgres (pero no a la clave) puede notar que dos filas comparten el mismo puesto/mesa/cédula, aunque no puede leer cuál es — con un IV aleatorio esa búsqueda por igualdad no sería posible en absoluto. `votes.polling_place`/`voting_table` (el snapshot tomado al votar, usado por Scrutiny para consolidar el acta) queda **fuera** de este cifrado a propósito: cifrarlo obligaría a descifrar fila por fila para poder agrupar por mesa, justo en el código de certificación que más debe poder auditarse en texto plano.

### Riesgos aceptados y documentados (para la sección "Resultados de Seguridad" del informe)

| Hallazgo | Severidad | Estado | Justificación / control compensatorio |
|---|---|---|---|
| ~~El login de votante usaba la cédula como usuario y contraseña~~ (corregido). Ahora es cédula + un PIN numérico de 6 dígitos, generado por el admin al cargar el padrón (`access_code_hash`, bcrypt) y nunca derivable de la cédula. | — | **Corregido** (antes: Alta, aceptada con controles compensatorios) | Sigue sin haber registro de cuentas self-service (el admin es la única fuente de identidad), pero ahora sí hay un secreto real que el votante debe conocer aparte de su cédula. Residual: el PIN debe distribuirse fuera de banda (impreso/entregado en el puesto de votación) — un paso logístico que antes no existía. El PIN generado se muestra en texto plano una única vez en el panel de admin y nunca vuelve a mostrarse (solo puede regenerarse, invalidando el anterior); los controles previos (rate limiting, JWT de vida corta, anti-doble-voto por `voter_id_hash`, auditoría) se mantienen como defensa en profundidad. |
| El sistema arranca con un usuario administrador (`admin`) y un padrón de demostración con credenciales fijas, definidas en `db/init.sql`. | Media | **Aceptado, mitigado por diseño** | Es un valor por defecto necesario para el primer uso (sin él, un despliegue nuevo no tendría forma de entrar), no un secreto filtrado accidentalmente. Ya no se muestra en la pantalla de login ni se documenta en este README —solo queda en el código fuente, para reducir su visibilidad casual— pero sigue siendo un valor fijo y predecible para quien tenga acceso al repositorio. Existe una ruta clara para reemplazarlo (`POST /admin/users` vía la pestaña "Usuarios", ver sección 3) y nunca debe usarse así en un entorno con datos reales. |
| El frontend habla directo con cada microservicio desde el navegador (sin un API Gateway intermedio), por lo que cada backend debe validar CORS por separado. | Baja | **Mitigado** | Cada servicio usa `cors({ origin: FRONTEND_ORIGIN })` con un origen exacto (nunca `*`), configurable por variable de entorno y no hardcodeado. |
| La sesión del frontend vive en memoria de React (no en `localStorage`/`sessionStorage`). | N/A (decisión de diseño, no hallazgo) | — | Recargar la página cierra la sesión. Es una compensación razonable para un puesto de votación físico compartido por varias personas, a costa de conveniencia (no hay "recordarme"). |

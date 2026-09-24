# Arquitectura

LiveMetric permite al administrador **cargar plantillas de elección reutilizables**, **instanciarlas con una ventana de tiempo** (hora de inicio y de fin), obtener **resultados certificados automáticamente** al cierre mediante un módulo de escrutinio independiente, y gestionar la identidad de administradores y votantes con **auditoría inmutable** de cada intento de acceso.

```
                    Navegador (administrador / auditor / votante)
                                     │
                                     │ http://<ip-de-la-pc>:3000  ← único puerto abierto a la red
                            ┌────────▼─────────┐
                            │     Frontend     │  React + Vite, servido por nginx (sin root)
                            │  (proxy reverso) │  /auth · /voting · /analytics · /scrutiny
                            └────────┬─────────┘
  ┌──────────────────────────────────┼──────────────────────────────── app-net ──┐
  │        ┌─────────────┬───────────┴───┬───────────────┐                        │
  │   ┌────▼────┐   ┌────▼────┐   ┌──────▼────┐   ┌──────▼────┐   ┌────────────┐  │
  │   │  Auth   │   │ Voting  │   │ Analytics │   │ Scrutiny  │◀──│ Scheduler  │  │
  │   │  :3001  │   │  :3002  │   │   :3003   │   │   :3004   │   │ (node-cron,│  │
  │   │ login + │   │ votación│   │ resultados│   │ acta con  │   │ sin puerto)│  │
  │   │ padrón  │   │ + admin │   │ y reportes│   │ hash chain│   └─────┬──────┘  │
  │   └────┬────┘   └────┬────┘   └─────┬─────┘   └─────┬─────┘         │         │
  │        └─────────────┴──────┬───────┴───────────────┴───────────────┘         │
  │                      ┌──────▼──────┐                                          │
  │                      │  postgres   │  proxy TCP (socat), sin puerto al host   │
  │                      └──────┬──────┘                                          │
  └─────────────────────────────┼─────────────────────────────────────────────────┘
                                │ TLS verificado contra la CA de Supabase
                        ┌───────▼────────┐
                        │   PostgreSQL   │  gestionado en Supabase
                        │ (audit_log y   │  (la variante Terraform usa un
                        │  libro de actas│   PostgreSQL local en red interna)
                        │  append-only)  │
                        └────────────────┘
```

Los puertos 3001–3004 se publican solo en `127.0.0.1` (para probar las APIs desde la misma PC); el navegador nunca los usa: todo pasa por el 3000 del frontend.

## Componentes

| Componente | Responsabilidad | Tecnología | Seguridad clave |
|---|---|---|---|
| **Frontend** | SPA para administradores, auditores y votantes; proxy reverso hacia los 4 microservicios | React 18 + Vite, Recharts, servido por nginx | nginx corre entero sin root (puerto 8080 dentro del contenedor). La sesión (JWT) vive solo en memoria: se pierde al recargar, sin dejar tokens en equipos compartidos |
| **Microservicio A — Auth** | Login dual (admin y votante), padrón electoral, usuarios, auditoría | Node.js 20 / Express | `bcrypt` para contraseñas y PIN, hash SHA-256 de la cédula, padrón cifrado en reposo (AES-256-GCM), JWT de votante de vida corta, rate limiting, log de auditoría append-only |
| **Microservicio B — Voting** | Votación **+** administración de plantillas (genéricas o **presidenciales** con candidatos) y elecciones, incluido detenerlas manualmente | Node.js 20 / Express | Exige JWT de **votante** para votar; el anti-doble-voto se ancla a la identidad (`voter_id_hash`), no a IP/navegador; ventana de tiempo verificada en la propia query |
| **Microservicio C — Analytics** | Resultados (en vivo o certificados), métricas y estadística avanzada de los reportes, tableros configurables | Node.js 20 / Express | Solo lectura para admin/auditor; en elecciones cerradas sirve el acta certificada, nunca un recálculo. Verifica por su cuenta la integridad de las actas |
| **Microservicio D — Scrutiny** | Recuento **independiente** desde los votos, consolidación por **mesa**, **ganador**, y certificación con cadena de hashes SHA-256; acta en PDF | Node.js 20 / Express | `/internal/certify` solo acepta un token de servicio (`X-Internal-Token`, comparación *timing-safe*), nunca un JWT de usuario |
| **Worker — Scheduler** | Activa/cierra elecciones según su horario y dispara la certificación | Node.js 20 + `node-cron` | Sin puerto publicado; solo habla con Scrutiny dentro de `app-net` |
| **postgres** | Proxy TCP (socat) hacia la base de Supabase | `alpine/socat` | No termina TLS: el handshake de cada microservicio es de punta a punta contra Supabase |
| **PostgreSQL** | Persistencia, incluidos el libro de escrutinio y el log de auditoría | PostgreSQL gestionado (Supabase) | Triggers que bloquean `UPDATE`/`DELETE` sobre `scrutiny_ledger` y `audit_log` |

## Red

- **`app-net` (bridge)**: une a todos los contenedores. Hacia la red local solo se abre el puerto 3000 del frontend; los microservicios se publican únicamente en `127.0.0.1`.
- **Base de datos**: no tiene ningún puerto en la PC. El único camino es el proxy `postgres` dentro de `app-net`, y la conexión va cifrada y verificada (CA raíz de Supabase en `services/*/src/certs/`, comprobando el nombre del servidor real aunque se pase por el proxy).
- **Variante Terraform** (`infra/terraform/main.tf`): levanta su propio PostgreSQL en una red interna (`db_net`, sin salida a Internet ni acceso desde el host).

## Gestión de secretos

Ningún secreto (`JWT_SECRET`, credenciales de la base, `VOTER_ID_SALT`, `VOTERS_ENCRYPTION_KEY`, `INTERNAL_SERVICE_TOKEN`) está en `docker-compose.yml`, `main.tf` ni en el código. Todos se inyectan por variables de entorno desde un `.env` **local**, excluido por `.gitignore`:

- `.env.example`: plantilla sin valores reales.
- `.env.gpg`: el `.env` del equipo cifrado con gpg (sí está en el repo); la passphrase se comparte por otro canal. `start.sh`/`start.bat`/`contenedor.sh` lo descifran solos si no hay `.env`.
- En GitHub Actions, los mismos valores viven como *secrets* del repositorio.

Tampoco hay credenciales de la aplicación en el repositorio: `db/init.sql` no crea ningún administrador ni asigna PINs. El primer administrador se crea con `services/auth/src/scripts/crearAdmin.js`, que pide la contraseña por teclado (ver [instalación](instalacion-y-despliegue.md#el-archivo-env)).

## Flujo funcional (de punta a punta)

```
0) [SETUP] db/init.sql deja un padrón y plantillas de demostración, sin credenciales
   → el primer admin se crea con src/scripts/crearAdmin.js; los PINs, desde "Padrón"

1) Admin hace login       → POST /login/admin (Auth)         → JWT rol "admin", ~1h
   Votante hace login     → POST /login/voter (Auth)         → JWT rol "voter", ~10min
   (cédula + PIN; todo intento, exitoso o fallido, queda en audit_log sin PII cruda)

2) Admin crea una PLANTILLA en Voting     → POST /admin/templates   (JWT admin)
3) Admin instancia una ELECCIÓN           → POST /admin/elections   (JWT admin)
   con scheduledStart / scheduledEnd      → la elección nace en estado "scheduled"

4) Scheduler-worker (cada minuto, node-cron):
   - si ya llegó scheduledStart  → la elección pasa a "active"
   - si ya pasó scheduledEnd     → pasa a "closed"
                                  → llama a Scrutiny: POST /internal/certify/:electionId

5) Mientras está "active": el votante autenticado vota → POST /vote (JWT votante)
   - Voting exige status=active Y now() dentro de la ventana horaria
   - triple defensa contra el doble voto: JWT de identidad + transacción + UNIQUE
     en la base sobre voter_id_hash (no sobre IP/navegador)

6) Scrutiny, al certificar:
   - recuenta los votos DIRECTO desde la tabla "votes" (recuento independiente)
   - consolida por mesa y determina el ganador (los empates se reportan)
   - calcula record_hash = SHA256(previous_hash + resultados)
   - inserta el acta en "scrutiny_ledger" (append-only, no editable ni borrable)

7) Analytics, al pedir resultados:
   - si sigue "active"  → conteo en vivo (recalculado siempre)
   - si ya está "closed" → el acta CERTIFICADA de Scrutiny, nunca un recálculo propio
   - en Reportes: proyección de participación, momento de definición,
     integridad del acta (cadena + recuento) y accesos sospechosos

8) GET /verify en Scrutiny confirma que TODA la cadena de actas es íntegra,
   y GET /admin/audit-log en Auth muestra quién intentó entrar y cuándo.
```

## Estructura del repositorio

```
LiveMetric/
├── README.md                     # Presentación e inicio rápido
├── LICENSE                       # Licencia MIT
├── docker-compose.yml            # El stack completo (7 contenedores)
├── .env.example / .env.gpg       # Plantilla de variables / .env del equipo cifrado
├── .gitleaks.toml, .trivyignore  # Configuración de los escáneres
├── db/
│   ├── init.sql                  # Esquema + datos de demostración
│   └── migrations/               # Migraciones 002–004 (se aplican a mano, en orden)
├── services/
│   ├── frontend/                 # SPA React + nginx (proxy reverso)
│   ├── auth/                     # A: login dual, padrón, usuarios, auditoría
│   ├── voting/                   # B: votación + administración de plantillas y elecciones
│   ├── analytics/                # C: resultados, métricas, estadística avanzada, tableros
│   ├── scrutiny/                 # D: certificación con cadena de hashes, acta en PDF
│   └── scheduler/                # Worker: abre/cierra elecciones y dispara la certificación
├── infra/
│   ├── terraform/                # El mismo stack como código (provider Docker)
│   └── contenedor-global/        # Imagen Docker-in-Docker (scripts/contenedor.sh)
├── scripts/
│   ├── start.sh / start.bat           # Análisis de seguridad + levantar el stack
│   ├── contenedor.sh / contenedor.bat # Lo mismo, todo dentro de un contenedor global
│   ├── pipeline-local.sh / .bat       # Solo el análisis de seguridad (antes de un push)
│   ├── pipeline-status.sh             # Estado del último pipeline en GitHub
│   ├── deploy.sh                      # Descifrar .env.gpg y levantar el stack
│   ├── install-hooks.sh, git-hooks/   # Gitleaks antes de cada commit
│   ├── setup-branch-protection.sh     # Protección de main vía gh CLI
│   ├── lib/                           # Presentación y resúmenes compartidos por los scripts
│   └── ci/                            # Utilidades del pipeline (insignia de cobertura)
├── docs/                         # Esta documentación + modelo de amenazas
└── .github/
    ├── CODEOWNERS, pull_request_template.md
    └── workflows/devsecops.yml   # Pipeline DevSecOps
```

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
  ┌──────────────────────────────────┼───────────────────────────────── app-net ──┐
  │        ┌─────────────┬───────────┴───┬───────────────┐                        │
  │   ┌────▼────┐   ┌────▼────┐   ┌──────▼────┐   ┌──────▼────┐   ┌────────────┐  │
  │   │  Auth   │   │ Voting  │   │ Analytics │   │ Scrutiny  │◀──│ Scheduler  │  │
  │   │  :3001  │   │  :3002  │   │   :3003   │   │   :3004   │   │ (node-cron,│  │
  │   │ login + │   │ votación│   │ resultados│   │ acta con  │   │ sin puerto)│  │
  │   │ padrón  │   │ + admin │   │ y reportes│   │ hash chain│   └─────┬──────┘  │
  │   └────┬────┘   └────┬────┘   └─────┬─────┘   └─────┬─────┘         │         │
  │        └─────────────┴──────┬───────┴───────────────┴───────────────┘         │
  └─────────────────────────────┼─────────────────────────────────────────────────┘
  ┌─────────────────────────────┼─────────────────────────────────────── db-net ──┐
  │                     ┌───────▼────────┐                                        │
  │                     │   PostgreSQL   │  16, datos en el volumen db-data;      │
  │                     │ (audit_log y   │  red interna: sin salida a Internet,   │
  │                     │  libro de actas│  sin puerto en la PC y solo para       │
  │                     │  append-only)  │  los 5 servicios de backend            │
  │                     └────────────────┘                                        │
  └───────────────────────────────────────────────────────────────────────────────┘
```

Los puertos 3001–3004 se publican solo en `127.0.0.1` (para probar las APIs desde la misma PC); el navegador nunca los usa: todo pasa por el 3000 del frontend.

## Componentes

| Componente | Responsabilidad | Tecnología | Seguridad clave |
|---|---|---|---|
| **Frontend** | SPA para administradores, auditores y votantes; proxy reverso hacia los 4 microservicios | React 18 + Vite, Recharts, servido por nginx | nginx corre entero sin root (puerto 8080 dentro del contenedor) y envía una Content-Security-Policy estricta y las cabeceras de aislamiento del navegador (`cabeceras-seguridad.conf`). La sesión (JWT) vive solo en memoria: se pierde al recargar, sin dejar tokens en equipos compartidos |
| **Microservicio A — Auth** | Login dual (admin y votante), padrón electoral, usuarios, auditoría | Node.js 20 / Express | `bcrypt` para contraseñas y PIN, hash SHA-256 de la cédula, padrón cifrado en reposo (AES-256-GCM), JWT de votante de vida corta, rate limiting, log de auditoría append-only |
| **Microservicio B — Voting** | Votación **+** administración de plantillas (genéricas o **presidenciales** con candidatos) y elecciones, incluido detenerlas manualmente | Node.js 20 / Express | Exige JWT de **votante** para votar; el anti-doble-voto se ancla a la identidad (`voter_id_hash`), no a IP/navegador; ventana de tiempo verificada en la propia query |
| **Microservicio C — Analytics** | Total de votos en vivo y resultados certificados, métricas y estadística avanzada de los reportes, tableros configurables | Node.js 20 / Express | Solo lectura para admin/auditor; en elecciones cerradas sirve el acta certificada, nunca un recálculo. Verifica por su cuenta la integridad de las actas |
| **Microservicio D — Scrutiny** | Recuento **independiente** desde los votos, consolidación por **mesa**, **ganador**, y certificación con cadena de hashes SHA-256 y **firma digital Ed25519**; acta en PDF | Node.js 20 / Express | Es el único con la clave privada que firma las actas (`ACTA_SIGNING_KEY`). `/internal/certify` solo acepta un token de servicio (`X-Internal-Token`, comparación *timing-safe*), nunca un JWT de usuario |
| **Worker — Scheduler** | Activa/cierra elecciones según su horario y dispara la certificación | Node.js 20 + `node-cron` | Sin puerto publicado; solo habla con Scrutiny dentro de `app-net` |
| **PostgreSQL** (`postgres`) | Persistencia, incluidos el libro de escrutinio y el log de auditoría | PostgreSQL 16 (`postgres:16-alpine`), volumen `db-data` | Solo en la red interna `db-net`, sin puerto en la PC; sistema de archivos de solo lectura salvo sus datos. Triggers que bloquean `UPDATE`/`DELETE` sobre `scrutiny_ledger` y `audit_log` |

## Red

- **`app-net` (bridge)**: el frontend y los 5 servicios de backend. Hacia la red local solo se abre el puerto 3000 del frontend; los microservicios se publican únicamente en `127.0.0.1`.
- **`db-net` (bridge, `internal`)**: la base y los 5 servicios de backend, nada más. Sin salida a Internet y sin ningún puerto en la PC: el frontend (lo único expuesto a la red) no llega a la base ni aunque se comprometa. La conexión a Postgres no usa TLS porque nunca sale de la máquina.
- **Docker Swarm** (`orquestacion/docker-stack.yml`): las mismas dos redes, como *overlay* cifradas entre nodos.
- **Variante Terraform** (`infra/terraform/main.tf`): la misma separación, con su red interna `db_net`.

## Gestión de secretos

Ningún secreto (`POSTGRES_PASSWORD`, `JWT_SECRET`, `VOTER_ID_SALT`, `VOTERS_ENCRYPTION_KEY`, `INTERNAL_SERVICE_TOKEN`, `ACTA_SIGNING_KEY`) está en `docker-compose.yml`, `main.tf` ni en el código. Todos se inyectan por variables de entorno desde un `.env` **local**, excluido por `.gitignore`:

- `.env.example`: plantilla sin valores reales.
- `.env`: lo genera `scripts/lib/generar-env.js` la primera vez que corre `start.sh`/`start.bat`/`contenedor.sh`, con valores aleatorios propios de esa instalación. Como cada instalación tiene su propia base, no hay ningún secreto que compartir entre personas o PCs.
- En GitHub Actions, las pruebas generan secretos al azar en cada corrida (`jest.setup.js`) contra una base desechable, y el entorno de staging genera su propio `.env` igual que una instalación nueva: el repositorio no necesita *secrets* de la aplicación.

Tampoco hay credenciales de la aplicación en el repositorio: `db/init.sql` no crea ningún administrador ni asigna PINs. El primer administrador lo pide el script de arranque con `services/auth/src/scripts/crearAdmin.js`, que lee la contraseña por teclado sin mostrarla (ver [instalación](instalacion-y-despliegue.md#primer-administrador)).

## Flujo funcional (de punta a punta)

```
0) [SETUP] db/init.sql deja un padrón y plantillas de demostración, sin credenciales
   → auth-service cifra ese padrón al arrancar; el primer admin lo pide el script
     de arranque (src/scripts/crearAdmin.js); los PINs, desde "Padrón"

1) Admin hace login       → POST /login/admin (Auth)         → JWT rol "admin", ~1h
   Votante hace login     → POST /login/voter (Auth)         → desafío (5 min, sin rol)
                          → POST /login/voter/codigo         → JWT rol "voter", ~10min
   (con el PIN sin vencer, haya o no una votación abierta;
    cédula + PIN, y después el código de su app autenticadora; la primera vez,
    /login/voter/registro registra la app con un QR; si vota asistido,
    /login/voter/asistido con el usuario y el código del jurado de su mesa.
    Todo intento, exitoso o fallido, queda en audit_log sin PII cruda)
   Jurado hace login      → POST /login/admin + /login/admin/codigo → JWT rol "jurado"

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
   - firma el record_hash con su clave privada Ed25519 (ACTA_SIGNING_KEY)
   - inserta el acta y su firma en "scrutiny_ledger" (append-only, no editable
     ni borrable)

7) Analytics, al pedir resultados:
   - mientras no hay acta → solo el TOTAL de votos, en vivo; nunca los votos
     por opción ni quién va adelante (tampoco al admin ni pidiéndolo al API)
   - con el acta certificada → el acta de Scrutiny, nunca un recálculo
     propio, con su indicador de veracidad: Analytics verifica por su cuenta la
     firma (con la clave PÚBLICA), la cadena y el recuento → verificada /
     sin firma / alterada
   - en Reportes: proyección de participación, momento de definición (solo
     con el acta), integridad del acta (firma + cadena + recuento) y accesos
     sospechosos

8) GET /verify en Scrutiny verifica acta por acta toda la cadena y cada firma,
   el PDF del acta lleva ese veredicto en el encabezado, y GET /admin/audit-log
   en Auth muestra quién intentó entrar y cuándo.
```

## Estructura del repositorio

```
LiveMetric/
├── README.md                     # Presentación e inicio rápido
├── LICENSE                       # Licencia MIT
├── docker-compose.yml            # El stack completo (7 contenedores)
├── .env.example                  # Plantilla del .env (los scripts lo generan solos)
├── .gitleaks.toml, .trivyignore  # Configuración de los escáneres
├── db/
│   ├── init.sql                  # Esquema completo + datos de demostración (lo carga Postgres)
│   └── migrations/               # 002–005, solo para bases creadas con un init.sql anterior
├── services/
│   ├── frontend/                 # SPA React + nginx (proxy reverso)
│   ├── auth/                     # A: login dual, padrón, usuarios, auditoría
│   ├── voting/                   # B: votación + administración de plantillas y elecciones
│   ├── analytics/                # C: resultados, métricas, estadística avanzada, tableros
│   ├── scrutiny/                 # D: certificación con cadena de hashes y firma digital, acta en PDF
│   └── scheduler/                # Worker: abre/cierra elecciones y dispara la certificación
├── infra/
│   ├── terraform/                # El mismo stack como código (provider Docker)
│   └── contenedor-global/        # Imagen Docker-in-Docker (scripts/contenedor.sh)
├── scripts/
│   ├── start.sh / start.bat           # Análisis de seguridad + levantar el stack y el monitoreo
│   ├── contenedor.sh / contenedor.bat # Lo mismo, todo dentro de un contenedor global
│   ├── pipeline-local.sh / .bat       # Solo el análisis de seguridad (antes de un push)
│   ├── pipeline-status.sh             # Estado del último pipeline en GitHub
│   ├── install-hooks.sh, git-hooks/   # Gitleaks antes de cada commit
│   ├── setup-branch-protection.sh     # Protección de main vía gh CLI
│   ├── lib/                           # Compartido: presentación, resúmenes, .env, base de pruebas
│   └── ci/                            # Utilidades del pipeline (insignia de cobertura)
├── docs/                         # Esta documentación + modelo de amenazas
└── .github/
    ├── CODEOWNERS, pull_request_template.md
    └── workflows/devsecops.yml   # Pipeline DevSecOps
```

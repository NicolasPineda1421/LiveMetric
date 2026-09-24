# Modelo de amenazas — LiveMetric

Este documento es la versión legible del modelo formal en
[`livemetric.threatdragon.json`](./livemetric.threatdragon.json), pensado para
abrirse en [OWASP Threat Dragon](https://www.threatdragon.com/) (web o
desktop). Los diagramas de flujo de datos (DFD) reflejan la arquitectura real
del sistema (ver `docs/arquitectura.md`), no un ejemplo genérico: cada
amenaza está anclada a un flujo o proceso que existe de verdad en el código,
y cita la mitigación real ya implementada cuando la hay.

## DFD Nivel 0 — Contexto

```
   ┌──────────┐        login (cédula+PIN) / voto        ┌─────────────────────┐
   │ Votante  │ ───────────────────────────────────────▶│                     │
   │          │◀─────────────────────────────────────── │                     │
   └──────────┘   confirmación / historial (sin detalle) │                     │
                                                          │  Sistema LiveMetric │        ┌──────────────────┐
   ┌──────────────┐  gestión (padrón, plantillas,        │  (trust boundary)   │───────▶│ Postgres          │
   │ Administrador│  elecciones, usuarios)                │                     │◀───────│ (Supabase)        │
   │              │──────────────────────────────────────▶│                     │        │ lectura/escritura │
   │              │◀────────────────────────────────────  │                     │        │ cifrada del padrón│
   └──────────────┘   resultados, reportes, auditoría     └─────────────────────┘        └──────────────────┘
                                                                 ▲
   ┌──────────┐   consulta de solo lectura                       │
   │ Auditor  │───────────────────────────────────────────────────┘
   │          │◀── resultados y reportes (sin poder editar nada) ─┘
   └──────────┘
```

## DFD Nivel 1 — Desagregado por microservicio

```
Votante ──login(cédula+PIN)──▶ auth-service ──JWT votante (10 min)──▶ Votante
Votante ──voto (JWT)──────────▶ voting-service ──INSERT──▶ [Elecciones y votos]
Votante ──/my-votes───────────▶ voting-service ──SELECT (sin election/option)──▶ Votante

Administrador ──login/gestión padrón/usuarios──▶ auth-service ──R/W cifrado──▶ [Padrón (voters)]
Administrador ──crear plantillas/elecciones────▶ voting-service ──R/W──▶ [Elecciones y votos]
Administrador/Auditor ──resultados/métricas/reportes──▶ analytics-service
    analytics-service ──lectura (en vivo)──▶ [Elecciones y votos]
    analytics-service ──lectura (participación)──▶ [Padrón (voters)]
    analytics-service ──lectura (si cerrada/certificada)──▶ [Acta de escrutinio]

scheduler-worker ──cambia status──▶ [Elecciones y votos]
scheduler-worker ──dispara certificación (INTERNAL_SERVICE_TOKEN)──▶ scrutiny-service
    scrutiny-service ──lee votos──▶ [Elecciones y votos]
    scrutiny-service ──escribe acta (hash encadenado)──▶ [Acta de escrutinio]
Administrador/Auditor ──descarga acta PDF / verificar cadena──▶ scrutiny-service

auth-service ──escribe evento──▶ [Audit log] (append-only)
```

Almacenes de datos (todos en el mismo Postgres de Supabase, separados aquí
por responsabilidad):

- **Padrón (voters)**: `cedula`, `polling_place`, `voting_table` cifrados
  (AES-256-GCM); `full_name` en texto plano; `access_code_hash` (bcrypt del
  PIN).
- **Elecciones y votos**: `elections`, `election_options`, `votes`
  (`voter_id_hash`, nunca la cédula).
- **Acta de escrutinio**: `scrutiny_ledger`, append-only, hash SHA-256
  encadenado.
- **Audit log**: `audit_log`, append-only (trigger `trg_audit_no_update`).

## Amenazas STRIDE

| # | Elemento | Categoría STRIDE | Amenaza | Estado | Mitigación / justificación |
|---|---|---|---|---|---|
| 1 | Flujo Votante → auth-service (login) | Spoofing | Alguien que conozca la cédula de un votante intenta suplantarlo | Mitigado | Login exige cédula **+ PIN** de 6 dígitos generado por el admin (no derivable de la cédula) — ver migración `003_voter_access_codes.sql`. Antes del cambio, usuario y contraseña eran ambos la cédula. |
| 2 | Flujo Votante → auth-service (login) | Denial of Service | Fuerza bruta del PIN de votante | Mitigado | Rate limiting agresivo: 8 intentos / 15 min por IP (`voterLoginLimiter`, `services/auth/src/index.js`). |
| 3 | Flujo Votante → auth-service (login) | Repudiation | El votante niega haber votado, o alguien niega que fue él quien votó | Aceptado (por diseño) | El sistema registra que "un voto ocurrió" (`voter_id_hash`) pero deliberadamente NO liga el voto a la identidad real más allá de ese hash — es el trade-off de anonimato del voto, no un descuido. |
| 4 | Proceso auth-service ↔ Padrón (voters) | Tampering | Alguien con acceso directo a Postgres altera cédula/puesto/mesa de un votante | Mitigado (parcial) | Cifrado AES-256-GCM en reposo (`services/auth/src/voterCrypto.js`). Residual: nonce determinístico (necesario para poder buscar `WHERE cedula = ...`) permite notar si dos filas cifran igual, aunque no leer el valor. |
| 5 | Proceso auth-service ↔ Padrón (voters) | Information Disclosure | Una fuga de la base de datos expone identidades del padrón | Mitigado | `cedula`, `polling_place`, `voting_table` cifrados; solo `full_name` queda en texto plano a propósito (gestión legible del padrón). |
| 6 | Proceso voting-service (`/vote`) | Elevation of Privilege | Un votante emite más de un voto en la misma elección | Mitigado | Restricción `UNIQUE(election_id, voter_id_hash)` a nivel de base de datos — no depende solo de lógica de aplicación. |
| 7 | Proceso voting-service (`/vote`) | Tampering | Votar fuera de la ventana de tiempo programada, o tras un cierre manual | Mitigado | Se valida `status = 'active' AND now() BETWEEN scheduled_start AND scheduled_end` en cada voto, no solo al abrir la elección. |
| 8 | Flujo scheduler-worker → scrutiny-service | Spoofing | Un servicio no autorizado dispara una certificación falsa | Mitigado | `INTERNAL_SERVICE_TOKEN` compartido solo entre `scheduler-worker` y `scrutiny-service`, nunca expuesto al navegador. |
| 9 | Almacén Acta de escrutinio (`scrutiny_ledger`) | Tampering | Alterar el resultado de un acta ya certificada | Mitigado | Tabla append-only (trigger `prevent_row_mutation`) + cada acta encadena el hash de la anterior (`previous_hash`/`record_hash`); alterar una rompe la cadena hacia adelante de forma detectable (`/verify`). |
| 10 | Almacén Audit log (`audit_log`) | Repudiation | Borrar o modificar el registro de un evento de login/gestión para ocultar un incidente | Mitigado | Trigger `trg_audit_no_update`, append-only igual que el acta de escrutinio. |
| 11 | Flujo Administrador/Auditor → analytics-service (tableros) | Elevation of Privilege | Un usuario con rol `auditor` (solo lectura) crea, edita o borra un tablero de reportes | Mitigado | Middleware `requireRole('admin','auditor')` para lectura vs. `requireRole('admin')` exclusivo para escritura, verificado en cada endpoint de `report_dashboards`. |
| 12 | Flujo navegador → frontend/proxy nginx | Information Disclosure | Exponer los 4 microservicios en puertos sueltos en vez de un solo origen aumenta la superficie de ataque | Mitigado | Proxy reverso en `nginx.conf`: el navegador solo habla con el origen del frontend; los backends nunca se exponen directamente fuera de la red interna de Docker. |
| 13 | Credenciales de despliegue (`.env`) | Information Disclosure | El archivo con todos los secretos se filtra al compartir el proyecto con un tercero | Aceptado (con control compensatorio) | `.env` nunca se commitea (`.gitignore`); para compartir el proyecto se cifra con GPG (`scripts/deploy.sh`) y la passphrase viaja por un canal distinto al del archivo. Quien reciba y ejecute el stack en su propia máquina necesariamente puede leer esas credenciales — es un límite de confianza, no de este control. |

## Alcance y limitaciones de este modelo

- No cubre la Fase 6 (observabilidad) porque todavía no existe en el sistema.
- No modela amenazas de la infraestructura de Supabase en sí (gestionada por
  un tercero) más allá de "qué pasa si se filtran sus credenciales", que sí
  está cubierto (#5, #13).
- Las categorías STRIDE no cubiertas explícitamente arriba (p. ej. Spoofing
  del rol admin) heredan las mismas mitigaciones ya documentadas en
  `docs/decisiones-y-riesgos.md`
  (bcrypt, JWT HS256 con verificación de algoritmo, etc.) y no se repiten aquí
  para no duplicar contenido.

# Manual de Arquitectura — LiveMetric

> Sistema de Elecciones y Escrutinio en Tiempo Real
> Este documento corresponde a la sección 4.2 de la documentación obligatoria del curso. Los diagramas de componentes, despliegue, secuencia, casos de uso y del modelo de datos están escritos en **Mermaid** (código versionable dentro del repositorio) y se renderizan de forma nativa al ver este archivo en GitHub. Los dos DFD son el modelo de amenazas de **OWASP Threat Dragon**, exportado desde la herramienta.

## Tabla de contenido

1. [Alcance y estilo arquitectónico](#1-alcance-y-estilo-arquitectónico)
2. [Patrones de diseño aplicados](#2-patrones-de-diseño-aplicados)
3. [Componentes y justificación](#3-componentes-y-justificación)
4. [Diagrama de Componentes](#4-diagrama-de-componentes)
5. [Diagrama de Despliegue](#5-diagrama-de-despliegue)
6. [Diagrama de Secuencia — Autenticación](#6-diagrama-de-secuencia--autenticación-de-votante)
7. [Diagrama de Casos de Uso](#7-diagrama-de-casos-de-uso)
8. [DFD Nivel 0](#8-dfd-nivel-0)
9. [DFD Nivel 1](#9-dfd-nivel-1)
10. [Decisiones de diseño (registro tipo ADR)](#10-decisiones-de-diseño-registro-tipo-adr)
11. [Modelo de datos (resumen)](#11-modelo-de-datos-resumen)

---

## 1. Alcance y estilo arquitectónico

LiveMetric es un **sistema de elecciones y escrutinio en tiempo real**, no un sistema genérico de encuestas: su valor central es garantizar que el resultado de una elección sea **íntegro y verificable por un tercero**, no solo "recolectar clics". Esa exigencia (más cercana a un sistema financiero o notarial que a un formulario) es la que determina casi todas las decisiones de arquitectura descritas en este documento.

El sistema se implementa como una **arquitectura de microservicios** con seis unidades desplegables independientes — un frontend SPA, cuatro microservicios HTTP y un worker asíncrono — sobre el principio **Local-First**: todo el stack corre en contenedores Docker en una máquina local, sin depender de ningún servicio en la nube, usando exclusivamente herramientas de código abierto.

Estilo arquitectónico resumido:

| Atributo | Decisión | Motivo |
|---|---|---|
| Descomposición | Por **dominio de negocio** (identidad, votación, analítica, escrutinio), no por capa técnica | Cada servicio tiene un único motivo para cambiar (Single Responsibility a nivel de servicio) |
| Comunicación | HTTP síncrono (REST) entre frontend↔backend y entre `scheduler-worker`↔`scrutiny-service` | Simplicidad operativa; el volumen de este dominio (elecciones, no big data) no justifica un broker de mensajería |
| Persistencia | **Base de datos compartida** (PostgreSQL) entre los cuatro microservicios | Simplificación consciente para el alcance del proyecto (ver ADR-005); se documenta como trade-off, no como descuido |
| Confianza entre servicios | **Zero-trust interno**: cada llamada entre servicios se autentica (JWT de rol o token de servicio), incluso dentro de la red privada | Un atacante que comprometa un contenedor no hereda automáticamente privilegios sobre los demás |
| Estado de la UI | Sesión (JWT) **solo en memoria** del navegador, nunca en `localStorage` | Un puesto de votación es un equipo compartido; recargar la página cierra la sesión por diseño |

---

## 2. Patrones de diseño aplicados

| Patrón | Dónde se usa | Por qué |
|---|---|---|
| **Append-only ledger** (libro contable inmutable) | `scrutiny_ledger`, `audit_log` (trigger de PostgreSQL que rechaza `UPDATE`/`DELETE`) | Un acta certificada o un evento de auditoría no debe poder reescribirse ni siquiera con acceso directo a la base de datos |
| **Hash chain** (cadena de hashes, patrón simplificado de blockchain) | Certificación en `scrutiny-service`: `record_hash = SHA256(previous_hash + resultados)` | Permite detectar si un acta antigua fue alterada: la alteración rompe visiblemente la cadena hacia adelante |
| **Firma digital** (Ed25519) | `scrutiny-service` firma el `record_hash` de cada acta con su clave privada; `analytics-service` la verifica con la pública | La cadena de hashes no usa secretos: quien pudiera escribir en la base podría rehacerla. La firma prueba además **quién** emitió el acta, y alimenta el indicador de veracidad |
| **Snapshot / copia en el momento de creación** | `election_options` copia `label`/`candidate_number`/`logo` desde `template_options` al instanciar la elección | Si la plantilla se edita después, las elecciones ya creadas no cambian retroactivamente |
| **Defensa en profundidad** | Anti-doble-voto: validación de tipos + transacción + `UNIQUE(election_id, voter_id_hash)` en BD | Ninguna capa individual es el único punto de falla |
| **Identidad pseudonimizada** | `voter_id_hash = SHA256(cedula + salt privado de Auth)` | Ningún otro servicio ve la cédula en texto plano; el salt nunca sale de Auth |
| **Token de servicio interno** (distinto de JWT de usuario) | `X-Internal-Token` entre `scheduler-worker` y `scrutiny-service`, comparado con `timingSafeEqual` | Ni un admin ni un votante deben poder disparar una certificación manualmente; solo el propio sistema |
| **Poller asíncrono** (worker con `node-cron`) en vez de cola de mensajes | `scheduler-worker` | Para el volumen de este dominio, un tick por minuto que revisa "¿qué elección debe abrir/cerrar?" es más simple de operar y depurar que un broker (RabbitMQ/Kafka) sin aportar beneficio real a esta escala |
| **Rol explícito por token** (RBAC vía claim `role`) | Middlewares `requireAdmin` / `requireVoter` en cada servicio | Un JWT de votante nunca es válido en una ruta `/admin/*`, y viceversa, verificado en cada servicio de forma independiente (no solo en un gateway central) |

---

## 3. Componentes y justificación

### 3.1 Frontend (React + Vite + nginx)

**Responsabilidad:** interfaz para administradores (gestión de plantillas, elecciones, padrón, usuarios, auditoría, reportes y escrutinio), para auditores (resultados y reportes, solo lectura), para jurados de mesa (su mesa y los votantes asistidos que pueden autorizar) y para votantes (login con cédula, PIN y segundo factor; boleta, confirmación de voto). Su nginx es además el **único punto de entrada** del sistema: reenvía `/auth`, `/voting`, `/analytics` y `/scrutiny` a cada microservicio.

**Por qué así:** una SPA evita recargas de página completas durante el flujo de votación (importante en un puesto físico con muchos votantes en fila). Se sirve con nginx en producción (no con el servidor de desarrollo de Vite) porque nginx es el estándar de facto para servir estáticos de forma eficiente y porque permite inyectar configuración en tiempo de arranque del contenedor (ver `docker-entrypoint.sh`) sin reconstruir la imagen.

**Decisión de seguridad notable:** nginx corre entero sin root, también su proceso maestro (ADR-006). Escucha en el puerto 8080 dentro del contenedor, porque un usuario sin privilegios no puede abrir puertos menores a 1024 (hacia afuera sigue siendo el 3000), y todo lo que escribe (buffers, pid y el `config.js` generado al arrancar) va a `/tmp`, lo único escribible de un sistema de archivos de solo lectura. Envía además una Content-Security-Policy estricta y las cabeceras de aislamiento del navegador (`cabeceras-seguridad.conf`).

### 3.2 Microservicio A — Auth

**Responsabilidad:** dos flujos de login completamente distintos (administrador, auditor o jurado con usuario y contraseña; votante con cédula y un PIN de 6 dígitos que genera el administrador), el **segundo factor** de votantes y jurados (TOTP, RFC 6238: registro del autenticador con QR, verificación del código y la autorización del jurado en el voto asistido), gestión de identidad (crear administradores, auditores y jurados; cargar el padrón electoral cifrado; generar y regenerar PIN con su vencimiento; restablecer autenticadores; marcar el voto asistido) y el módulo de auditoría.

**Por qué es un servicio separado:** la autenticación es el único lugar del sistema que debe conocer el salt privado usado para pseudonimizar la cédula (`VOTER_ID_SALT`). Aislarlo minimiza la superficie de código que maneja ese secreto.

### 3.3 Microservicio B — Voting

**Responsabilidad:** votación pública (`POST /vote`) y administración del ciclo de vida de la elección: plantillas (genéricas o presidenciales), instanciación de elecciones con ventana de tiempo, y detención manual.

**Por qué votación y administración conviven en el mismo servicio:** ambas operan sobre el mismo agregado de datos (`elections`, `election_options`, `votes`) y comparten las mismas invariantes de integridad (ej. "no se puede votar en una elección que no está `active`"); separarlas en dos servicios distintos obligaría a sincronizar esa regla de negocio en dos lugares.

### 3.4 Microservicio C — Analytics

**Responsabilidad:** exclusivamente **lectura** de resultados. Mientras la elección no tiene acta, solo publica cuántos votaron: los votos por opción, y todo lo que se deriva de ellos (orden, concentración, quién va adelante), no salen del servicio hasta que el escrutinio certifica el acta, para que un resultado parcial no influya en quien todavía no votó. Con el acta, sirve el acta certificada.

**Por qué es un servicio separado de Voting:** separa el camino de escritura (votar) del camino de lectura (consultar resultados), que tienen perfiles de carga y de seguridad distintos — Analytics nunca necesita aceptar un voto, así que no expone esa superficie de ataque.

### 3.5 Microservicio D — Scrutiny

**Responsabilidad:** recuento **independiente** desde los votos crudos (nunca reutiliza el cálculo de Analytics), consolidación por mesa de votación, determinación del ganador, certificación con cadena de hashes, y generación del Acta de Escrutinio en PDF.

**Por qué es un servicio separado de Analytics (la decisión más importante del proyecto):** si Scrutiny reutilizara el mismo código de conteo que Analytics, un error o una manipulación en esa única pieza de lógica falsearía tanto lo que se muestra en pantalla como lo que queda certificado, sin ninguna capa independiente que lo detecte. Al vivir en un servicio propio, con su propia consulta SQL sobre `votes`, Scrutiny actúa como un "segundo escrutador" real, tal como en una elección física donde el conteo de mesa y la verificación posterior las hace gente distinta.

### 3.6 Worker — Scheduler

**Responsabilidad:** proceso asíncrono (`node-cron`, sin servidor HTTP de negocio) que activa elecciones al llegar `scheduled_start`, las cierra al llegar `scheduled_end` (o detecta un cierre manual), y dispara la certificación en Scrutiny.

**Por qué existe como proceso separado y no como un `setInterval` dentro de Voting:** si el temporizador viviera dentro de Voting, un reinicio o una caída de ese servicio detendría silenciosamente el cierre automático de elecciones. Como proceso independiente, su único trabajo es "vigilar el reloj", y su caída no afecta la capacidad de votar o consultar resultados — solo retrasa la activación/cierre hasta que se recupere.

### 3.7 Base de datos — PostgreSQL

**Responsabilidad:** persistencia relacional de todo el dominio, incluyendo las dos tablas append-only (`scrutiny_ledger`, `audit_log`).

**Por qué PostgreSQL y no un motor NoSQL:** el dominio electoral es intrínsecamente relacional (una elección tiene opciones, un voto referencia una opción y una elección, un votante pertenece a un puesto y una mesa) y depende de **transacciones ACID** para las invariantes críticas (el `UNIQUE(election_id, voter_id_hash)` que impide el doble voto solo es confiable dentro de una transacción).

---

## 4. Diagrama de Componentes

```mermaid
graph TB
    subgraph Cliente["Navegador del usuario"]
        FE["Frontend SPA<br/>React + nginx<br/>:3000"]
    end

    subgraph Backend["Backend — red app-net"]
        AUTH["Auth<br/>(A)<br/>login dual · identidad · auditoría"]
        VOTING["Voting<br/>(B)<br/>votación · plantillas · elecciones"]
        ANALYTICS["Analytics<br/>(C)<br/>total en vivo / resultados certificados"]
        SCRUTINY["Scrutiny<br/>(D)<br/>recuento independiente · hash chain · acta PDF"]
        SCHEDULER["Scheduler<br/>(worker, node-cron)<br/>sin puerto público"]
    end

    subgraph Datos["Persistencia — red db-net (interna)"]
        DB[("PostgreSQL<br/>elections · votes · voters<br/>scrutiny_ledger · audit_log")]
    end

    FE -->|"POST /login/admin<br/>POST /login/voter"| AUTH
    FE -->|"POST /vote<br/>/admin/elections<br/>/admin/templates"| VOTING
    FE -->|"GET /api/elections/:id/results"| ANALYTICS
    FE -->|"GET /certifications/:id<br/>GET .../acta.pdf<br/>GET /verify"| SCRUTINY

    SCHEDULER -->|"POST /internal/certify/:id<br/>(X-Internal-Token)"| SCRUTINY

    AUTH --> DB
    VOTING --> DB
    ANALYTICS --> DB
    SCRUTINY --> DB
    SCHEDULER --> DB

    classDef svc fill:#1b2530,stroke:#b8860b,color:#fff;
    classDef db fill:#f3ede0,stroke:#1b2530,color:#1b2530;
    class AUTH,VOTING,ANALYTICS,SCRUTINY,SCHEDULER,FE svc;
    class DB db;
```

**Lectura del diagrama:** el frontend nunca habla directamente con la base de datos ni con el worker; solo consume las APIs HTTP de los cuatro microservicios. El worker es el único componente que le habla a Scrutiny con un mecanismo de autenticación distinto (token de servicio) al resto del sistema (JWT de usuario).

---

## 5. Diagrama de Despliegue

```mermaid
graph TB
    Navegador(["Navegador<br/>(red local)"])

    subgraph Host["PC con Docker"]
        subgraph appnet["Red app-net (bridge)"]
            C_FE["Contenedor: frontend<br/>nginx:1.30-alpine, sin root<br/>8080 → 0.0.0.0:3000"]
            C_AUTH["Contenedor: auth-service<br/>node:20-alpine<br/>3001 (solo 127.0.0.1)"]
            C_VOTING["Contenedor: voting-service<br/>node:20-alpine<br/>3002 (solo 127.0.0.1)"]
            C_ANALYTICS["Contenedor: analytics-service<br/>node:20-alpine<br/>3003 (solo 127.0.0.1)"]
            C_SCRUTINY["Contenedor: scrutiny-service<br/>node:20-alpine<br/>3004 (solo 127.0.0.1)"]
            C_SCHED["Contenedor: scheduler-worker<br/>node:20-alpine<br/>sin puerto"]
        end
        subgraph dbnet["Red db-net (internal: true, sin salida a Internet ni al host)"]
            C_DB["Contenedor: postgres<br/>postgres:16-alpine<br/>sin puerto"]
        end
        V_PG[("Volumen: db-data")]
        C_MIG["Contenedor: migraciones<br/>postgres:16-alpine<br/>corre una vez y termina"]
    end

    Navegador -->|"HTTP :3000"| C_FE
    C_FE -->|"/auth"| C_AUTH
    C_FE -->|"/voting"| C_VOTING
    C_FE -->|"/analytics"| C_ANALYTICS
    C_FE -->|"/scrutiny"| C_SCRUTINY
    C_SCHED -.->|"X-Internal-Token"| C_SCRUTINY

    C_AUTH --- C_DB
    C_VOTING --- C_DB
    C_ANALYTICS --- C_DB
    C_SCRUTINY --- C_DB
    C_SCHED --- C_DB

    C_MIG -->|"db-net · db/migrations/"| C_DB
    C_DB --> V_PG

    classDef net fill:none,stroke:#b8860b,stroke-dasharray: 4 3;
    class appnet,dbnet net;
```

**Notas de despliegue:**
- El navegador solo habla con el frontend, el único puerto abierto a la red local (3000). nginx reenvía cada ruta del API a su servicio dentro de `app-net`, resolviéndolo en cada petición: el stack arranca en cualquier orden.
- Los servicios publican su puerto solo en `127.0.0.1`, para probar el API desde la misma PC; en Swarm no publican ninguno.
- `db-net` está marcada `internal: true`: PostgreSQL no tiene salida a Internet ni es alcanzable desde el host, y el frontend no está conectado a esa red. Solo los 5 servicios de backend llegan a la base.
- Los seis servicios de la aplicación corren sin root, con el sistema de archivos de solo lectura (salvo `/tmp`) y sin poder ganar privilegios (`no-new-privileges` en compose, `cap_drop: ALL` en Swarm).
- `migraciones` es una tarea de una sola vez: en cada arranque, antes que los servicios, le aplica a la base las migraciones de `db/migrations/` (todas idempotentes) y termina. Así una base creada con una versión anterior se pone al día sola.
- El volumen `db-data` es el único estado persistente. Borrarlo (`docker compose down -v`) deja una base vacía, sin administradores: el primero se crea con `crearAdmin.js`.
- Terraform (`infra/terraform/main.tf`) reproduce esta misma topología con el provider `kreuzwerker/docker`, y Docker Swarm (`orquestacion/docker-stack.yml`) la despliega con réplicas y la red overlay cifrada.

---

## 6. Diagrama de Secuencia — Autenticación de votante

Se eligió el login de votante como flujo crítico (en vez del de administrador) porque concentra las decisiones de seguridad propias de este dominio: el votante se identifica con un dato que otros pueden conocer (su cédula), así que necesita un secreto que solo él conozca (el PIN) y algo que solo él tenga (su app autenticadora, o en el voto asistido, el jurado de su mesa); de ahí en adelante todo el sistema opera sobre una identidad pseudonimizada.

```mermaid
sequenceDiagram
    actor Votante
    participant FE as Frontend (nginx + React)
    participant AUTH as Auth
    participant DB as PostgreSQL

    Votante->>FE: Ingresa cédula y PIN
    FE->>AUTH: POST /auth/login/voter {cedula, pin}
    AUTH->>AUTH: Límite: 8 intentos fallidos cada 15 min por IP
    AUTH->>AUTH: Valida el formato de cédula y PIN
    AUTH->>DB: SELECT … FROM voters WHERE cedula = cifrado(cedula)
    DB-->>AUTH: votante {activo, puesto y mesa cifrados, bcrypt del PIN}

    alt Votante activo, PIN vigente y correcto (bcrypt)
        AUTH-->>FE: 200 {next: codigo | registro | jurado, desafío de 5 min sin rol}
    else PIN vencido (y correcto)
        AUTH->>DB: INSERT INTO audit_log (LOGIN_FAILURE_VOTER, pin_vencido)
        AUTH-->>FE: 403 "Tu PIN venció"
    else No existe, inactivo, sin PIN o PIN incorrecto
        AUTH->>DB: INSERT INTO audit_log (LOGIN_FAILURE_VOTER, motivo)
        AUTH-->>FE: 401 "Cédula o PIN incorrectos" (el mismo mensaje en todos los casos)
        FE-->>Votante: Error de acceso
    end

    alt Primer ingreso (registro)
        FE-->>Votante: QR y clave para su app autenticadora
        Votante->>FE: Código de 6 dígitos de la app
        FE->>AUTH: POST /auth/login/voter/registro {desafío, código}
        AUTH->>DB: Guarda el secreto cifrado, solo si no tenía uno
    else Con autenticador
        Votante->>FE: Código de 6 dígitos de la app
        FE->>AUTH: POST /auth/login/voter/codigo {desafío, código}
    else Voto asistido
        Votante->>FE: El jurado de su mesa escribe su usuario y su código
        FE->>AUTH: POST /auth/login/voter/asistido {desafío, jurado, código}
        AUTH->>AUTH: Jurado de la misma mesa que el votante
    end
    AUTH->>AUTH: TOTP válido (±30 s) y posterior al último usado (un solo uso)
    AUTH->>AUTH: voterIdHash = SHA256(cedula + salt privado)
    AUTH->>AUTH: Firma JWT HS256 {role: "voter", voterIdHash,<br/>puesto, mesa} que vence en 10 min
    AUTH->>DB: INSERT INTO audit_log (LOGIN_SUCCESS_VOTER, y en el asistido ASSISTED_LOGIN_AUTHORIZED)
    AUTH-->>FE: 200 {token, puesto, mesa}
    FE-->>Votante: Boleta de las elecciones abiertas

    Note over Votante,DB: Ningún servicio distinto de Auth conoce la cédula en texto plano<br/>ni el salt del hash. El JWT solo vive en la memoria de la página.
```

---

## 7. Diagrama de Casos de Uso

> Mermaid no tiene un tipo de diagrama nativo "Use Case" con la notación UML clásica (actor + óvalos); se representa aquí con la notación de flujo equivalente, agrupando los casos de uso por actor dentro del límite del sistema.

```mermaid
graph LR
    Admin(("👤 Administrador"))
    Auditor(("👤 Auditor"))
    Jurado(("👤 Jurado de mesa"))
    Votante(("👤 Votante"))
    Reloj(("⏱️ Worker Scheduler"))

    subgraph Sistema["Sistema LiveMetric"]
        UC1(["Iniciar sesión"])
        UC2(["Crear plantillas<br/>(genéricas / presidenciales)"])
        UC3(["Programar elección"])
        UC4(["Detener elección"])
        UC5(["Consultar el total en vivo<br/>y los resultados certificados<br/>con el sello de veracidad"])
        UC6(["Descargar Acta<br/>de Escrutinio (PDF)"])
        UC7(["Verificar las actas<br/>(hash, cadena y firma)"])
        UC8(["Crear administradores,<br/>auditores y jurados"])
        UC9(["Cargar padrón, generar PIN<br/>y marcar el voto asistido"])
        UC10(["Consultar log<br/>de auditoría"])
        UC15(["Armar tableros<br/>de reportes"])
        UC16(["Ver tableros<br/>de reportes"])
        UC11(["Consultar elecciones activas"])
        UC12(["Emitir voto"])
        UC17(["Consultar su historial<br/>(sin elección ni opción)"])
        UC18(["Registrar el autenticador<br/>(primer ingreso)"])
        UC19(["Autorizar un voto asistido<br/>de su mesa o su puesto"])
        UC13(["Activar / cerrar<br/>elecciones por horario"])
        UC14(["Certificar y firmar el acta"])
    end

    Admin --> UC1
    Admin --> UC2
    Admin --> UC3
    Admin --> UC4
    Admin --> UC5
    Admin --> UC6
    Admin --> UC7
    Admin --> UC8
    Admin --> UC9
    Admin --> UC10
    Admin --> UC15
    Admin --> UC16

    Auditor --> UC1
    Auditor --> UC5
    Auditor --> UC16

    Jurado --> UC1
    Jurado --> UC18
    Jurado --> UC19

    Votante --> UC1
    Votante --> UC18
    Votante --> UC11
    Votante --> UC12
    Votante --> UC17

    Reloj --> UC13
    Reloj --> UC14
```

---

## 8. DFD Nivel 0

Los dos DFD son el modelo de amenazas de OWASP Threat Dragon
([`threat-model/livemetric.threatdragon.json`](threat-model/livemetric.threatdragon.json)),
exportados desde la propia herramienta: los mismos diagramas sobre los que se
analizaron las 19 amenazas STRIDE de
[`threat-model/STRIDE-analysis.md`](threat-model/STRIDE-analysis.md). Las líneas
punteadas son fronteras de confianza, y el flujo en rojo, el que tiene una amenaza
abierta (el repudio del voto, aceptado por diseño para preservar el anonimato).

![DFD de nivel 0: votante, administrador y auditor frente al sistema LiveMetric y su base de datos](threat-model/dfd-nivel-0.png)

[Versión vectorial (SVG)](threat-model/dfd-nivel-0.svg)

---

## 9. DFD Nivel 1

El sistema desagregado en sus cinco servicios y en los cuatro almacenes lógicos de
la base (todos en el mismo PostgreSQL). Las dos fronteras son las dos redes de
Docker: `app-net`, donde corren los servicios, y `db-net`, interna, a la que solo
llegan los servicios que usan la base.

![DFD de nivel 1: flujos entre actores, los cinco servicios y los almacenes padrón, audit log, elecciones y votos, y acta de escrutinio](threat-model/dfd-nivel-1.png)

[Versión vectorial (SVG)](threat-model/dfd-nivel-1.svg)

---

## 10. Decisiones de diseño (registro tipo ADR)

| # | Decisión | Alternativa considerada | Por qué se eligió esta opción |
|---|---|---|---|
| ADR-001 | Scrutiny es un microservicio separado de Analytics | Calcular el "acta" dentro de Analytics reutilizando su misma consulta | Un recuento "oficial" no puede depender del mismo código que el recuento "informativo"; deben ser dos implementaciones independientes para que una sirva de control de la otra |
| ADR-002 | Anti-doble-voto anclado a `voter_id_hash` (identidad real) | Fingerprint de IP + User-Agent (usado en una iteración temprana del proyecto) | El fingerprint es trivial de burlar (otra red, modo incógnito); la identidad real, aunque pseudonimizada, es estable por persona |
| ADR-003 | JWT de votante con expiración de 10 minutos | Misma expiración que el JWT de administrador (1 hora) | El login de votante no protege un secreto real (cédula = usuario y contraseña); acortar la ventana de validez es el control compensatorio principal frente a ese riesgo aceptado |
| ADR-004 | `scheduler-worker` como proceso independiente con `node-cron` | `setInterval` dentro de `voting-service`, o un cron del sistema operativo host | Aísla el fallo: si el worker cae, votar y consultar resultados siguen funcionando; solo se retrasa la apertura/cierre automático |
| ADR-005 | Base de datos compartida entre los cuatro microservicios | Una base de datos por servicio (patrón "database per service" puro) | Simplificación consciente para el alcance del proyecto: las invariantes transaccionales críticas (`UNIQUE` anti-doble-voto) exigen que "votes" y "elections" convivan en la misma base transaccional; se documenta como deuda técnica aceptada, no como omisión |
| ADR-006 | nginx (frontend) corre entero sin root, también su proceso maestro | Dejar el maestro como `root`, el modelo estándar de la imagen oficial (solo los *workers* sin privilegios) | Fue la decisión inicial, porque forzar no-root rompía la escritura y la apertura del puerto 80; Semgrep lo señaló y se resolvió de raíz: nginx escucha en el 8080 (hacia afuera, el 3000) y escribe solo en `/tmp`. Así ninguno de los seis servicios de la aplicación corre como root, y la misma imagen funciona en compose, Swarm y Terraform |
| ADR-007 | Terminología del dominio: "elección", nunca "encuesta" | Mantener "poll/encuesta" como en la primera iteración del proyecto | El valor del sistema es la integridad electoral, no la recolección de opiniones; el lenguaje del código y la UI debe reflejar ese dominio para evitar decisiones de diseño "de encuesta" (ej. permitir cambiar el voto) que serían incorrectas en un contexto electoral |
| ADR-008 | El Acta de Escrutinio se genera como PDF real (`pdfkit`) | Mostrar solo un JSON/tabla en el panel de administración | El escrutinio de una elección real termina en un documento firmable; un JSON en pantalla no cumple esa función simbólica ni práctica (no se puede archivar, imprimir ni entregar) |
| ADR-009 | Cada acta se firma con Ed25519, además de encadenarse por hash | Solo la cadena de hashes (como hasta la v1.2.0) | La cadena detecta cambios sueltos, pero no a quien reescribe el acta y recalcula todos los hashes; la firma solo la puede producir quien tiene la clave privada (solo Scrutiny). Ed25519 viene en el módulo `crypto` de Node, sin dependencias nuevas, con claves y firmas cortas (32 y 64 bytes) |

---

## 11. Modelo de datos (resumen)

```mermaid
erDiagram
    ADMINS ||--o{ ELECTION_TEMPLATES : crea
    ADMINS ||--o{ ELECTIONS : crea
    ADMINS ||--o{ VOTERS : registra
    ELECTION_TEMPLATES ||--o{ TEMPLATE_OPTIONS : contiene
    ELECTION_TEMPLATES ||--o{ ELECTIONS : instancia
    ELECTIONS ||--o{ ELECTION_OPTIONS : contiene
    ELECTIONS ||--o{ VOTES : recibe
    ELECTION_OPTIONS ||--o{ VOTES : referencia
    ELECTIONS ||--o| SCRUTINY_LEDGER : certifica
    ELECTIONS ||--o{ REPORT_DASHBOARDS : tiene

    ADMINS {
        int id PK
        string username
        string password_hash
        string role "admin, auditor o jurado"
        string polling_place "solo jurado, cifrado"
        string voting_table "solo jurado, cifrada (vacía: todo el puesto)"
        string totp_secret "cifrado"
    }
    VOTERS {
        int id PK
        string cedula "cifrada"
        string full_name
        string polling_place "cifrado"
        string voting_table "cifrada"
        bool is_active
        string access_code_hash "bcrypt del PIN"
        timestamp access_code_expires_at "vencimiento del PIN"
        string totp_secret "cifrado"
        bool assisted
    }
    ELECTION_TEMPLATES {
        int id PK
        string name
        string template_type
    }
    TEMPLATE_OPTIONS {
        int id PK
        int template_id FK
        string label
        string candidate_number
        text logo
    }
    ELECTIONS {
        int id PK
        string title
        string status
        timestamp scheduled_start
        timestamp scheduled_end
        bool stopped_manually
    }
    ELECTION_OPTIONS {
        int id PK
        int election_id FK
        string label
        string candidate_number
        text logo
    }
    VOTES {
        int id PK
        int election_id FK
        int option_id FK
        string voter_id_hash
        string polling_place
        string voting_table
    }
    SCRUTINY_LEDGER {
        int id PK
        int election_id FK
        int total_votes
        jsonb results
        string previous_hash
        string record_hash
        string signature
        string signing_key_id
    }
    REPORT_DASHBOARDS {
        int id PK
        int election_id FK
        string name
        jsonb layout
    }
    AUDIT_LOG {
        bigint id PK
        string event_type
        string actor_type
        string actor_ref
        string ip_address
        jsonb metadata
    }
```

*(`AUDIT_LOG` no tiene llave foránea hacia otras tablas — es intencional: el log de auditoría no debe depender referencialmente de los registros que audita, para que siga existiendo aunque el recurso auditado cambie o se elimine.)*

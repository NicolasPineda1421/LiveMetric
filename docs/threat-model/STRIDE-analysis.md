# Modelo de amenazas — LiveMetric

Este documento es la versión legible del modelo formal en
[`livemetric.threatdragon.json`](./livemetric.threatdragon.json), pensado para
abrirse en [OWASP Threat Dragon](https://www.threatdragon.com/) (web o
desktop). Los diagramas de flujo de datos (DFD) reflejan la arquitectura real
del sistema (ver `docs/arquitectura.md`), no un ejemplo genérico: cada
amenaza está anclada a un flujo o proceso que existe de verdad en el código,
y cita la mitigación real ya implementada cuando la hay.

## Cómo se generan los diagramas

Las dos imágenes de abajo las dibujó y exportó **OWASP Threat Dragon 2.6.2** a
partir de `livemetric.threatdragon.json`: son el modelo mismo, no un dibujo
aparte. Para abrirlo en la versión web, se entra con *Login to Local Session*,
se va a la página de importación (`/#/local/threatmodel/import`), se pega el
contenido del archivo y se pulsa *Import*; en la de escritorio, se abre el
archivo con *Open an existing threat model*. Cada diagrama se abre haciendo
clic en su título. Cada vez que el modelo
cambia, las imágenes se vuelven a exportar desde el menú *Export* del
diagrama (PNG y SVG) y se reemplazan aquí.

En los diagramas, las líneas punteadas son las fronteras de confianza y el
flujo en rojo es el que tiene una amenaza abierta (la 3, aceptada por diseño).

## DFD Nivel 0 — Contexto

![DFD de nivel 0 de LiveMetric, exportado de OWASP Threat Dragon](./dfd-nivel-0.png)

[Versión vectorial (SVG)](./dfd-nivel-0.svg)

## DFD Nivel 1 — Desagregado por microservicio

![DFD de nivel 1 de LiveMetric, exportado de OWASP Threat Dragon](./dfd-nivel-1.png)

[Versión vectorial (SVG)](./dfd-nivel-1.svg)

Los mismos flujos, en texto:

```
Votante ──login(cédula+PIN)──▶ auth-service ──desafío (5 min, sin rol)──▶ Votante
Votante ──código del autenticador (o, si es asistido, usuario y código del jurado)──▶ auth-service ──JWT votante (10 min)──▶ Votante
Votante ──emitir voto (JWT)───▶ voting-service ──INSERT voto──▶ [Elecciones y votos]
Votante ──/my-votes───────────▶ voting-service ──SELECT (sin election/option)──▶ Votante

Administrador ──login/gestión padrón/usuarios──▶ auth-service ──R/W cifrado──▶ [Padrón (voters)]
Administrador ──crear plantillas/elecciones────▶ voting-service ──R/W──▶ [Elecciones y votos]
    voting-service ──escribe evento (detención manual)──▶ [Audit log]
Administrador/Auditor ──resultados/métricas/reportes──▶ analytics-service
    analytics-service ──lectura (en vivo)──▶ [Elecciones y votos]
    analytics-service ──lectura (participación)──▶ [Padrón (voters)]
    analytics-service ──lectura (si cerrada/certificada)──▶ [Acta de escrutinio]
    analytics-service ──lectura (métricas de auditoría)──▶ [Audit log]

scheduler-worker ──cambia status──▶ [Elecciones y votos]
scheduler-worker ──dispara certificación (INTERNAL_SERVICE_TOKEN)──▶ scrutiny-service
    scrutiny-service ──lee votos──▶ [Elecciones y votos]
    scrutiny-service ──escribe acta (hash encadenado)──▶ [Acta de escrutinio]
Administrador/Auditor ──descarga acta PDF / verificar cadena──▶ scrutiny-service

auth-service ──escribe y consulta eventos──▶ [Audit log] (append-only)
```

Almacenes de datos (todos en el mismo PostgreSQL local de la instalación,
separados aquí por responsabilidad):

- **Padrón (voters)**: `cedula`, `polling_place`, `voting_table` cifrados
  (AES-256-GCM); `full_name` en texto plano; `access_code_hash` (bcrypt del
  PIN) y `access_code_expires_at` (su vencimiento); `totp_secret` (el
  secreto del autenticador, cifrado) y `assisted` (si vota asistido).
- **Elecciones y votos**: `elections`, `election_options`, `votes`
  (`voter_id_hash`, nunca la cédula).
- **Acta de escrutinio**: `scrutiny_ledger`, append-only, hash SHA-256
  encadenado.
- **Audit log**: `audit_log`, append-only (trigger `trg_audit_no_update`).

## Amenazas STRIDE

| # | Elemento | Categoría STRIDE | Amenaza | Estado | Mitigación / justificación |
|---|---|---|---|---|---|
| 1 | Flujo Votante → auth-service (login) | Spoofing | Alguien que conozca la cédula de un votante intenta suplantarlo | Mitigado | Login exige cédula **+ PIN** de 6 dígitos generado por el admin (no derivable de la cédula) — ver migración `003_voter_access_codes.sql` — **y un segundo factor**: el código de la app autenticadora del votante o, si vota asistido, la autorización del jurado de su mesa (migración `006_segundo_factor.sql`, amenazas 16 a 18). Antes del PIN, usuario y contraseña eran ambos la cédula. |
| 2 | Flujo Votante → auth-service (login) | Denial of Service | Fuerza bruta del PIN de votante | Mitigado | Rate limiting: 8 intentos **fallidos** cada 15 min por IP (`voterLoginLimiter`, `services/auth/src/app.js`); los ingresos correctos no cuentan, para que un puesto con un solo equipo atienda a todos sus votantes. Además, el reporte de accesos sospechosos detecta PIN fallidos repetidos para una misma cédula. Además, cada PIN vence (como máximo, a los 90 días), así que no se puede adivinar indefinidamente. |
| 3 | Flujo Votante → voting-service (emitir voto) | Repudiation | El votante niega haber votado, o alguien niega que fue él quien votó | Aceptado (por diseño) | El sistema registra que "un voto ocurrió" (`voter_id_hash`) pero deliberadamente NO liga el voto a la identidad real más allá de ese hash — es el trade-off de anonimato del voto, no un descuido. |
| 4 | Proceso auth-service ↔ Padrón (voters) | Tampering | Alguien con acceso directo a Postgres altera cédula/puesto/mesa de un votante | Mitigado (parcial) | Cifrado AES-256-GCM en reposo (`services/auth/src/voterCrypto.js`). Residual: nonce determinístico (necesario para poder buscar `WHERE cedula = ...`) permite notar si dos filas cifran igual, aunque no leer el valor. |
| 5 | Proceso auth-service ↔ Padrón (voters) | Information Disclosure | Una fuga de la base de datos expone identidades del padrón | Mitigado | `cedula`, `polling_place`, `voting_table` cifrados; solo `full_name` queda en texto plano a propósito (gestión legible del padrón). |
| 6 | Proceso voting-service (`/vote`) | Elevation of Privilege | Un votante emite más de un voto en la misma elección | Mitigado | Restricción `UNIQUE(election_id, voter_id_hash)` a nivel de base de datos — no depende solo de lógica de aplicación. |
| 7 | Proceso voting-service (`/vote`) | Tampering | Votar fuera de la ventana de tiempo programada, o tras un cierre manual | Mitigado | Se valida `status = 'active' AND now() BETWEEN scheduled_start AND scheduled_end` en cada voto, no solo al abrir la elección. |
| 8 | Flujo scheduler-worker → scrutiny-service | Spoofing | Un servicio no autorizado dispara una certificación falsa | Mitigado | `INTERNAL_SERVICE_TOKEN` compartido solo entre `scheduler-worker` y `scrutiny-service`, nunca expuesto al navegador. |
| 9 | Almacén Acta de escrutinio (`scrutiny_ledger`) | Tampering | Alterar el resultado de un acta ya certificada | Mitigado | Tabla append-only (trigger `prevent_row_mutation`) + cada acta encadena el hash de la anterior (`previous_hash`/`record_hash`); alterar una rompe la cadena hacia adelante de forma detectable (`/verify`). Ver también #15. |
| 10 | Almacén Audit log (`audit_log`) | Repudiation | Borrar o modificar el registro de un evento de login/gestión para ocultar un incidente | Mitigado | Trigger `trg_audit_no_update`, append-only igual que el acta de escrutinio. |
| 11 | Flujo Administrador/Auditor → analytics-service (tableros) | Elevation of Privilege | Un usuario con rol `auditor` (solo lectura) crea, edita o borra un tablero de reportes | Mitigado | Middleware `requireRole('admin','auditor')` para lectura vs. `requireRole('admin')` exclusivo para escritura, verificado en cada endpoint de `report_dashboards`. |
| 12 | Flujo navegador → frontend/proxy nginx | Information Disclosure | Exponer los 4 microservicios en puertos sueltos en vez de un solo origen aumenta la superficie de ataque | Mitigado | Proxy reverso en `nginx.conf`: el navegador solo habla con el origen del frontend; los backends nunca se exponen directamente fuera de la red interna de Docker. |
| 13 | Credenciales de despliegue (`.env`) | Information Disclosure | El archivo con todos los secretos se filtra al compartir el proyecto con un tercero | Mitigado | No hay un `.env` compartido que distribuir: cada instalación genera el suyo con secretos aleatorios (`scripts/lib/generar-env.js`, permisos 600) y tiene su propia base, así que filtrar uno compromete solo esa instalación. Nunca se commitea (`.gitignore`) ni entra a ninguna imagen. Quien controle la máquina donde corre puede leerlo: es un límite de confianza, no de este control. |
| 14 | Flujo frontend → Postgres | Elevation of Privilege | Un atacante que comprometa el frontend (lo único expuesto a la red local) intenta conectarse directo a la base | Mitigado | Postgres solo está en la red interna `db-net` (`internal: true`), sin puerto en la PC; a esa red solo están conectados los 5 servicios de backend, no el frontend. La contraseña de la base es aleatoria y propia de cada instalación. |
| 15 | Almacén Acta de escrutinio (`scrutiny_ledger`) | Tampering / Spoofing | Alguien con acceso total a la base se salta el trigger, cambia un acta y **recalcula todos los hashes** (la cadena no usa secretos), o inserta un acta que Scrutiny nunca emitió | Mitigado | Firma digital Ed25519 de cada acta (`services/scrutiny/src/actaSignature.js`): la clave privada (`ACTA_SIGNING_KEY`) la tiene solo `scrutiny-service`, y `analytics-service` verifica con la pública, por su cuenta. Sin la privada no se puede firmar el acta alterada: el indicador de veracidad (Resultados, Reportes, Escrutinio, PDF) la muestra como **alterada**. Residual: quien tenga el `.env` de la instalación tiene la clave privada. |
| 16 | Flujo Votante → auth-service (login) | Spoofing | Alguien con el PIN de otro votante (filtrado, perdido o visto al escribirlo en la mesa) entra en su nombre | Mitigado | Segundo factor: el código TOTP (RFC 6238, `services/auth/src/totp.js`) de la app autenticadora del votante —Microsoft o Google Authenticator—, de un solo uso (`totp_last_step`) y válido ±30 s. El secreto se guarda cifrado (AES-256-GCM). Con el PIN solo, auth-service entrega un desafío de 5 minutos sin rol, que ningún servicio acepta como sesión. Tres códigos fallidos con el PIN correcto generan la alerta `pin_sin_segundo_factor` en accesos sospechosos, y el PIN se oculta al escribirlo. El PIN, además, vence (en la fecha que se elige al generarlo, como máximo 90 días; por defecto, el cierre de la última elección programada; migraciones `007_vencimiento_pin.sql` y `008_pin_sin_vencimiento.sql`): un PIN viejo no sirve en una elección futura. Hasta que vence, sirve haya o no una votación abierta; votar solo se puede dentro del horario de la elección. |
| 17 | Flujo Votante → auth-service (registro del autenticador) | Spoofing | Alguien con la cédula y el PIN registra su propia app antes que el votante (confianza en el primer uso); el administrador conoce el PIN porque lo genera | Mitigado (parcial) | Un solo autenticador por cédula (`UPDATE … WHERE totp_secret IS NULL`): el votante que llega después ve que ya hay uno registrado y avisa. El registro queda en la auditoría (`VOTER_TOTP_ENROLLED`, con IP y hora) y el administrador lo restablece (`VOTER_TOTP_RESET`). Además, el registro solo es posible mientras el PIN no venció. Residual: el primer registro depende de que el PIN llegue solo al votante. |
| 18 | Flujo Votante → auth-service (voto asistido) | Spoofing | Un jurado cómplice de quien tenga el PIN de un votante asistido le abre la sesión con su propio código | Mitigado (parcial) | El jurado solo autoriza a votantes **de su mesa**, o de su puesto si el administrador lo asignó a todo el puesto (el lugar se elige del padrón y se compara sin depender de mayúsculas ni de cómo se escribió la mesa: `services/auth/src/lugares.js`) y marcados como asistidos por el administrador (`VOTER_ASSISTED_CHANGED`); coteja la cédula física en persona; su código es de un solo uso y su ingreso también exige segundo factor. Cada autorización queda en la auditoría con su nombre (`ASSISTED_LOGIN_AUTHORIZED`). Residual: la complicidad, igual que en una elección física. |
| 19 | Flujo Administrador → auth-service (login) | Spoofing | Alguien adivina la contraseña de un administrador (una débil, como `1234567890` o `Admin2026!`) y toma el control del padrón y de las elecciones | Mitigado (parcial) | Política de contraseñas para administradores, auditores y jurados (`services/auth/src/politicaContrasena.js`): de 12 a 128 caracteres, tres tipos de caracteres (o una frase de 16 o más), sin contraseñas comunes ni palabras comunes con números alrededor, sin secuencias y sin el nombre de usuario. La aplican el primer administrador (`crearAdmin.js`, que la vuelve a pedir en lugar de seguir sin administrador) y la pestaña Usuarios. Además, 10 intentos de login cada 15 minutos por IP, bcrypt con costo 12 y cada intento en la auditoría. Residual: el administrador entra solo con su contraseña (sin segundo factor); las creadas antes de esta política se reemplazan con `cambiarContrasena.js`. |
| 20 | Flujo Administrador → auth-service (carga del padrón desde un archivo) | Information Disclosure | Un nombre del archivo del padrón trae una fórmula (`=HYPERLINK(…)`, `=WEBSERVICE(…)`) que, al abrir en Excel la lista de PIN descargada, manda su contenido afuera o ejecuta algo en la PC del administrador (inyección de CSV) | Mitigado | Las listas que arma el panel (la de PIN y la plantilla, `services/frontend/src/utils/padronArchivo.js`) anteponen un apóstrofo a toda celda que empieza con `=`, `+`, `-`, `@` o un tabulador: Excel la muestra como texto. El archivo se lee en el navegador, y al servicio solo llegan los campos ya validados, con las mismas reglas que el formulario. |
| 21 | Lista de PIN descargada | Information Disclosure | La lista de PIN que descarga el administrador después de una carga masiva queda en su PC (en Descargas, en una carpeta compartida, en un correo) y otro la usa | Mitigado (parcial) | El PIN solo no abre la sesión: hace falta además el código del autenticador del votante o la autorización del jurado de su mesa (16 a 18), y vence en la fecha elegida (por defecto, al cierre de la elección). El panel avisa que el archivo es una credencial y que se borre después de entregar los PIN. Residual: guardarlo y borrarlo depende del administrador. |
| 22 | Flujo Administrador → auth-service (carga del padrón) | Denial of Service | Mandar cuerpos grandes a las rutas que agregan votantes para agotar la memoria o la CPU del servicio de autenticación | Mitigado | Todas las rutas leen a lo sumo 10 kB, salvo `POST /admin/voters` y `/admin/voters/bulk`, que aceptan 256 kB (hasta 200 votantes) y lo leen después de comprobar la sesión de administrador (`services/auth/src/app.js`), con el límite de 20 operaciones por minuto. Cada pedido genera a lo sumo 200 PIN con bcrypt. |

## Alcance y limitaciones de este modelo

- No modela el stack de observabilidad de la Fase 6 (`monitoring/`: Prometheus,
  Grafana, Loki, Falco) como parte del sistema: corre aparte, publica sus puertos
  solo en `127.0.0.1` y no se conecta a `db-net`, así que no llega a la base.
  Sí lee los logs de todos los contenedores (Promtail usa el socket de Docker en
  solo lectura) y cAdvisor corre con `privileged`: quien controle ese stack ve
  todo lo que los servicios registran, así que Grafana exige una contraseña
  propia (`GRAFANA_ADMIN_PASSWORD`, generada en el `.env`).
- No modela amenazas de la máquina donde corre la instalación (su sistema
  operativo y su motor de Docker): la base, su volumen y el `.env` viven
  ahí, así que quien controle esa máquina controla la instalación (#13).
  Sí cubre qué pasa si se filtran los datos o las credenciales (#5, #13).
- El jurado de mesa no aparece como entidad aparte en los diagramas: actúa
  dentro del flujo de login del votante, escribiendo su usuario y su código en
  el mismo equipo y en el mismo pedido (amenaza 18). Su propio ingreso al
  panel sigue el flujo de los administradores, también con segundo factor.
- Las categorías STRIDE no cubiertas explícitamente arriba heredan las mismas mitigaciones ya documentadas en
  `docs/decisiones-y-riesgos.md`
  (bcrypt, JWT HS256 con verificación de algoritmo, etc.) y no se repiten aquí
  para no duplicar contenido.

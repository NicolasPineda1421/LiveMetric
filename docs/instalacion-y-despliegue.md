# Instalación y despliegue

Hay cuatro formas de levantar LiveMetric. Todas usan el mismo `docker-compose.yml` (salvo Terraform) y el mismo `.env`.

| Forma | Qué hace | Qué necesita la PC |
|---|---|---|
| [`start.sh` / `start.bat`](#1-startsh--startbat-recomendada) | Corre el análisis de seguridad y, solo si pasa, levanta el stack | Docker (instala solo lo demás que falte) |
| [`contenedor.sh` / `contenedor.bat`](#2-contenedor-global-solo-docker) | Lo mismo, pero todo dentro de un contenedor global | Solo Docker |
| [`docker compose`](#3-docker-compose-directo) | Levanta el stack sin analizar nada | Docker |
| [Terraform](#4-terraform-infraestructura-como-código) | El stack como código, con su propio PostgreSQL local | Docker + Terraform |

## El archivo `.env`

Todas las formas usan un `.env` en la raíz del repo con los secretos de la instalación: la contraseña de la base, la firma de los JWT, la sal del padrón, la clave con que se cifra el padrón, el token entre servicios y el par de claves con que se firman las actas. **No hay que escribirlo:** si no existe, `start.sh`, `start.bat` y `contenedor.sh` lo generan a partir de `.env.example`, con un valor aleatorio distinto para cada secreto (`scripts/lib/generar-env.js`). A mano:

```bash
node scripts/lib/generar-env.js
```

- Cada instalación tiene su propio `.env` y su propia base: no se comparte con nadie ni se sube al repo (está en `.gitignore`).
- Nunca pisa un valor existente. Si el `.env` ya existe pero le faltan variables nuevas de la plantilla, solo agrega esas.
- **Cuídalo junto con la base.** El padrón se guarda cifrado con `VOTERS_ENCRYPTION_KEY`, y la base se inicializa con `POSTGRES_PASSWORD`: si borras o regeneras el `.env`, los datos existentes quedan ilegibles. En ese caso, empieza de cero borrando también el volumen de la base: `docker compose down -v`.

## La base de datos

PostgreSQL 16 corre en su propio contenedor (`postgres` en `docker-compose.yml`) y guarda los datos en el volumen `db-data`, que sobrevive a `docker compose down` y a los reinicios.

- **Sin puerto en la PC:** está solo en la red interna `db-net`, sin salida a Internet, y la alcanzan únicamente los 5 servicios de backend. El frontend no está en esa red.
- **Esquema:** la primera vez, con el volumen vacío, Postgres carga `db/init.sql`, que ya incluye todas las migraciones de `db/migrations/`. Una base que ya existía (creada con una versión anterior) se pone al día sola: en cada arranque, el servicio `migraciones` de `docker-compose.yml` le aplica esas migraciones antes de que arranquen los servicios, y termina. Son idempotentes: en una base al día no cambian nada. En Swarm lo hace `deploy.sh`.
- **Padrón de demostración:** `init.sql` lo siembra en texto plano (no conoce la clave de cada instalación) y `auth-service` lo cifra solo al arrancar.
- **Consola SQL**, para inspeccionar a mano: `docker compose exec postgres psql -U livemetric -d livemetric`.

## Primer administrador

El repositorio no trae ninguna cuenta ni ninguna credencial. Con una base nueva, `start.sh`, `start.bat` y `contenedor.sh`, al terminar de levantar el stack, piden el usuario y la contraseña del primer administrador (la contraseña, dos veces y sin mostrarla); el evento queda en la auditoría. La contraseña tiene que ser segura: al menos 12 caracteres con tres tipos entre minúsculas, mayúsculas, números y símbolos (o una frase de 16 caracteres o más), sin ser una contraseña común, sin secuencias como `123456` o `qwerty` y sin el nombre de usuario. Si no cumple, el script dice por qué y la vuelve a pedir, hasta tres veces; si igual no se crea, el arranque lo avisa al final. Si ya hay algún administrador, no preguntan nada. Los siguientes se crean desde la pestaña **Usuarios**, con la misma política. Para cambiar la contraseña de una cuenta (por ejemplo, una débil creada antes de esta política): `docker compose exec auth-service node src/scripts/cambiarContrasena.js <usuario>`.

Si lo saltaste, o levantaste el stack con `docker compose` directo:

```bash
docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay               # el primero
docker compose exec auth-service node src/scripts/crearAdmin.js <usuario> auditor         # uno de solo lectura
```

Con el contenedor global, primero entra con `./scripts/contenedor.sh shell` y corre ahí el mismo comando.

## 1. `start.sh` / `start.bat` (recomendada)

```bash
./scripts/start.sh            # Linux / macOS / WSL
scripts\start.bat             # Windows (cmd.exe)
```

1. **Requisitos**: instala lo que falte (Docker, Node.js) con el gestor de paquetes del sistema, o con `winget` en Windows.
2. **`.env`**: lo usa si existe; si no, [lo genera](#el-archivo-env).
3. **Análisis de seguridad**: los mismos controles que el pipeline de GitHub Actions (Gitleaks, Semgrep, npm audit, Trivy, las 6 imágenes reales y las pruebas), cada uno con su resultado ya interpretado y un cuadro final por servicio. Si algo falla (✘), **se detiene ahí** y no levanta nada.
4. **Levantar**: `docker compose up --build` y espera, sin límite de tiempo, a que los 7 contenedores estén sanos (*healthy*), mostrando el estado de cada uno en vivo.
5. **Primer administrador**: si la base es nueva, [lo pide](#primer-administrador).

Al final muestra la URL en esta PC y la URL para el resto de la red local. Con `--detalle` se ve además la salida completa de cada herramienta; sin eso queda en un log por paso, cuya carpeta se indica al empezar.

## 2. Contenedor global (solo Docker)

`scripts/contenedor.sh` (o `scripts\contenedor.bat` en Windows) mete el proyecto entero en **un solo contenedor** con su propio motor de Docker adentro (*Docker-in-Docker*, imagen en `infra/contenedor-global/`). Ahí corre el mismo análisis de seguridad y, solo si pasa, el mismo `docker-compose.yml`: los 7 contenedores del stack quedan **dentro** del global. En la PC no se instala nada más que Docker.

```bash
./scripts/contenedor.sh             # construye, analiza y levanta todo adentro
./scripts/contenedor.sh estado      # estado de cada microservicio
./scripts/contenedor.sh logs        # logs en vivo (o: logs auth-service, logs grafana, logs falco)
./scripts/contenedor.sh shell       # terminal dentro del contenedor global
./scripts/contenedor.sh detener     # apaga el contenedor global y todo lo de adentro
./scripts/contenedor.sh borrar      # además borra su imagen y la caché
```

- **Incluye el monitoreo**, que corre adentro, junto a la aplicación: se conecta a su red, que en este modo solo existe dentro del contenedor global. Queda en esta PC, **solo en `127.0.0.1`** (no desde otra PC):
  - Grafana en `http://localhost:3010`, con el usuario y la contraseña de `GRAFANA_ADMIN_USER` y `GRAFANA_ADMIN_PASSWORD` del `.env`. Los logs de Loki se consultan desde Grafana (*Explore → Loki*).
  - Prometheus en `http://localhost:9090`.
  - Falco, en Linux con eBPF, con sus alertas en el tablero de Grafana. En Windows y macOS no se activa: Docker Desktop corre los contenedores sobre una VM.

  Con Falco, el contenedor global corre además con `--pid=host`. Falco recibe del kernel los números de proceso de la PC y completa cada evento leyendo `/proc`; con el `/proc` propio del contenedor, esos números corresponden a otros procesos, y atribuía a los servicios cosas que hacía la PC. La contra es que el contenedor global ve los procesos de la PC, lo que agrega poco a lo que ya permite `--privileged`.

  Otros puertos: `LIVEMETRIC_PUERTO_GRAFANA=3011 LIVEMETRIC_PUERTO_PROMETHEUS=9091 ./scripts/contenedor.sh`. Sin Falco (y sin `--pid=host`): `LIVEMETRIC_FALCO=0`. Sin monitoreo: `LIVEMETRIC_MONITOREO=0`.
- El frontend queda en `http://localhost:3000`. Si ese puerto está ocupado (por ejemplo, por el stack levantado con `start.sh`), el script lo avisa; se puede usar otro con `LIVEMETRIC_PUERTO=3100 ./scripts/contenedor.sh`.
- El `.env` de la carpeta se monta en solo lectura y nunca queda dentro de la imagen. Si no existe, se genera primero en la carpeta (con el Node.js de la imagen, sin instalar nada en la PC).
- La base de datos vive dentro del contenedor global, en el mismo volumen `livemetric-global-docker`.
- Las imágenes construidas adentro se guardan en el volumen `livemetric-global-docker`: desde la segunda vez arranca mucho más rápido.
- **La contra:** el contenedor global necesita `--privileged` (lo exige un motor de Docker dentro de un contenedor), que le da acceso amplio al kernel de la PC. Es un modo para no instalar nada, no un aislamiento más fuerte que `start.sh`.

## 3. `docker compose` directo

Sin análisis de seguridad, para quien ya sabe lo que hace. Necesita el `.env` (`node scripts/lib/generar-env.js`) y, con una base nueva, [crear el primer administrador](#primer-administrador):

```bash
docker compose up -d --build
docker compose logs -f              # logs en vivo
docker compose down                 # apagar (los datos quedan en el volumen db-data)
docker compose down -v              # apagar y BORRAR la base
```

## 4. Terraform (infraestructura como código)

Levanta el mismo stack con el provider `kreuzwerker/docker`, también con su **propio PostgreSQL** en una red interna, pero con sus propias variables (`terraform.tfvars`) en vez del `.env`.

```bash
cd infra/terraform
cp variables.tfvars.example terraform.tfvars   # valores locales; nunca commitear este archivo
terraform init
terraform plan    -var-file="terraform.tfvars"
terraform apply   -var-file="terraform.tfvars"
terraform destroy -var-file="terraform.tfvars" # para desmontarlo
```

`terraform destroy` borra también el volumen de la base, así que cada `apply` después de un `destroy` empieza con una base nueva. Si en cambio se actualiza el código y se vuelve a hacer `apply` sin destruir, la base conserva su esquema: este modo no tiene el servicio `migraciones` de compose, y las de `db/migrations/` se aplican a mano con `docker exec -i livemetric-postgres psql -U <usuario> -d livemetric < db/migrations/<archivo>.sql`.

## Acceso desde otras PC de la red

El frontend se publica en el puerto 3000 de todas las interfaces. `start.sh` y `contenedor.sh` muestran al final la URL para la red (`http://<ip-de-la-pc>:3000`).

- **Windows:** el firewall bloquea por defecto las conexiones entrantes. La primera vez, acepta el aviso de Docker Desktop o crea una regla de entrada para el puerto **3000/TCP** (Firewall de Windows Defender → Configuración avanzada → Reglas de entrada → Nueva regla → Puerto → TCP → 3000). La IP de la PC se ve con `ipconfig` ("Dirección IPv4").
- **Para que sobreviva un reinicio:** todos los servicios tienen `restart: unless-stopped`. En Windows, activa en Docker Desktop "Start Docker Desktop when you log in"; el stack vuelve solo en cuanto arranca el motor.

## Windows como servidor central

El requisito común es [Docker Desktop](https://www.docker.com/products/docker-desktop/): los contenedores son Linux y corren igual en cualquier sistema.

- **Opción A — CMD, sin WSL2:** `scripts\start.bat` y `scripts\pipeline-local.bat` son el equivalente nativo de los `.sh`. Hace falta Docker Desktop y Node.js en el `PATH` (npm audit, las pruebas y la generación del `.env` corren en Windows); `start.bat` intenta instalar lo que falte con `winget`.
- **Opción B — WSL2:** con `wsl --install` y la integración de Docker Desktop con la distribución (Settings → Resources → WSL Integration), los `.sh` corren sin cambios. Clona el repo dentro del sistema de archivos de Linux (`~`), no en `/mnt/c/...`, que es mucho más lento.

## Datos de demostración

`db/init.sql` deja datos para probar el ciclo completo, pero **ninguna credencial**:

| Elemento | Valor |
|---|---|
| Padrón de demostración | cédulas `1000000001` a `1000000005`, en "Puesto Central" (Mesa 1 y 2) y "Puesto Norte" (Mesa 1), cifradas por `auth-service` al arrancar. Entran **sin PIN**: para votar con ellas, genéralo en **Padrón** ("Regenerar PIN"); se muestra una sola vez. |
| Plantillas | "Elección de ejemplo" (3 opciones) y "Elección Presidencial de Ejemplo" (3 candidatos numerados) |
| Administrador | ninguno: el primero lo pide el script de arranque (ver [Primer administrador](#primer-administrador)) |

## Recorrido por la interfaz

1. Entra a **http://localhost:3000** → "Administrador" → con tu cuenta.
2. En **Padrón**, genera el PIN de las cédulas de demostración que vayas a usar ("Regenerar PIN"; anótalo, se muestra una sola vez). El PIN vence en la fecha del campo **Vencimiento de los PIN que se generen** (sin elecciones programadas, en 24 horas) y solo sirve durante la votación, desde una hora antes de que abra. Marca **Voto asistido** en una de ellas (por ejemplo, `1000000002`, de la Mesa 1). En **Usuarios**, crea un **jurado de mesa** eligiendo del padrón `Puesto Central` y `Mesa 1` (o *Todas las mesas del puesto*); también puedes crear más administradores o auditores.
3. En **Plantillas**, usa "Elección Presidencial de Ejemplo" o crea una nueva con candidatos (número, nombre y foto).
4. En **Elecciones**, instancia una con una ventana corta (2–3 minutos) para ver el ciclo completo.
5. En una ventana de incógnito → "Votante" → cédula `1000000001` con el PIN que generaste. La primera vez aparece un QR: escanéalo con **Microsoft Authenticator** o **Google Authenticator** en tu celular y escribe el código de 6 dígitos → vota. Repite con `1000000003` (otra mesa) para tener votos en más de una mesa.
6. **Voto asistido:** entra como el jurado (pestaña "Administrador / Auditor / Jurado"; la primera vez registra su autenticador) y verás su mesa y a la votante asistida. En otra ventana de incógnito, entra con `1000000002` y su PIN: la pantalla pide la autorización del jurado; escribe su usuario y el código de su app → vota.
7. En **Elecciones** puedes pulsar "Detener" para cerrarla antes de tiempo.
8. En **Resultados**: mientras está activa, solo cuántas personas votaron, en vivo (los votos por opción no se publican antes del acta); tras cerrarla, el indicador de veracidad del acta ("✓ Acta verificada": firma digital válida, sin modificaciones y con los votos guardados coincidiendo), el ganador y el desglose por mesa. El PDF del acta lleva el mismo veredicto en el encabezado.
9. En **Escrutinio**, "Verificar actas" muestra acta por acta si su contenido, la cadena y la firma digital están en orden.
10. En **Reportes**, arma un tablero con widgets: resultados, participación, proyección, momento de definición, integridad del acta, accesos sospechosos, etc. Se exporta a PDF.
11. En **Auditoría**, revisa todos los intentos de ingreso, exitosos y fallidos, los registros de autenticadores y cada voto asistido con el jurado que lo autorizó.

## Flujo por línea de comandos

Las APIs responden en `127.0.0.1` (o a través del frontend: `http://localhost:3000/auth/...`, `/voting/...`, etc.):

```bash
# Salud de cada servicio
curl http://127.0.0.1:3001/health   # auth
curl http://127.0.0.1:3002/health   # voting
curl http://127.0.0.1:3003/health   # analytics
curl http://127.0.0.1:3004/health   # scrutiny
docker compose logs -f scheduler-worker   # el worker no expone puerto

# Login de admin (reemplaza <usuario> y <password> por las credenciales de un administrador)
curl -X POST http://127.0.0.1:3001/login/admin \
  -H "Content-Type: application/json" -d '{"username":"<usuario>","password":"<password>"}'

# Login de votante, en dos pasos. 1) Cédula + PIN: devuelve "next" y un desafío de 5 minutos
#    (y, la primera vez, "secret" y "otpauthUri" para registrar la app autenticadora)
curl -X POST http://127.0.0.1:3001/login/voter \
  -H "Content-Type: application/json" -d '{"cedula":"1000000001","pin":"<pin>"}'
# 2) El código de 6 dígitos de la app: /login/voter/registro la primera vez, /login/voter/codigo después
#    (en un votante asistido: /login/voter/asistido con {"challenge","juradoUsername","juradoCode"})
curl -X POST http://127.0.0.1:3001/login/voter/codigo \
  -H "Content-Type: application/json" -d '{"challenge":"<desafio>","code":"<codigo>"}'

# Crear una elección desde la plantilla de ejemplo (id=1)
curl -X POST http://127.0.0.1:3002/admin/elections \
  -H "Authorization: Bearer <TOKEN_ADMIN>" -H "Content-Type: application/json" \
  -d '{"templateId":1,"title":"Elección 2026","scheduledStart":"2026-09-05T15:00:00Z","scheduledEnd":"2026-09-05T15:02:00Z"}'

# Votar (con el token de VOTANTE); repetirlo debe devolver 409, y fuera de la ventana, 403
curl -X POST http://127.0.0.1:3002/vote \
  -H "Authorization: Bearer <TOKEN_VOTANTE>" -H "Content-Type: application/json" \
  -d '{"electionId":1,"optionId":1}'

# Resultados certificados tras el cierre (certified: true, con recordHash)
curl http://127.0.0.1:3003/api/elections/1/results -H "Authorization: Bearer <TOKEN_ADMIN>"

# Integridad de toda la cadena de actas
curl http://127.0.0.1:3004/verify -H "Authorization: Bearer <TOKEN_ADMIN>"
```

## Solución de problemas

Lo primero, casi siempre: `docker compose ps` (qué contenedor no está sano) y `docker compose logs <servicio>` (por qué). `start.sh` y `start.bat` ya muestran el motivo de cada contenedor que no queda sano.

| Síntoma | Causa | Solución |
|---|---|---|
| `port is already allocated` o "El puerto 3000 ya está en uso" | Otra forma de despliegue ya está arriba: el contenedor global y `start.sh` usan los dos el 3000 | `docker ps --filter publish=3000` muestra cuál. Bájala (`docker compose down` o `./scripts/contenedor.sh detener`), o usa otro puerto con `LIVEMETRIC_PUERTO=3100 ./scripts/contenedor.sh` |
| Un servicio se reinicia en bucle y su log dice `FATAL: VOTERS_ENCRYPTION_KEY debe ser una clave AES-256 (32 bytes) en base64.` o `FATAL: ACTA_SIGNING_KEY debe ser una clave Ed25519 de 32 bytes en base64.` | Falta la variable en el `.env`, o tiene todavía el marcador de la plantilla | `node scripts/lib/generar-env.js` agrega lo que falte y genera lo que tenga el marcador, sin tocar los valores reales. Después, `docker compose up -d` |
| `FATAL: ACTA_PUBLIC_KEY no corresponde a ACTA_SIGNING_KEY` | Las dos claves de la firma de las actas no son pareja (se editó una a mano) | Borra las dos líneas del `.env` y corre `generar-env.js`, que genera un par nuevo. Las actas firmadas con el par anterior pasan a verse como firmadas "con otra clave" |
| Los servicios no arrancan y su log dice `password authentication failed for user "livemetric"` | El `.env` se regeneró o cambió después de crear la base: Postgres guardó la contraseña de la primera vez | Si tienes el `.env` anterior, restáuralo. Si no, empieza de cero con `docker compose down -v` (**borra la base**) |
| `docker compose up` falla con `network livemetric_db-net not manually attachable` | El stack de Docker Swarm está desplegado en la misma PC: usa los mismos nombres de red | Retíralo antes (`docker stack rm livemetric`), o baja el compose antes de desplegar el stack. No pueden correr a la vez |
| `docker swarm init` falla con `could not choose an IP address to advertise` | La PC tiene varias direcciones en la misma interfaz (por ejemplo, varias IPv6 en el Wi-Fi) y Swarm no sabe cuál anunciar | `docker swarm init --advertise-addr <IP local>` (la que muestra `start.sh` como "Desde otra PC de la red") |
| Grafana rechaza la contraseña del `.env` | Sus datos quedaron de una instalación anterior: Grafana solo toma la contraseña del `.env` al crear su volumen | `docker exec -it livemetric-grafana grafana cli admin reset-admin-password '<la del .env>'`, o borrar sus datos con `docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml down -v` |
| El análisis marca una CVE alta en un paquete del sistema de una imagen (por ejemplo, `pcre2` o `libssl3` en el frontend) | La imagen base todavía trae la versión vieja. El Dockerfile la actualiza con `apk upgrade`, pero esa capa podía salir de la caché de Docker de un build anterior | Vuelve a correr el arranque: la capa se rehace con la fecha del día. Si sigue marcándola, Alpine todavía no publicó la corrección (ver [Gestión de vulnerabilidades](manual-seguridad.md#5-gestión-de-vulnerabilidades)) |
| `npm audit` o Trivy "no pudo completar el análisis" (`EAI_AGAIN`, `ENOTFOUND`, `network is unreachable`, `failed to download vulnerability DB`) | La red no respondió: el registro de npm o la base de vulnerabilidades de Trivy no se pudieron descargar. El pipeline local ya lo reintenta 3 veces, durante unos 30 segundos | Revisa la conexión a internet (y el DNS) y vuelve a correr el arranque. No es un hallazgo de seguridad |
| Semgrep falla con `Name does not resolve` | El DNS de la red (típicamente, compartir Internet desde Windows) no le resuelve `semgrep.dev` a los contenedores Alpine | `pipeline-local.sh` lo detecta y usa DNS públicos solo para Semgrep. Si falla igual, no hay salida a Internet: Semgrep descarga sus reglas en cada corrida |
| `npm test` falla con "Las pruebas necesitan Docker para levantar su base desechable" | Docker no está corriendo | Arranca Docker (o Docker Desktop). Las pruebas no usan la base del stack: levantan la suya |
| El votante escribe el código de la app y recibe "Código incorrecto o vencido" | Escribió un código anterior (cada uno sirve una sola vez y cambia cada 30 s), o la hora de su celular no está bien | Que escriba el código que la app muestra en ese momento. Si sigue fallando, que ponga la hora del celular en automático: los códigos dependen de ella |
| "Esta cédula ya tiene un autenticador registrado" en el primer ingreso | Alguien registró una app con esa cédula y su PIN antes que el votante (o el mismo votante, en otro celular) | Si no fue él, regenera su PIN y, en **Padrón**, **Restablecer autenticador**; queda en la auditoría (`VOTER_TOTP_ENROLLED`) desde qué IP y cuándo se registró |
| El votante cambió o perdió el celular | El código está en la app del celular anterior | En **Padrón**, **Restablecer autenticador**: en su próximo ingreso lo registra de nuevo. Para un jurado, lo mismo en **Usuarios** |
| En el voto asistido: "Ese jurado no es de la mesa ni del puesto de este votante" | El jurado está asignado a otra mesa u otro puesto que el votante. Las mayúsculas, las tildes y escribir "1" en vez de "Mesa 1" no cuentan: es otra mesa de verdad, o un puesto mal escrito al crear el jurado | En **Usuarios**, **Cambiar mesa** del jurado, eligiendo el puesto y la mesa del padrón (o *Todas las mesas del puesto*) |
| La votante asistida no aparece en el panel del jurado | No está marcada como asistida, o es de otra mesa u otro puesto que el jurado | Marca **Voto asistido** en **Padrón**, y revisa en **Usuarios** el puesto y la mesa del jurado (**Cambiar mesa**) |
| El votante recibe "No hay una votación abierta en este momento" | El PIN solo sirve con una elección abierta o que abre dentro de una hora; una detenida a mano ya no cuenta | Que vuelva dentro de ese horario. Para registrar autenticadores antes de la jornada, programa la elección primero: el ingreso se habilita una hora antes de la apertura |
| El votante recibe "Tu PIN venció" | El PIN pasó su fecha de vencimiento (se elige al generarlo) | En **Padrón**, **Regenerar PIN**, con un vencimiento que cubra la elección (el campo propone el cierre de la última programada) |
| Un votante recibe "Cédula o PIN incorrectos" con los datos correctos | Su cédula no tiene PIN (en **Padrón** figura "Sin asignar"), o el PIN se regeneró | Genera el PIN desde **Padrón** y entrégaselo. El mensaje es el mismo en todos los casos a propósito |
| "Demasiados intentos. Intenta de nuevo más tarde." al ingresar como votante | Desde ese equipo (esa IP) hubo 8 intentos fallidos en 15 minutos: el sistema lo toma como alguien adivinando PINs y bloquea la IP, también para los PIN correctos. Los ingresos correctos no cuentan, así que un puesto con un solo equipo puede atender a todos sus votantes | Esperar a que pasen los 15 minutos. Si fue un error de digitación repetido, revisar con el votante su cédula y su PIN (o regenerarlo en **Padrón**); si no, revisar el reporte de **Accesos sospechosos** |
| No hay ningún administrador, o se perdió la contraseña del único | La base es nueva, el script no lo pudo crear (el arranque lo avisa al final) o no hay recuperación de contraseña | `docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay` si no hay ninguno; `cambiarContrasena.js <usuario>` para darle una contraseña nueva a uno que existe. Desde ese, se administra el resto en **Usuarios** |
| "La contraseña no es segura" al crear el administrador o un usuario | La contraseña es corta, tiene pocos tipos de caracteres, es común (o una palabra común con números), tiene una secuencia o contiene el usuario | Usa una más larga y variada, o una frase de 16 caracteres o más (por ejemplo, cuatro palabras con guiones). El mensaje dice qué falló |
| En **Resultados**, un acta aparece como "Sin firma digital" o "Alterada" | "Sin firma": se certificó antes de que existiera la firma digital. "Alterada": algo en ella no coincide (el indicador dice qué) | Ver el [Manual de usuario](manual-usuario.md#46-resultados) y el [Manual de seguridad](manual-seguridad.md). Un acta alterada no debe usarse como oficial |
| El stack de monitoreo no arranca: `Define GRAFANA_ADMIN_PASSWORD en el .env` | Compose busca el `.env` en `monitoring/` si no se le indica otro | `docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml up -d`, desde la raíz del repo. En un `.env` anterior, `generar-env.js` agrega la contraseña |
| `docker compose watch` responde `unknown command` | Compose anterior a la versión 2.22 | Actualiza Docker (o Docker Desktop), o reconstruye a mano: `docker compose up -d --build <servicio>` |
| En Windows: `error during connect` o `pipe/docker_engine` | Docker Desktop no está corriendo | Ábrelo y espera a que diga que el motor está listo |
| En Windows con WSL2, todo es muy lento | El repo está en `/mnt/c/...` | Clónalo dentro del sistema de archivos de Linux (`~`) |
| Desde otra PC de la red no se abre la aplicación | El firewall de Windows bloquea el puerto 3000 | Ver [Acceso desde otras PC de la red](#acceso-desde-otras-pc-de-la-red) |

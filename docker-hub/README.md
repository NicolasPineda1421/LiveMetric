# Referencia rápida

- **Mantenido por:**
  [NicolasPineda1421](https://github.com/NicolasPineda1421), en el proyecto [LiveMetric](https://github.com/NicolasPineda1421/LiveMetric)

- **Dónde pedir ayuda:**
  los [issues del repositorio](https://github.com/NicolasPineda1421/LiveMetric/issues) y la [documentación](https://github.com/NicolasPineda1421/LiveMetric/tree/main/docs)

# Etiquetas disponibles y sus `Dockerfile`

<!-- etiquetas:inicio -->
- [`1.6.0`, `v1.6.0`, `1.6`, `latest`](https://github.com/NicolasPineda1421/LiveMetric/blob/v1.6.0/docker-hub/Dockerfile)
<!-- etiquetas:fin -->

Las versiones anteriores siguen publicadas (pestaña **Tags**). `latest` es siempre la más nueva.

# Referencia rápida (continuación)

- **Dónde reportar problemas:**
  [GitHub Issues](https://github.com/NicolasPineda1421/LiveMetric/issues/new)

- **Arquitecturas:**
  `amd64`. En un Mac con Apple Silicon, Docker Desktop la corre emulada (más lenta).

- **Detalles de cada imagen publicada:**
  su SBOM va adjunto a la imagen (`docker buildx imagetools inspect nicolaspineda1421/livemetric --format '{{ json .SBOM }}'`). El de CycloneDX, de la imagen y de sus dependencias, queda en cada [corrida de publicación](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/release.yml).

- **Actualizaciones de la imagen:**
  se publica una con cada [versión](https://github.com/NicolasPineda1421/LiveMetric/releases), desde el workflow [`release.yml`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/.github/workflows/release.yml)

- **Fuente de esta descripción:**
  [`docker-hub/README.md`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/docker-hub/README.md) ([historial](https://github.com/NicolasPineda1421/LiveMetric/commits/main/docker-hub/README.md))

# ¿Qué es LiveMetric?

LiveMetric es un sistema de elecciones y votación en tiempo real. Una organización programa elecciones con su horario, y cada votante habilitado vota **una sola vez**, con su cédula, un PIN y el código de su app autenticadora (Microsoft o Google Authenticator). Al cierre, un servicio aparte recuenta los votos y emite un **acta certificada**: encadenada con hashes SHA-256 y firmada digitalmente (Ed25519). Nadie puede alterarla sin que se note.

- **Sin resultados parciales:** mientras la elección está abierta, solo se ve cuántas personas votaron; los votos por candidato se publican cuando se certifica el acta.
- **Indicador de veracidad:** cada vez que se consulta un resultado, se comprueban la firma, el hash y los votos guardados, y se muestra si el acta está verificada o alterada, también en el PDF.
- **Padrón cifrado** de miles de votantes, cargado desde un CSV o desde Excel, con puestos de votación ubicados por departamento y municipio (lista oficial del DANE).
- **Voto asistido** para quien no puede usar una app: lo autoriza el jurado de su mesa.
- **Reportes y auditoría:** tableros con estadística, y un registro de cada ingreso que no se puede modificar. Roles de administrador, auditor, jurado y votante.

Es un proyecto universitario de DevSecOps: seguridad en todo el ciclo de vida, desde el modelado de amenazas hasta la publicación de estas imágenes. Código y documentación: [github.com/NicolasPineda1421/LiveMetric](https://github.com/NicolasPineda1421/LiveMetric).

![LiveMetric: resultados de una elección con el acta verificada](https://raw.githubusercontent.com/NicolasPineda1421/LiveMetric/main/docs/img/16-resultados-certificados.png)

# ¿Qué trae esta imagen?

Esta imagen es la **puerta de entrada**: prepara la carpeta donde corre el sistema y termina. Al correrla, deja dos archivos en la carpeta montada en `/salida`:

- `docker-compose.yml`: el del sistema, de la misma versión que la imagen;
- `.env`: los secretos de esta instalación, generados al azar (la contraseña de la base, la clave con que se cifra el padrón, las de la firma de las actas y las de las sesiones). Si ya existe, solo le agrega los que falten.

Está hecha sobre `node:20-alpine`, sin `npm`, y corre como root solo para poder escribir en tu carpeta, que en Linux es de otro usuario; los archivos quedan a tu nombre. No pisa un `docker-compose.yml` ni un `.env` que no sean de LiveMetric, y si falta el `-v` se detiene, porque los archivos se perderían con el contenedor.

El sistema son las imágenes que baja ese compose:

| Imagen | Qué es | `Dockerfile` |
|---|---|---|
| [`livemetric-frontend`](https://hub.docker.com/r/nicolaspineda1421/livemetric-frontend) | La aplicación web (React, servida por nginx), que además reenvía al API | [`services/frontend`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/services/frontend/Dockerfile) |
| [`livemetric-auth`](https://hub.docker.com/r/nicolaspineda1421/livemetric-auth) | Ingreso de votantes y personal, padrón, usuarios y auditoría | [`services/auth`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/services/auth/Dockerfile) |
| [`livemetric-voting`](https://hub.docker.com/r/nicolaspineda1421/livemetric-voting) | Votación y administración de elecciones | [`services/voting`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/services/voting/Dockerfile) |
| [`livemetric-analytics`](https://hub.docker.com/r/nicolaspineda1421/livemetric-analytics) | Resultados, reportes y estadística | [`services/analytics`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/services/analytics/Dockerfile) |
| [`livemetric-scrutiny`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scrutiny) | Escrutinio: certifica y firma cada acta | [`services/scrutiny`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/services/scrutiny/Dockerfile) |
| [`livemetric-scheduler`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scheduler) | Abre y cierra las elecciones según su horario | [`services/scheduler`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/services/scheduler/Dockerfile) |
| [`livemetric-db`](https://hub.docker.com/r/nicolaspineda1421/livemetric-db) | PostgreSQL 16 con el esquema y las migraciones | [`db`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/db/Dockerfile) |

# Cómo usar esta imagen

Solo hace falta **Docker**: Docker Desktop en Windows y macOS; en Linux, Docker Engine con `docker compose`. No hay que clonar nada ni instalar Node.js.

## Iniciar LiveMetric

En una carpeta vacía:

```bash
mkdir livemetric && cd livemetric
docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric
docker compose up -d --pull always
```

La primera vez, crea el administrador (pide el usuario y la contraseña, sin mostrarla):

```bash
docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay
```

La aplicación queda en **http://localhost:3000**, y desde otra PC de la red, en `http://<ip-de-esta-pc>:3000`. Las demás cuentas se crean desde la pestaña **Usuarios**.

En Windows funciona igual en **PowerShell**; en `cmd`, cambia `${PWD}` por `%cd%`.

## Actualizar

Los mismos dos comandos, en la misma carpeta:

```bash
docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric
docker compose up -d --pull always
```

El primero trae el `docker-compose.yml` de la versión nueva y agrega al `.env` los secretos nuevos, si los hay, sin cambiar los que ya están. Al arrancar, las migraciones ponen al día la base sin perder datos.

## Variables de entorno

En el `.env`, quitando el `#` de la línea:

| Variable | Para qué | Por defecto |
|---|---|---|
| `LIVEMETRIC_VERSION` | Fijar una versión (por ejemplo `1.6.0`) en vez de la última | `latest` |
| `LIVEMETRIC_PUERTO` | El puerto de la aplicación en esta PC | `3000` |
| `PIN_VIGENCIA_HORAS` | Cuántas horas dura cada PIN de votante desde que se genera (de 1 a 2160) | `24` |

## Dónde se guardan los datos

La base vive en el volumen `livemetric-dockerhub_db-data`, y el `.env` tiene la clave con que se cifra el padrón: **guarda los dos**, porque sin el `.env` el padrón no se puede leer. Para hacer un respaldo:

```bash
docker compose exec -T postgres pg_dump -U livemetric livemetric > respaldo.sql
```

## Ver el estado

En la carpeta de LiveMetric:

```bash
docker compose ps                     # estado de cada servicio
docker compose logs -f auth-service   # registro de un servicio (Ctrl+C para salir)
```

## Detener

En la carpeta de LiveMetric:

```bash
docker compose down
```

Apaga y quita los contenedores. **Los datos quedan**: la base sigue en su volumen, y el `.env` y el `docker-compose.yml` siguen en la carpeta. Para volver a arrancarlo, en la misma carpeta:

```bash
docker compose up -d
```

Mientras no lo detengas, LiveMetric vuelve a arrancar solo cada vez que arranca Docker, por ejemplo al encender la PC.

## Borrar

> ⚠️ **No se puede deshacer:** se pierden las elecciones, el padrón, las actas y la auditoría. Si los quieres conservar, haz antes un respaldo (ver **Dónde se guardan los datos**).

En la carpeta de LiveMetric:

```bash
docker compose down -v --rmi all                   # contenedores, base de datos e imágenes del sistema
docker rmi nicolaspineda1421/livemetric            # la imagen de instalación
```

Al final, borra la carpeta, con el `docker-compose.yml` y el `.env`:

```bash
cd .. && rm -rf livemetric                         # Linux y macOS
```

```powershell
cd ..; Remove-Item -Recurse -Force livemetric      # Windows (PowerShell)
```

Si solo quieres empezar de cero, con la base vacía pero la misma instalación, alcanza con `docker compose down -v` y después `docker compose up -d`.

## Si algo falla

- **`service "revisar-configuracion" didn't complete successfully`**: falta el `.env`, o le falta algún secreto. Vuelve a correr el `docker run` de arriba en esta carpeta y después `docker compose up -d`. `docker compose logs revisar-configuracion` dice cuál falta.
- **`Falta montar tu carpeta`**: al `docker run` le faltó `-v "${PWD}:/salida"`.
- **El puerto 3000 está ocupado**: usa otro con `LIVEMETRIC_PUERTO` en el `.env`.
- **Un servicio se reinicia una y otra vez**: `docker compose logs <servicio>` muestra por qué.

# ¿Cómo se construyen las imágenes?

Las 8 imágenes, esta y las 7 del sistema, salen del mismo workflow, [`release.yml`](https://github.com/NicolasPineda1421/LiveMetric/blob/main/.github/workflows/release.yml), que corre cuando se publica una versión. Antes de subir cualquiera:

1. **Trivy las escanea:** si una tiene CVE críticas o altas con corrección disponible, no se publica ninguna.
2. **Se prueba el sistema:** en una carpeta vacía, esta imagen prepara la carpeta, el sistema se levanta con las imágenes recién construidas y los cuatro servicios tienen que responder. Si no arranca, no se publica ninguna.

Después de subirlas, el workflow comprueba en Docker Hub que `latest` y la versión son la misma imagen en las 8. Cada imagen lleva su SBOM adjunto, y en cada push el pipeline DevSecOps escanea el código, las dependencias y las imágenes.

En ejecución, la base va en una red interna, sin salida a Internet ni puertos en la PC. Ningún contenedor del sistema corre como root, el sistema de archivos es de solo lectura y cada servicio recibe solo sus secretos. Solo se publica el puerto de la aplicación.

# Licencia

El software de LiveMetric se distribuye bajo la [licencia MIT](https://github.com/NicolasPineda1421/LiveMetric/blob/main/LICENSE).

Como toda imagen de Docker, estas también contienen otro software, con sus propias licencias: Alpine Linux, Node.js, nginx, PostgreSQL y sus dependencias, directas o indirectas. El SBOM adjunto a cada imagen lista sus componentes.

Como con cualquier imagen ya construida, quien la usa es responsable de cumplir las licencias de todo el software que contiene.

# LiveMetric desde Docker Hub

El sistema completo **sin clonar el repositorio**: solo hace falta Docker (Docker Desktop en Windows y macOS; en Linux, Docker Engine con el plugin `docker compose`). Se descarga un archivo, [`docker-compose.yml`](docker-compose.yml), que baja de [Docker Hub](https://hub.docker.com/u/nicolaspineda1421) las 7 imágenes publicadas: las 6 del sistema y la base de datos con su esquema. Todas pasaron el escaneo de Trivy antes de publicarse, y llevan su SBOM adjunto.

## Instalar

Linux y macOS:

```bash
mkdir livemetric && cd livemetric
curl -fsSLO https://raw.githubusercontent.com/NicolasPineda1421/LiveMetric/main/docker-hub/docker-compose.yml
docker compose run --rm configurar
docker compose up -d
```

Windows (PowerShell):

```powershell
mkdir livemetric; cd livemetric
curl.exe -fsSLO https://raw.githubusercontent.com/NicolasPineda1421/LiveMetric/main/docker-hub/docker-compose.yml
docker compose run --rm configurar
docker compose up -d
```

La primera vez tarda lo que demore en bajar las imágenes. Después, crea el primer administrador (pide el usuario y la contraseña, sin mostrarla):

```bash
docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay
```

La aplicación queda en **http://localhost:3000**, y desde otra PC de la red, en `http://<ip-de-esta-pc>:3000`. Las demás cuentas se crean desde la pestaña **Usuarios**.

## Qué hace cada paso

- **`docker compose run --rm configurar`** crea el archivo `.env` en la carpeta con los secretos de esta instalación, generados al azar: la contraseña de la base, la clave con que se cifra el padrón, las de la firma de las actas y las de las sesiones. **Guárdalo:** sin él, el padrón no se puede leer. Si el `.env` ya existe, no cambia nada; solo agrega un secreto que falte (por ejemplo, uno nuevo de una versión posterior).
- **`docker compose up -d`** comprueba primero que el `.env` tenga todos los secretos. Si falta alguno, no arranca nada. Después levanta la base, que la primera vez se crea con el esquema completo, aplica las migraciones y arranca los servicios.

## Actualizar a la versión más nueva

```bash
curl -fsSLO https://raw.githubusercontent.com/NicolasPineda1421/LiveMetric/main/docker-hub/docker-compose.yml
docker compose run --rm configurar
docker compose pull
docker compose up -d
```

El primer comando trae el compose de la versión nueva, por si cambió. El segundo agrega los secretos nuevos, si los hay. Al arrancar, las migraciones ponen al día la base sin perder datos.

## Opciones

En el `.env`, quitando el `#` de la línea:

| Variable | Para qué | Por defecto |
|---|---|---|
| `LIVEMETRIC_VERSION` | Fijar una versión (por ejemplo `1.5.0`) en vez de la última | `latest` |
| `LIVEMETRIC_PUERTO` | El puerto de la aplicación en esta PC | `3000` |
| `PIN_VIGENCIA_HORAS` | Cuántas horas dura cada PIN de votante desde que se genera (de 1 a 2160) | `24` |

## Operación

```bash
docker compose ps                     # estado de cada servicio
docker compose logs -f auth-service   # registro de un servicio
docker compose down                   # detener (los datos quedan)
docker compose down -v                # borrar todo, base incluida: no se puede deshacer
```

Respaldo de la base (guárdalo junto con el `.env`, que tiene la clave del padrón):

```bash
docker compose exec -T postgres pg_dump -U livemetric livemetric > respaldo.sql
```

## Si algo falla

- **`service "revisar-configuracion" didn't complete successfully`**: falta el `.env`, o le falta algún secreto. `docker compose logs revisar-configuracion` dice cuál; se arregla con `docker compose run --rm configurar` y otra vez `docker compose up -d`.
- **El puerto 3000 está ocupado**, por ejemplo por una instalación desde el repositorio: detén la otra o usa otro puerto con `LIVEMETRIC_PUERTO` en el `.env`.
- **Un servicio se reinicia una y otra vez**: `docker compose logs <servicio>` muestra por qué.

## Diferencias con la instalación desde el repositorio

Es el mismo sistema, con la misma seguridad: redes separadas, la base sin salida a Internet ni puertos en el host, sin root, sistema de archivos de solo lectura, y cada servicio recibe solo sus secretos. Cambia esto:

- No construye nada, así que no corre el análisis de seguridad local: eso ya lo hizo el pipeline antes de publicar.
- No trae el monitoreo (Prometheus, Grafana y Falco).
- Solo publica el puerto de la aplicación: el API no queda en `127.0.0.1:3001` a `3004`, y se llega a él a través de la aplicación.
- Su base es otra (proyecto `livemetric-dockerhub`), aunque en la misma PC haya una instalación desde el repositorio.

Los demás modos (`start.sh`, `contenedor.sh`, Docker Swarm y Terraform) están en [instalación y despliegue](../docs/instalacion-y-despliegue.md).

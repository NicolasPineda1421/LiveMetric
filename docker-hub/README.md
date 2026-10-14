# LiveMetric

**Sistema de elecciones y votación en tiempo real.** Sirve para programar elecciones con su horario. Cada votante habilitado vota **una sola vez**, con su cédula, un PIN y el código de su app autenticadora. Al cierre queda un **acta certificada y firmada** que nadie puede alterar sin que se note.

Solo hace falta **Docker**: Docker Desktop en Windows y macOS; en Linux, Docker Engine con `docker compose`. No hay que clonar nada ni instalar Node.js.

## Cómo correrlo

En una carpeta vacía:

```bash
mkdir livemetric && cd livemetric
docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric
docker compose up -d --pull always
```

Después, la primera vez, crea el administrador (pide el usuario y la contraseña, sin mostrarla):

```bash
docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay
```

Listo: **http://localhost:3000**, y desde otra PC de la red, `http://<ip-de-esta-pc>:3000`. Las demás cuentas se crean desde la pestaña **Usuarios**.

> En Windows funciona igual en **PowerShell**. En `cmd`, cambia `${PWD}` por `%cd%`.

## Qué hace cada comando

- **`docker run … nicolaspineda1421/livemetric`** deja dos archivos en la carpeta:
  - `docker-compose.yml`, el del sistema;
  - `.env`, con los secretos de esta instalación, generados al azar: la contraseña de la base, la clave con que se cifra el padrón, las de la firma de las actas y las de las sesiones.

  **Guarda el `.env`: sin él, el padrón no se puede leer.** Si en la carpeta ya hay un `docker-compose.yml` o un `.env` que no son de LiveMetric, se detiene sin tocarlos.
- **`docker compose up -d`** baja las imágenes y levanta el sistema. Antes que nada comprueba que el `.env` tenga todos los secretos; si falta alguno, no arranca nada. La primera vez, la base se crea con su esquema completo.

## Actualizar

Los mismos dos comandos, en la misma carpeta:

```bash
docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric
docker compose up -d --pull always
```

El primero trae el `docker-compose.yml` de la versión nueva. Al `.env` solo le agrega un secreto nuevo, si lo hay, sin cambiar los que ya están. Al arrancar, las migraciones ponen al día la base sin perder datos.

## Opciones

En el `.env`, quitando el `#` de la línea:

| Variable | Para qué | Por defecto |
|---|---|---|
| `LIVEMETRIC_VERSION` | Fijar una versión (por ejemplo `1.6.0`) en vez de la última | `latest` |
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

- **`service "revisar-configuracion" didn't complete successfully`**: falta el `.env`, o le falta algún secreto. Vuelve a correr el `docker run` de arriba en esta carpeta (o `docker compose run --rm configurar`, que hace lo mismo con el `.env`) y después `docker compose up -d`. `docker compose logs revisar-configuracion` dice cuál falta.
- **`Falta montar tu carpeta`**: al `docker run` le faltó `-v "${PWD}:/salida"`.
- **El puerto 3000 está ocupado**: usa otro con `LIVEMETRIC_PUERTO` en el `.env`.
- **Un servicio se reinicia una y otra vez**: `docker compose logs <servicio>` muestra por qué.

## Las imágenes

Esta imagen solo prepara la carpeta. El sistema son las imágenes que baja el compose, publicadas con cada versión:

| Imagen | Qué es |
|---|---|
| [`livemetric-frontend`](https://hub.docker.com/r/nicolaspineda1421/livemetric-frontend) | La aplicación web (React, servida por nginx), que además reenvía al API |
| [`livemetric-auth`](https://hub.docker.com/r/nicolaspineda1421/livemetric-auth) | Ingreso de votantes y personal, padrón, usuarios y auditoría |
| [`livemetric-voting`](https://hub.docker.com/r/nicolaspineda1421/livemetric-voting) | Votación y administración de elecciones |
| [`livemetric-analytics`](https://hub.docker.com/r/nicolaspineda1421/livemetric-analytics) | Resultados, reportes y estadística |
| [`livemetric-scrutiny`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scrutiny) | Escrutinio: certifica y firma cada acta |
| [`livemetric-scheduler`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scheduler) | Abre y cierra las elecciones según su horario |
| [`livemetric-db`](https://hub.docker.com/r/nicolaspineda1421/livemetric-db) | PostgreSQL 16 con el esquema y las migraciones |

Todas se publican solo si pasan el escaneo de **Trivy** (sin CVE críticas ni altas) y si el sistema arranca con ellas. Cada una lleva su **SBOM** adjunto: `docker buildx imagetools inspect nicolaspineda1421/livemetric-auth --format '{{ json .SBOM }}'`. `latest` es siempre la versión más nueva; cada versión también queda como `X.Y.Z`, `vX.Y.Z` y `X.Y`.

**Seguridad:**
- la base va en una red interna, sin salida a Internet ni puertos en la PC;
- ningún contenedor del sistema corre como root; solo lo hace la preparación de la carpeta (esta imagen, o `docker compose run --rm configurar`), que escribe el compose y el `.env`, sin nada más, y termina;
- el sistema de archivos de los contenedores es de solo lectura;
- cada servicio recibe solo sus secretos;
- solo se publica el puerto de la aplicación.

Código, documentación y otras formas de instalarlo: [github.com/NicolasPineda1421/LiveMetric](https://github.com/NicolasPineda1421/LiveMetric).

# LiveMetric

[![Pipeline DevSecOps](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/devsecops.yml/badge.svg?branch=main)](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/devsecops.yml)
[![Cobertura de pruebas](https://img.shields.io/endpoint?url=https%3A%2F%2Fnicolaspineda1421.github.io%2FLiveMetric%2Fcoverage.json)](https://nicolaspineda1421.github.io/LiveMetric/)
[![Versión](https://img.shields.io/github/v/release/NicolasPineda1421/LiveMetric?label=versi%C3%B3n)](https://github.com/NicolasPineda1421/LiveMetric/releases)
[![Docker Hub](https://img.shields.io/docker/v/nicolaspineda1421/livemetric?sort=semver&label=docker%20hub)](https://hub.docker.com/r/nicolaspineda1421/livemetric)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE)

**Sistema de elecciones y votación en tiempo real**, construido con microservicios y un ciclo DevSecOps completo.

🎬 **[Ver el video de demostración](https://drive.google.com/file/d/1HpOkFSogfZDGLIgd6HAGYGtBFj954uci/view?usp=drive_link)** (Google Drive)

## Descripción y propósito

LiveMetric permite a una organización programar elecciones con una ventana de tiempo, que cada votante habilitado vote **una sola vez** con su cédula y un PIN, y obtener al cierre un **acta certificada** que nadie puede alterar sin que se note.

- **Elecciones programadas**: plantillas genéricas o presidenciales (con candidatos, número y foto) que se abren y cierran solas según su horario, o se detienen a mano.
- **Voto único por identidad**: el doble voto se impide por la identidad del votante, no por su navegador; el padrón se guarda cifrado.
- **Padrón de miles de votantes**: se carga uno por uno o, de una vez, desde un archivo CSV o las celdas copiadas de Excel, con una revisión de cada fila antes de cargar y la lista de PIN para descargar.
- **Puestos de votación con su ubicación y sus mesas**: cada puesto tiene país, departamento y municipio (de la lista oficial del DANE), localidad y zona urbana o rural; se registra con su primer votante y se corrige en la pestaña **Puestos**. Ahí también se crean, se renombran y se eliminan sus mesas: renombrar una la cambia en sus votantes y sus jurados.
- **Doble factor para votar**: además de su PIN, el votante entra con el código de su app autenticadora (Microsoft o Google Authenticator), que registra en su primer ingreso escaneando un QR. Quien no puede usar una app vota asistido: lo autoriza el jurado de su mesa, que coteja su cédula en persona y escribe el código de su propio autenticador. Un jurado solo puede ser de un puesto cerca de donde vive: de su municipio y, si el puesto tiene localidad, de la suya. Cada PIN vence 24 horas después de generarlo (configurable en el `.env`); votar solo se puede dentro del horario de la elección.
- **Escrutinio independiente**: al cerrar, un servicio aparte recuenta los votos, consolida por mesa, determina el ganador, encadena el acta con hashes SHA-256 y la **firma digitalmente** (Ed25519); también en PDF.
- **Sin resultados parciales**: mientras la elección está abierta, en vivo solo se ve cuántas personas votaron. Los votos por candidato u opción se publican cuando el escrutinio certifica el acta; antes no los entrega el sistema, a nadie.
- **Indicador de veracidad del acta**: cada vez que se consulta un resultado certificado, se comprueba su firma, su hash y los votos guardados, y se muestra si el acta está **verificada**, **alterada** o **sin firma**, en el panel y en el PDF.
- **Reportes con estadística avanzada**: tableros configurables con proyección de participación, momento de definición del resultado, verificación de integridad del acta y detección de accesos sospechosos.
- **Auditoría**: cada intento de ingreso, exitoso o fallido, queda en un registro que no se puede modificar. Roles de administrador, auditor (solo lectura), jurado de mesa y votante.

**Propósito**: es un proyecto universitario que demuestra la seguridad integrada en todo el ciclo de vida del software: modelado de amenazas, controles automáticos en cada commit y push (secretos, código, dependencias, imágenes, infraestructura y ataque dinámico), contenedores endurecidos y despliegue con infraestructura como código.

## Tecnologías empleadas

| Área | Tecnologías |
|---|---|
| Frontend | React 18, Vite, Recharts, react-grid-layout, jsPDF; servido por nginx |
| Backend | Node.js 20, Express, node-cron (4 microservicios y un worker) |
| Base de datos | PostgreSQL 16 en su propio contenedor, en una red interna sin puerto a la PC |
| Seguridad en la aplicación | JWT, bcrypt, segundo factor TOTP (RFC 6238; Microsoft o Google Authenticator), AES-256-GCM (padrón cifrado), cadena de hashes SHA-256, firma digital Ed25519 de las actas, helmet, rate limiting |
| Contenedores e infraestructura | Docker, Docker Compose, Docker Hub, Terraform (provider `kreuzwerker/docker`), Docker-in-Docker |
| Orquestación y observabilidad | Docker Swarm, Prometheus, Grafana, Loki + Promtail, Falco |
| CI/CD y seguridad | GitHub Actions, Gitleaks, Semgrep, ESLint (`eslint-plugin-security`), npm audit, Trivy (también el SBOM, en CycloneDX), Checkov, OWASP ZAP |
| Pruebas | Jest, Supertest, React Testing Library |
| Modelado de amenazas | OWASP Threat Dragon, STRIDE |

## Qué hace cada microservicio

El navegador solo habla con el frontend, en el puerto 3000: nginx sirve la aplicación y reenvía cada llamada del API (`/auth`, `/voting`, `/analytics` y `/scrutiny`) al servicio que corresponde. Los servicios guardan todo en PostgreSQL, que está en una red interna, sin salida a Internet ni puerto en la PC.

| Componente | Qué hace | Imagen |
|---|---|---|
| **Frontend** | La aplicación web (React): el panel del administrador, del auditor y del jurado, y la papeleta del votante. nginx la sirve sin root, con una Content-Security-Policy estricta, y reenvía el API a los microservicios. Exporta a PDF los tableros de reportes | `livemetric-frontend` |
| **Auth** (microservicio A) | Quién entra y con qué rol. Hace el ingreso de los votantes (cédula, PIN y código del autenticador) y del personal (administrador, auditor y jurado), y emite un JWT con el rol de cada uno. Administra:<br>• el padrón, cifrado: alta uno por uno o desde un CSV o Excel, y PIN que vencen;<br>• los puestos de votación, con su ubicación del DANE, y sus mesas;<br>• las cuentas del panel;<br>• el voto asistido.<br>Lleva el registro de auditoría, que no se puede modificar | `livemetric-auth` |
| **Voting** (microservicio B) | Las elecciones y el voto. Administra las plantillas (genéricas, o presidenciales con candidatos) y las elecciones con su horario. Recibe los votos: uno por persona, porque la base no admite un segundo, y solo dentro del horario | `livemetric-voting` |
| **Analytics** (microservicio C) | Lo que se publica. Mientras la elección está abierta, solo cuántas personas votaron; al cierre, el acta certificada. Arma los reportes: participación por puesto, mesa, municipio, departamento o zona, y estadística avanzada. Cada vez que se consulta un resultado, comprueba que el acta no fue alterada | `livemetric-analytics` |
| **Scrutiny** (microservicio D) | El escrutinio, separado de todo lo demás. Al cerrar la elección, recuenta los votos, consolida por mesa y determina el ganador. Después encadena el acta con hashes SHA-256 y la firma con Ed25519: es el único que tiene la clave para firmar. Genera el acta en PDF | `livemetric-scrutiny` |
| **Scheduler** (worker) | Un proceso sin puerto que, cada minuto, abre y cierra las elecciones según su horario y le pide a Scrutiny, con un token interno, que certifique las que cerraron | `livemetric-scheduler` |
| **PostgreSQL** | Los datos. Las actas y la auditoría tienen triggers que impiden cambiarlas o borrarlas | `postgres:16-alpine`; `livemetric-db` en el modo Docker Hub |

Los detalles, los diagramas y las decisiones de diseño están en el [Manual de arquitectura](docs/manual-arquitectura.md).

## Inicio rápido

**Requisito:** [Docker](https://docs.docker.com/get-docker/) (en Windows, Docker Desktop).

**Sin clonar el repositorio**, desde [Docker Hub](https://hub.docker.com/r/nicolaspineda1421/livemetric) ([guía completa](docker-hub/README.md)):

```bash
mkdir livemetric && cd livemetric
docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric   # deja el compose y el .env
docker compose up -d --pull always                                               # http://localhost:3000
docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay
```

Los mismos dos primeros comandos actualizan a la última versión.

**Desde el repositorio**, que además corre el análisis de seguridad antes de arrancar y levanta el monitoreo:

```bash
git clone https://github.com/NicolasPineda1421/LiveMetric.git
cd LiveMetric
```

**1. Configuración (`.env`).** No hay que hacer nada: la primera vez, los scripts de arranque generan el `.env` con secretos aleatorios propios de tu instalación (la contraseña de tu base, tus claves). No se comparte con nadie ni se sube al repo; los detalles, en [el archivo `.env`](docs/instalacion-y-despliegue.md#el-archivo-env).

**2. Arranque.** Elige una opción:

| Opción | Comando | Qué hace |
|---|---|---|
| Linux / macOS | `./scripts/start.sh` | Instala lo que falte, corre el análisis de seguridad y, solo si pasa, levanta el stack y el monitoreo (Grafana en `http://localhost:3010`) |
| Windows | `scripts\start.bat` | Lo mismo, desde `cmd.exe` |
| Solo Docker | `./scripts/contenedor.sh` (o `scripts\contenedor.bat`) | Lo mismo, pero todo dentro de un contenedor global: en la PC no se instala nada más que Docker |

Los dos modos tienen los mismos comandos para después: `estado`, `logs`, `shell`, `admin` (cambiar la contraseña del administrador), `detener` y `borrar`, por ejemplo `./scripts/start.sh estado` o `./scripts/contenedor.sh admin` (ver [instalación y despliegue](docs/instalacion-y-despliegue.md#1-startsh--startbat-recomendada)).

La primera vez tarda varios minutos (construye y analiza las imágenes). Al terminar, cuando los 7 contenedores están sanos, el script muestra las direcciones:

```
  ✔ LiveMetric está arriba

    En esta PC:               http://localhost:3000
    Desde otra PC de la red:  http://192.168.x.x:3000
```

**3. Primer ingreso.** El repositorio no trae ninguna cuenta: con la base nueva, el script de arranque te pide el usuario y la contraseña (sin mostrarla) del primer administrador: tiene que ser segura (12 caracteres o más, variada, no común), y si no lo es, te dice por qué y te la vuelve a pedir. Si lo saltaste, créalo después con `./scripts/start.sh admin` (o `./scripts/contenedor.sh admin`); las demás cuentas se crean desde **Usuarios**. Hay un padrón y plantillas de demostración para probar el ciclo completo (los votantes necesitan un PIN que se genera en **Padrón**) (ver el [recorrido por la interfaz](docs/instalacion-y-despliegue.md#recorrido-por-la-interfaz)).

## Imágenes en Docker Hub

Las imágenes se publican en [Docker Hub](https://hub.docker.com/u/nicolaspineda1421) con cada versión de git (`vX.Y.Z`): las 6 del sistema, la base con su esquema (desde la v1.5.0) y la de instalación, [`nicolaspineda1421/livemetric`](https://hub.docker.com/r/nicolaspineda1421/livemetric) (desde la v1.6.0). Esta última es la puerta de entrada: deja en una carpeta el compose y el `.env`, y su página en Docker Hub ([`docker-hub/README.md`](docker-hub/README.md)) dice qué correr. Cada una se etiqueta con la versión exacta (`1.7.0`), la línea menor (`1.7`) y `latest`; desde la v1.3.3, también con el mismo nombre del tag de git (`v1.7.0`). Antes de subirse, las 8 se escanean con Trivy, y el sistema se levanta con ellas desde la imagen de instalación: si una tiene CVE críticas o altas, o el sistema no arranca, no se publica ninguna (ver [`release.yml`](.github/workflows/release.yml)). `latest` es siempre la versión más nueva: republicar una vieja no lo mueve, y al terminar el workflow comprueba en Docker Hub que `latest` y la versión son la misma imagen en las 8. Cada imagen publicada lleva su SBOM adjunto (`docker buildx imagetools inspect <imagen>:<versión> --format '{{ json .SBOM }}'`). Son las que usan el [compose de Docker Hub](docker-hub/README.md) y el [despliegue con Docker Swarm](orquestacion/README.md).

| Servicio | Imagen |
|---|---|
| **Instalación** (la puerta de entrada) | [`nicolaspineda1421/livemetric`](https://hub.docker.com/r/nicolaspineda1421/livemetric) |
| Frontend | [`nicolaspineda1421/livemetric-frontend`](https://hub.docker.com/r/nicolaspineda1421/livemetric-frontend) |
| Auth | [`nicolaspineda1421/livemetric-auth`](https://hub.docker.com/r/nicolaspineda1421/livemetric-auth) |
| Voting | [`nicolaspineda1421/livemetric-voting`](https://hub.docker.com/r/nicolaspineda1421/livemetric-voting) |
| Analytics | [`nicolaspineda1421/livemetric-analytics`](https://hub.docker.com/r/nicolaspineda1421/livemetric-analytics) |
| Scrutiny | [`nicolaspineda1421/livemetric-scrutiny`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scrutiny) |
| Scheduler (worker) | [`nicolaspineda1421/livemetric-scheduler`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scheduler) |
| Base de datos (PostgreSQL 16 con el esquema) | [`nicolaspineda1421/livemetric-db`](https://hub.docker.com/r/nicolaspineda1421/livemetric-db) |

```bash
docker pull nicolaspineda1421/livemetric-auth:1.7.0
```

Para publicar una versión nueva basta con crear el tag: `git tag -a v1.7.0 -m "..." && git push origin v1.7.0`.

### SBOM

El SBOM (*Software Bill of Materials*) es el inventario de todo lo que lleva cada imagen: los paquetes de Alpine y las librerías de Node.js, con su versión. Lo genera Trivy. No se guarda en el repositorio, sino junto a cada imagen y en cada corrida del pipeline:

- **Adjunto a cada imagen en Docker Hub**, en formato SPDX. Se lee con:
  ```bash
  docker buildx imagetools inspect nicolaspineda1421/livemetric-auth:1.7.0 --format '{{ json .SBOM }}'
  ```
- **En cada publicación**, en formato CycloneDX: el de la imagen y el de las dependencias de cada servicio. Están en los *Artifacts* de la corrida de [`release.yml`](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/release.yml), como `sbom-<servicio>-vX.Y.Z`. Los de la v1.6.0 están en [esta corrida](https://github.com/NicolasPineda1421/LiveMetric/actions/runs/38641814630).
- **En cada push**, en los *Artifacts* de la corrida de [`devsecops.yml`](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/devsecops.yml), como `sbom-<servicio>`.
- **En la PC**, `./scripts/pipeline-local.sh` los deja en la subcarpeta `sbom` de su carpeta de resultados (el cuadro final dice dónde).

GitHub guarda los artefactos 90 días; el SBOM adjunto en Docker Hub se queda con la imagen. Más detalle en [Pipeline DevSecOps](docs/pipeline-devsecops.md).

## Estructura del repositorio

La estructura sigue la que propone el enunciado del curso. Dos carpetas tienen el nombre corto que se usa en los proyectos de software (`infra/` y `services/`); el pipeline, los scripts y la documentación usan esas rutas.

| Carpeta del enunciado | En este repositorio | Contenido |
|---|---|---|
| `LICENSE`, `README.md`, `docker-compose.yml` | Igual | Licencia MIT, este documento y el stack completo |
| `.github/workflows/` | Igual | [`devsecops.yml`](.github/workflows/devsecops.yml) (pipeline de seguridad), [`release.yml`](.github/workflows/release.yml) (publicación en Docker Hub) y [`pagina-docker-hub.yml`](.github/workflows/pagina-docker-hub.yml) (la página de la imagen de entrada) |
| `infraestructura/` | [`infra/`](infra/) | Terraform (IaC, con las políticas propias de Checkov) y el contenedor global |
| `orquestacion/` | Igual | Docker Swarm: stack con réplicas, rolling updates y red cifrada |
| `servicios/` | [`services/`](services/) | Un directorio por microservicio: `auth`, `voting`, `analytics`, `scrutiny`, `scheduler` (worker) y `frontend` |
| `docs/` | Igual | Informe técnico, manuales, modelo de amenazas (Threat Dragon) y sustentación |
| Además | [`db/`](db/) | Esquema inicial de PostgreSQL y migraciones |
| Además | [`monitoring/`](monitoring/) | Prometheus, Grafana, Loki + Promtail y Falco |
| Además | [`scripts/`](scripts/) | Arranque, pipeline local, hook de Gitleaks, demo del ataque al acta y generación del PDF del informe |

El árbol completo, archivo por archivo, está en [Arquitectura](docs/arquitectura.md#estructura-del-repositorio).

## Documentación

| Documento | Contenido |
|---|---|
| [Informe técnico](docs/informe-tecnico.md) ([PDF](docs/informe-tecnico.pdf)) | El informe del trabajo final: arquitectura, modelo de amenazas, pipeline, resultados de seguridad, monitoreo y conclusiones. El PDF se genera con `scripts/informe` |
| [Sustentación](docs/sustentacion/historia-de-usuario.md) | La historia de usuario de la sustentación, con su demostración en vivo (incluido un ataque a un acta), y el [guion del video](docs/sustentacion/guion-video.md) |
| [Manual de Arquitectura](docs/manual-arquitectura.md) | Estilo arquitectónico, patrones, ADRs, modelo de datos y los 7 diagramas (componentes, despliegue, secuencia, casos de uso, DFD 0 y 1) |
| [Arquitectura](docs/arquitectura.md) | Componentes, red, secretos, flujo de punta a punta y estructura del repositorio |
| [Instalación y despliegue](docs/instalacion-y-despliegue.md) | Las cuatro formas de levantarlo, `.env`, base de datos, Windows, acceso desde la red, datos de demostración, API por línea de comandos y solución de problemas |
| [Manual de desarrollo](docs/manual-desarrollo.md) | Entorno local, modo desarrollo con recarga automática, pruebas, ramas, commits, revisión y publicación de versiones |
| [Manual de seguridad](docs/manual-seguridad.md) | Modelo de amenazas, herramientas y su configuración, cómo leer cada reporte, gestión de vulnerabilidades y rotación de secretos |
| [Pipeline DevSecOps](docs/pipeline-devsecops.md) | Cada job del pipeline, cómo correrlo en local y cómo comprobar que los controles bloquean |
| [Guía de validación](docs/guia-de-validacion.md) | Pruebas manuales de cada funcionalidad |
| [Decisiones y riesgos](docs/decisiones-y-riesgos.md) | Decisiones de diseño y riesgos aceptados |
| [Modelo de amenazas](docs/threat-model/STRIDE-analysis.md) | Análisis STRIDE y diagramas de flujo de datos |
| [Manual de Usuario](docs/manual-usuario.md) | Guía de cada rol (administrador, votante, auditor y jurado), con capturas de pantalla |
| [Orquestación](orquestacion/README.md) | Despliegue en Docker Swarm con réplicas, rolling updates y red cifrada |
| [Observabilidad](monitoring/README.md) | Prometheus, Grafana, Loki y Falco: métricas, logs y detección en runtime |

## 🎬 Demostración de LiveMetric

Consulta el video de demostración del sistema, donde se presentan sus funcionalidades y su funcionamiento.

[▶️ Ver video de demostración de LiveMetric en Google Drive](https://drive.google.com/file/d/1HpOkFSogfZDGLIgd6HAGYGtBFj954uci/view?usp=drive_link)

## Licencia

Distribuido bajo la licencia **MIT**: se puede usar, copiar, modificar y distribuir libremente, conservando el aviso de copyright. Ver [LICENSE](LICENSE).

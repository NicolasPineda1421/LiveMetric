# LiveMetric

[![Pipeline DevSecOps](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/devsecops.yml/badge.svg?branch=main)](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/devsecops.yml)
[![Cobertura de pruebas](https://img.shields.io/endpoint?url=https%3A%2F%2Fnicolaspineda1421.github.io%2FLiveMetric%2Fcoverage.json)](https://nicolaspineda1421.github.io/LiveMetric/)
[![Versión](https://img.shields.io/github/v/release/NicolasPineda1421/LiveMetric?label=versi%C3%B3n)](https://github.com/NicolasPineda1421/LiveMetric/releases)
[![Docker Hub](https://img.shields.io/docker/v/nicolaspineda1421/livemetric-auth?sort=semver&label=docker%20hub)](https://hub.docker.com/u/nicolaspineda1421)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE)

**Sistema de elecciones y votación en tiempo real**, construido con microservicios y un ciclo DevSecOps completo.

## Descripción y propósito

LiveMetric permite a una organización programar elecciones con una ventana de tiempo, que cada votante habilitado vote **una sola vez** con su cédula y un PIN, y obtener al cierre un **acta certificada** que nadie puede alterar sin que se note.

- **Elecciones programadas**: plantillas genéricas o presidenciales (con candidatos, número y foto) que se abren y cierran solas según su horario, o se detienen a mano.
- **Voto único por identidad**: el doble voto se impide por la identidad del votante, no por su navegador; el padrón se guarda cifrado.
- **Escrutinio independiente**: al cerrar, un servicio aparte recuenta los votos, consolida por mesa, determina el ganador, encadena el acta con hashes SHA-256 y la **firma digitalmente** (Ed25519); también en PDF.
- **Indicador de veracidad del acta**: cada vez que se consulta un resultado certificado, se comprueba su firma, su hash y los votos guardados, y se muestra si el acta está **verificada**, **alterada** o **sin firma**, en el panel y en el PDF.
- **Reportes con estadística avanzada**: tableros configurables con proyección de participación, momento de definición del resultado, verificación de integridad del acta y detección de accesos sospechosos.
- **Auditoría**: cada intento de ingreso, exitoso o fallido, queda en un registro que no se puede modificar. Roles de administrador, auditor (solo lectura) y votante.

**Propósito**: es un proyecto universitario que demuestra la seguridad integrada en todo el ciclo de vida del software: modelado de amenazas, controles automáticos en cada commit y push (secretos, código, dependencias, imágenes, infraestructura y ataque dinámico), contenedores endurecidos y despliegue con infraestructura como código.

## Tecnologías empleadas

| Área | Tecnologías |
|---|---|
| Frontend | React 18, Vite, Recharts, react-grid-layout, jsPDF; servido por nginx |
| Backend | Node.js 20, Express, node-cron (4 microservicios y un worker) |
| Base de datos | PostgreSQL 16 en su propio contenedor, en una red interna sin puerto a la PC |
| Seguridad en la aplicación | JWT, bcrypt, AES-256-GCM (padrón cifrado), cadena de hashes SHA-256, firma digital Ed25519 de las actas, helmet, rate limiting |
| Contenedores e infraestructura | Docker, Docker Compose, Docker Hub, Terraform (provider `kreuzwerker/docker`), Docker-in-Docker |
| Orquestación y observabilidad | Docker Swarm, Prometheus, Grafana, Loki + Promtail, Falco |
| CI/CD y seguridad | GitHub Actions, Gitleaks, Semgrep, ESLint (`eslint-plugin-security`), npm audit, Trivy, Checkov, OWASP ZAP |
| Pruebas | Jest, Supertest, React Testing Library |
| Modelado de amenazas | OWASP Threat Dragon, STRIDE |

## Inicio rápido

**Requisito:** [Docker](https://docs.docker.com/get-docker/) (en Windows, Docker Desktop).

```bash
git clone https://github.com/NicolasPineda1421/LiveMetric.git
cd LiveMetric
```

**1. Configuración (`.env`).** No hay que hacer nada: la primera vez, los scripts de arranque generan el `.env` con secretos aleatorios propios de tu instalación (la contraseña de tu base, tus claves). No se comparte con nadie ni se sube al repo; los detalles, en [el archivo `.env`](docs/instalacion-y-despliegue.md#el-archivo-env).

**2. Arranque.** Elige una opción:

| Opción | Comando | Qué hace |
|---|---|---|
| Linux / macOS | `./scripts/start.sh` | Instala lo que falte, corre el análisis de seguridad y, solo si pasa, levanta el stack |
| Windows | `scripts\start.bat` | Lo mismo, desde `cmd.exe` |
| Solo Docker | `./scripts/contenedor.sh` | Lo mismo, pero todo dentro de un contenedor global: en la PC no se instala nada más |

La primera vez tarda varios minutos (construye y analiza las 6 imágenes). Al terminar, cuando los 7 contenedores están sanos, el script muestra las direcciones:

```
  ✔ LiveMetric está arriba

    En esta PC:               http://localhost:3000
    Desde otra PC de la red:  http://192.168.x.x:3000
```

**3. Primer ingreso.** El repositorio no trae ninguna cuenta: con la base nueva, el script de arranque te pide el usuario y la contraseña (sin mostrarla) del primer administrador. Si lo saltaste, créalo después con `docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay`; las demás cuentas se crean desde **Usuarios**. Hay un padrón y plantillas de demostración para probar el ciclo completo (los votantes necesitan un PIN que se genera en **Padrón**) (ver el [recorrido por la interfaz](docs/instalacion-y-despliegue.md#recorrido-por-la-interfaz)).

## Imágenes en Docker Hub

Las 6 imágenes se publican en [Docker Hub](https://hub.docker.com/u/nicolaspineda1421) con cada versión de git (`vX.Y.Z`), etiquetadas con la versión exacta (`1.3.2`), la línea menor (`1.3`) y `latest`; desde la v1.3.3, también con el mismo nombre del tag de git (`v1.3.3`). Antes de subirse, cada una se escanea con Trivy: si tiene CVE críticas o altas, no se publica (ver [`release.yml`](.github/workflows/release.yml)). Son las que usa el [despliegue con Docker Swarm](orquestacion/README.md).

| Servicio | Imagen |
|---|---|
| Frontend | [`nicolaspineda1421/livemetric-frontend`](https://hub.docker.com/r/nicolaspineda1421/livemetric-frontend) |
| Auth | [`nicolaspineda1421/livemetric-auth`](https://hub.docker.com/r/nicolaspineda1421/livemetric-auth) |
| Voting | [`nicolaspineda1421/livemetric-voting`](https://hub.docker.com/r/nicolaspineda1421/livemetric-voting) |
| Analytics | [`nicolaspineda1421/livemetric-analytics`](https://hub.docker.com/r/nicolaspineda1421/livemetric-analytics) |
| Scrutiny | [`nicolaspineda1421/livemetric-scrutiny`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scrutiny) |
| Scheduler (worker) | [`nicolaspineda1421/livemetric-scheduler`](https://hub.docker.com/r/nicolaspineda1421/livemetric-scheduler) |

```bash
docker pull nicolaspineda1421/livemetric-auth:1.3.2
```

Para publicar una versión nueva basta con crear el tag: `git tag -a v1.4.0 -m "..." && git push origin v1.4.0`.

## Documentación

| Documento | Contenido |
|---|---|
| [Manual de Arquitectura](docs/manual-arquitectura.md) | Estilo arquitectónico, patrones, ADRs, modelo de datos y los 7 diagramas (componentes, despliegue, secuencia, casos de uso, DFD 0 y 1) |
| [Arquitectura](docs/arquitectura.md) | Componentes, red, secretos, flujo de punta a punta y estructura del repositorio |
| [Instalación y despliegue](docs/instalacion-y-despliegue.md) | Las cuatro formas de levantarlo, `.env`, base de datos, Windows, acceso desde la red, datos de demostración, API por línea de comandos y solución de problemas |
| [Manual de desarrollo](docs/manual-desarrollo.md) | Entorno local, modo desarrollo con recarga automática, pruebas, ramas, commits, revisión y publicación de versiones |
| [Manual de seguridad](docs/manual-seguridad.md) | Modelo de amenazas, herramientas y su configuración, cómo leer cada reporte, gestión de vulnerabilidades y rotación de secretos |
| [Pipeline DevSecOps](docs/pipeline-devsecops.md) | Cada job del pipeline, cómo correrlo en local y cómo comprobar que los controles bloquean |
| [Guía de validación](docs/guia-de-validacion.md) | Pruebas manuales de cada funcionalidad |
| [Decisiones y riesgos](docs/decisiones-y-riesgos.md) | Decisiones de diseño y riesgos aceptados |
| [Modelo de amenazas](docs/threat-model/STRIDE-analysis.md) | Análisis STRIDE y diagramas de flujo de datos |
| [Manual de Usuario](docs/manual-usuario.md) | Guía de las tres interfaces con capturas de pantalla |
| [Orquestación](orquestacion/README.md) | Despliegue en Docker Swarm con réplicas, rolling updates y red cifrada |
| [Observabilidad](monitoring/README.md) | Prometheus, Grafana, Loki y Falco: métricas, logs y detección en runtime |

## Licencia

Distribuido bajo la licencia **MIT**: se puede usar, copiar, modificar y distribuir libremente, conservando el aviso de copyright. Ver [LICENSE](LICENSE).

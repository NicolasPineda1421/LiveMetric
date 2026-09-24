# LiveMetric

[![Pipeline DevSecOps](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/devsecops.yml/badge.svg?branch=main)](https://github.com/NicolasPineda1421/LiveMetric/actions/workflows/devsecops.yml)
[![Cobertura de pruebas](https://img.shields.io/endpoint?url=https%3A%2F%2Fnicolaspineda1421.github.io%2FLiveMetric%2Fcoverage.json)](https://nicolaspineda1421.github.io/LiveMetric/)
[![Versión](https://img.shields.io/github/v/release/NicolasPineda1421/LiveMetric?label=versi%C3%B3n)](https://github.com/NicolasPineda1421/LiveMetric/releases)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE)

**Sistema de elecciones y votación en tiempo real**, construido con microservicios y un ciclo DevSecOps completo.

## Descripción y propósito

LiveMetric permite a una organización programar elecciones con una ventana de tiempo, que cada votante habilitado vote **una sola vez** con su cédula y un PIN, y obtener al cierre un **acta certificada** que nadie puede alterar sin que se note.

- **Elecciones programadas**: plantillas genéricas o presidenciales (con candidatos, número y foto) que se abren y cierran solas según su horario, o se detienen a mano.
- **Voto único por identidad**: el doble voto se impide por la identidad del votante, no por su navegador; el padrón se guarda cifrado.
- **Escrutinio independiente**: al cerrar, un servicio aparte recuenta los votos, consolida por mesa, determina el ganador y encadena el acta con hashes SHA-256 (también en PDF).
- **Reportes con estadística avanzada**: tableros configurables con proyección de participación, momento de definición del resultado, verificación de integridad del acta y detección de accesos sospechosos.
- **Auditoría**: cada intento de ingreso, exitoso o fallido, queda en un registro que no se puede modificar. Roles de administrador, auditor (solo lectura) y votante.

**Propósito**: es un proyecto universitario que demuestra la seguridad integrada en todo el ciclo de vida del software: modelado de amenazas, controles automáticos en cada commit y push (secretos, código, dependencias, imágenes, infraestructura y ataque dinámico), contenedores endurecidos y despliegue con infraestructura como código.

## Tecnologías empleadas

| Área | Tecnologías |
|---|---|
| Frontend | React 18, Vite, Recharts, react-grid-layout, jsPDF; servido por nginx |
| Backend | Node.js 20, Express, node-cron (4 microservicios y un worker) |
| Base de datos | PostgreSQL gestionado en Supabase (conexión TLS verificada) |
| Seguridad en la aplicación | JWT, bcrypt, AES-256-GCM (padrón cifrado), cadena de hashes SHA-256, helmet, rate limiting |
| Contenedores e infraestructura | Docker, Docker Compose, Terraform (provider `kreuzwerker/docker`), Docker-in-Docker |
| CI/CD y seguridad | GitHub Actions, Gitleaks, Semgrep, npm audit, Trivy, Checkov, OWASP ZAP |
| Pruebas | Jest, Supertest |
| Modelado de amenazas | OWASP Threat Dragon, STRIDE |

## Inicio rápido

**Requisito:** [Docker](https://docs.docker.com/get-docker/) (en Windows, Docker Desktop).

```bash
git clone https://github.com/NicolasPineda1421/LiveMetric.git
cd LiveMetric
```

**1. Configuración (`.env`).** El repo trae el `.env` del equipo cifrado (`.env.gpg`): los scripts de arranque lo descifran solos y te piden la passphrase, que se comparte por otro canal. Si vas a usar tu propia base de Supabase, copia `.env.example` a `.env` y sigue [estos pasos](docs/instalacion-y-despliegue.md#el-archivo-env).

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

**3. Primer ingreso.** Entra con tu cuenta de administrador; el repositorio no trae ninguna. Si la base es nueva, crea la primera con `docker compose run --rm auth-service node src/scripts/crearAdmin.js <usuario>`, que pide la contraseña sin mostrarla; las demás se crean desde **Usuarios**. Hay un padrón y plantillas de demostración para probar el ciclo completo (los votantes necesitan un PIN que se genera en **Padrón**) (ver el [recorrido por la interfaz](docs/instalacion-y-despliegue.md#recorrido-por-la-interfaz)).

## Documentación

| Documento | Contenido |
|---|---|
| [Arquitectura](docs/arquitectura.md) | Componentes, red, secretos, flujo de punta a punta y estructura del repositorio |
| [Instalación y despliegue](docs/instalacion-y-despliegue.md) | Las cuatro formas de levantarlo, `.env`, Windows, acceso desde la red, datos de demostración, API por línea de comandos |
| [Pipeline DevSecOps](docs/pipeline-devsecops.md) | Cada job del pipeline, cómo correrlo en local y cómo comprobar que los controles bloquean |
| [Guía de validación](docs/guia-de-validacion.md) | Pruebas manuales de cada funcionalidad |
| [Decisiones y riesgos](docs/decisiones-y-riesgos.md) | Decisiones de diseño y riesgos aceptados |
| [Estrategia de ramas](docs/estrategia-de-ramas.md) | GitHub Flow y protección de `main` |
| [Modelo de amenazas](docs/threat-model/STRIDE-analysis.md) | Análisis STRIDE y diagramas de flujo de datos |

## Licencia

Distribuido bajo la licencia **MIT**: se puede usar, copiar, modificar y distribuir libremente, conservando el aviso de copyright. Ver [LICENSE](LICENSE).

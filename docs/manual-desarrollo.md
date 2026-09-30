# Manual de desarrollo

Para quien modifica el código de LiveMetric: cómo preparar el entorno, trabajar con recarga automática, correr las pruebas y contribuir. Para levantar el sistema sin tocar el código, ver [Instalación y despliegue](instalacion-y-despliegue.md); para entender cómo está armado, el [Manual de Arquitectura](manual-arquitectura.md).

## 1. Requisitos

| Herramienta | Para qué |
|---|---|
| **Docker** con Compose v2.22 o posterior | El stack, la base de las pruebas y el modo desarrollo (`docker compose watch`) |
| **Node.js 20** o posterior | Pruebas, ESLint, el servidor de desarrollo del frontend y los scripts |
| **Git** | — |
| **Gitleaks** (opcional) | El hook que revisa cada commit en busca de secretos. Sin él, el hook avisa y deja pasar el commit; el pipeline lo revisa igual |

En Windows, los comandos de este manual corren en Git Bash o WSL2; los scripts principales también tienen su versión `.bat`.

## 2. Preparar el entorno

```bash
git clone https://github.com/NicolasPineda1421/LiveMetric.git
cd LiveMetric

node scripts/lib/generar-env.js    # .env con secretos aleatorios propios
./scripts/install-hooks.sh         # Gitleaks antes de cada commit

# Dependencias de cada servicio (incluye Jest y ESLint)
for s in auth voting analytics scrutiny scheduler frontend; do (cd services/$s && npm ci); done
```

El `.env` nunca se commitea (está en `.gitignore`) ni se comparte: cada persona tiene el suyo y su propia base. Ver [el archivo `.env`](instalacion-y-despliegue.md#el-archivo-env).

## 3. Dónde está cada cosa

| Ruta | Contenido |
|---|---|
| `services/<servicio>/src/app.js` | La app de Express, exportada sin abrir el puerto para que las pruebas la usen con Supertest |
| `services/<servicio>/src/index.js` | Arranque del servicio (`app.listen`) |
| `services/<servicio>/src/db.js` | Pool de PostgreSQL; todas las consultas usan parámetros (`$1`, `$2`, …) |
| `services/<servicio>/src/__tests__/` | Pruebas unitarias y de integración |
| `services/frontend/src/` | La SPA de React: `pages/`, `components/`, y `api.js` (el cliente HTTP) |
| `db/init.sql` y `db/migrations/` | Esquema completo y migraciones para bases anteriores |
| `scripts/lib/` | Piezas compartidas: generación del `.env`, base desechable de las pruebas, reglas de ESLint, presentación de los scripts |

## 4. Modo desarrollo

### 4.1 Backends: `docker compose watch`

```bash
docker compose up -d --build     # la primera vez, o después de cambiar el .env
docker compose watch             # deja la terminal mirando los cambios
```

Con `watch` activo, al guardar un archivo de `services/<servicio>/src` (o su `package.json`) Compose reconstruye la imagen de ese servicio y lo reinicia, sin tocar los demás. Tarda de 20 a 30 segundos, porque se reconstruye la misma imagen que va a producción (sin root y con el sistema de archivos de solo lectura): lo que funciona en desarrollo funciona desplegado. Los cambios en `__tests__/` no reinician nada.

En otra terminal:

```bash
docker compose logs -f auth-service      # logs de un servicio
docker compose ps                        # estado de los 7 contenedores
```

Para probar la lógica sin esperar la reconstrucción, lo más rápido son las pruebas (sección 5): corren contra la app de Express en memoria.

### 4.2 Frontend: Vite con recarga en caliente

```bash
docker compose stop frontend          # libera el puerto 3000
cd services/frontend
npm run dev                           # http://localhost:3000
```

Cada cambio en `services/frontend/src` se ve en el navegador al instante. En este modo el navegador llama directo a los servicios en `127.0.0.1:3001` a `3004` (ver `src/api.js`), que aceptan peticiones del origen `http://localhost:3000` (`FRONTEND_ORIGIN` en el `.env`). Si se usa otro puerto, hay que cambiar `FRONTEND_ORIGIN` y recrear los servicios con `docker compose up -d`.

Al terminar: `docker compose start frontend` vuelve a servir la versión construida por nginx.

### 4.3 La base de datos

```bash
docker compose exec postgres psql -U livemetric -d livemetric   # consola SQL
docker compose down -v                                           # borrar la base y empezar de cero
```

Un cambio de esquema se hace en dos lugares:

1. En `db/init.sql`, para que toda base nueva lo tenga.
2. En `db/migrations/00N_<descripcion>.sql`, para las bases que ya existen. Tiene que poder correr varias veces sin romper nada (`IF NOT EXISTS`): el servicio `migraciones` de `docker-compose.yml` aplica todas las de esa carpeta en cada arranque, antes que los servicios, y en Swarm lo hace `deploy.sh`.

Las tablas `scrutiny_ledger` y `audit_log` son append-only: un trigger rechaza cualquier `UPDATE` o `DELETE`, también durante el desarrollo.

Con la base recién creada hace falta un administrador: `docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay`.

## 5. Pruebas

```bash
cd services/auth                     # o cualquier otro servicio, o services/frontend
npm test                             # todas las pruebas del servicio
npm test -- --coverage               # con cobertura (como en el pipeline)
npx jest src/__tests__/app.test.js   # un solo archivo
npx jest -t "PIN"                    # solo las pruebas cuyo nombre contiene "PIN"
npm run lint                         # ESLint con las reglas de seguridad
```

- **Unitarias**: funciones puras sin base de datos, como la estadística avanzada (`advancedStats.test.js`) o la firma de las actas (`actaSignature.test.js`).
- **De integración**: `app.test.js` en cada servicio. Llaman a los endpoints HTTP reales con Supertest, contra un **PostgreSQL de verdad**.
- **La base de las pruebas es desechable**: cada `npm test` levanta un PostgreSQL en un contenedor propio, le carga `db/init.sql` y lo borra al terminar (`scripts/lib/jest-db-setup.js`). Por eso las pruebas necesitan Docker, pero no el `.env` ni el stack, y nunca tocan la base de desarrollo. Los secretos también son aleatorios en cada corrida (`jest.setup.js`).
- **Frontend** (`services/frontend/src/__tests__/`): Jest con React Testing Library sobre jsdom. No usan base ni servicios, ni Docker: el cliente HTTP (`api.js`) se reemplaza por un doble (`apiFalsa.js`) y cada prueba decide qué responde. Cubren lo que se ve en pantalla y no debe fallar: el sello de veracidad del acta (verde solo si todo cuadra, también si la verificación llega tarde), la papeleta (no vuelve a aparecer en una elección ya votada, el historial no dice por quién se votó, un nombre con HTML se muestra como texto), qué pestañas ve cada rol, que la sesión no quede guardada en el navegador y las confirmaciones antes de detener una elección o regenerar un PIN. Los gráficos (Recharts) y la exportación a PDF no se prueban aquí: necesitan medir y dibujar la página, y jsdom no lo hace.

Todo el análisis del pipeline (Gitleaks, Semgrep, ESLint, npm audit, Trivy, imágenes y pruebas) corre en la PC con `./scripts/pipeline-local.sh` (o `scripts\pipeline-local.bat`) en unos 5 minutos. Ver [Pipeline DevSecOps](pipeline-devsecops.md#correr-el-mismo-análisis-en-la-pc).

## 6. Contribuir

### 6.1 Estrategia de ramas: todo sobre `main`

El equipo trabaja directo sobre `main` (*trunk-based development*): commits pequeños y frecuentes, sin ramas de larga duración. `main` tiene que estar siempre desplegable, y lo sostienen tres controles:

1. **Antes del commit**, el hook de Gitleaks bloquea cualquier secreto en los cambios preparados.
2. **Antes del push**, `./scripts/pipeline-local.sh` corre los mismos controles que el pipeline.
3. **En cada push**, el pipeline de GitHub Actions corre completo y el *Security Gate* resume si todo pasó.

Si el pipeline falla en `main`, arreglarlo es lo primero: nadie sube cambios nuevos encima de un `main` en rojo.

Para un cambio grande o delicado (autenticación, criptografía, el pipeline), conviene una rama corta y un Pull Request hacia `main`: el pipeline también corre en cada PR y deja revisar el cambio antes de integrarlo. La rama se nombra `tipo/descripcion-corta`, con `feature/`, `fix/`, `hotfix/` o `chore/` (infraestructura, pipeline, dependencias o documentación), y se borra al integrarla. `scripts/setup-branch-protection.sh` configura la protección de `main` que exige PR y el *Security Gate* en verde; no está aplicada porque el equipo integra directo.

### 6.2 Convención de commits

- **Título en español, en tercera persona y en presente**, que diga qué cambia: `Agrega …`, `Corrige …`, `Reemplaza …`, `Elimina …`. Idealmente hasta unos 72 caracteres.
- **Cuerpo** (separado por una línea en blanco), para el *por qué* y lo que no se ve en el diff: la decisión tomada, el riesgo que cierra, lo que queda pendiente.
- **Un tema por commit.** Si el título necesita un "y" para dos cosas sin relación, son dos commits.

Ejemplos del historial:

```
Corrige la inyeccion de comandos en release.yml y compara la contrasena en tiempo constante en crearAdmin.js
Reemplaza Supabase por un PostgreSQL local propio de cada instalacion
Firma digital de las actas e indicador de veracidad en el panel y el PDF
```

### 6.3 Antes de hacer push

- [ ] `npm test` y `npm run lint` pasan en los servicios que tocaste.
- [ ] `./scripts/pipeline-local.sh` termina en verde.
- [ ] Si agregaste una excepción (ESLint, Semgrep, Trivy o Gitleaks), tiene su justificación al lado. Ver el [Manual de seguridad](manual-seguridad.md#5-gestión-de-vulnerabilidades).
- [ ] Si cambió algo que se ve o se opera, la documentación de `docs/` lo dice.
- [ ] Nada de secretos: los valores reales viven solo en el `.env`.

### 6.4 Revisión

El pipeline es la revisión automática obligatoria de todo cambio. La revisión humana se centra en lo que las herramientas no ven: que el cambio haga lo que dice, que las excepciones de seguridad estén bien justificadas y que la documentación siga siendo cierta. Los cambios que pasan por Pull Request usan la plantilla de `.github/pull_request_template.md`. `.github/CODEOWNERS` reparte las áreas del repositorio (pipeline e infraestructura, autenticación, frontend), pero todavía apunta a equipos de ejemplo (`@equipo-livemetric/…`) que no existen en GitHub: para que asigne revisores hay que reemplazarlos por los usuarios del equipo.

### 6.5 Publicar una versión

```bash
git tag -a v1.4.0 -m "LiveMetric v1.4.0: <resumen>"
git push origin v1.4.0
```

El tag dispara `.github/workflows/release.yml`: construye las 6 imágenes, las escanea con Trivy (si alguna tiene CVE críticas o altas no se publica) y las sube a Docker Hub como `1.4.0`, `v1.4.0` (igual que el tag de git), `1.4` y `latest`. Se usa versionado semántico: el tercer número para correcciones, el segundo para funcionalidad nueva compatible y el primero para cambios que rompen compatibilidad.

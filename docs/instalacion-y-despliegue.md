# Instalación y despliegue

Hay cuatro formas de levantar LiveMetric. Todas usan el mismo `docker-compose.yml` (salvo Terraform) y el mismo `.env`.

| Forma | Qué hace | Qué necesita la PC |
|---|---|---|
| [`start.sh` / `start.bat`](#1-startsh--startbat-recomendada) | Corre el análisis de seguridad y, solo si pasa, levanta el stack | Docker (instala solo lo demás que falte) |
| [`contenedor.sh` / `contenedor.bat`](#2-contenedor-global-solo-docker) | Lo mismo, pero todo dentro de un contenedor global | Solo Docker |
| [`docker compose`](#3-docker-compose-directo) | Levanta el stack sin analizar nada | Docker |
| [Terraform](#4-terraform-infraestructura-como-código) | El stack como código, con su propio PostgreSQL local | Docker + Terraform |

## El archivo `.env`

Todas las formas necesitan un `.env` en la raíz del repo, con las credenciales de la base y los secretos del sistema. Hay dos caminos:

**A. Con el `.env.gpg` del equipo (lo habitual).** El repo trae el `.env` cifrado. Si no hay `.env`, `start.sh`, `start.bat` y `contenedor.sh` lo descifran solos y piden la passphrase, que se comparte por otro canal. A mano: `gpg --output .env --decrypt .env.gpg`.

**B. Con tu propia base de Supabase.**

1. `cp .env.example .env` y completa los valores. De Supabase usa el **Session Pooler** (Project Settings → Database → Connection Pooling), no la conexión directa: esa solo resuelve por IPv6 y no se alcanza desde la red de Docker.
2. Genera un valor **distinto** para `JWT_SECRET`, `VOTER_ID_SALT` e `INTERNAL_SERVICE_TOKEN`:

   | Sistema | Comando |
   |---|---|
   | Linux / macOS / Git Bash | `openssl rand -base64 48` |
   | Windows PowerShell | `$b=New-Object byte[] 48; [System.Security.Cryptography.RNGCryptoServiceProvider]::new().GetBytes($b); [Convert]::ToBase64String($b)` |
   | Con Node.js | `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |

   `VOTERS_ENCRYPTION_KEY` es una clave AES-256: tiene que ser de **exactamente 32 bytes**, así que genérala con `openssl rand -base64 32` (o `randomBytes(32)` en Node).
3. En el SQL Editor de Supabase, ejecuta en orden `db/init.sql` y las migraciones de `db/migrations/` (002, 003, 004). No hay un ejecutor de migraciones: se corren a mano, y son seguras de repetir.
4. Con el stack arriba, cifra el padrón de demostración (queda en texto plano hasta hacerlo una vez):

   ```bash
   docker compose run --rm auth-service node src/scripts/backfillVoterEncryption.js
   ```

## 1. `start.sh` / `start.bat` (recomendada)

```bash
./scripts/start.sh            # Linux / macOS / WSL
scripts\start.bat             # Windows (cmd.exe)
```

1. **Requisitos**: instala lo que falte (Docker, gpg, Node.js) con el gestor de paquetes del sistema, o con `winget` en Windows.
2. **`.env`**: lo usa si existe; si no, descifra `.env.gpg`.
3. **Análisis de seguridad**: los mismos controles que el pipeline de GitHub Actions (Gitleaks, Semgrep, npm audit, Trivy, las 6 imágenes reales y las pruebas), cada uno con su resultado ya interpretado y un cuadro final por servicio. Si algo falla (✘), **se detiene ahí** y no levanta nada.
4. **Levantar**: `docker compose up --build` y espera, sin límite de tiempo, a que los 7 contenedores estén sanos (*healthy*), mostrando el estado de cada uno en vivo.

Al final muestra la URL en esta PC y la URL para el resto de la red local. Con `--detalle` se ve además la salida completa de cada herramienta; sin eso queda en un log por paso, cuya carpeta se indica al empezar.

## 2. Contenedor global (solo Docker)

`scripts/contenedor.sh` (o `scripts\contenedor.bat` en Windows) mete el proyecto entero en **un solo contenedor** con su propio motor de Docker adentro (*Docker-in-Docker*, imagen en `infra/contenedor-global/`). Ahí corre el mismo análisis de seguridad y, solo si pasa, el mismo `docker-compose.yml`: los 7 contenedores del stack quedan **dentro** del global. En la PC no se instala nada más que Docker.

```bash
./scripts/contenedor.sh             # construye, analiza y levanta todo adentro
./scripts/contenedor.sh estado      # estado de cada microservicio
./scripts/contenedor.sh logs        # logs en vivo (o: logs auth-service)
./scripts/contenedor.sh shell       # terminal dentro del contenedor global
./scripts/contenedor.sh detener     # apaga el contenedor global y todo lo de adentro
./scripts/contenedor.sh borrar      # además borra su imagen y la caché
```

- El frontend queda en `http://localhost:3000`. Si ese puerto está ocupado (por ejemplo, por el stack levantado con `start.sh`), el script lo avisa; se puede usar otro con `LIVEMETRIC_PUERTO=3100 ./scripts/contenedor.sh`.
- El `.env` de la carpeta se monta en solo lectura y nunca queda dentro de la imagen. Si no existe, se descifra adentro desde `.env.gpg` y no queda en la carpeta.
- Las imágenes construidas adentro se guardan en el volumen `livemetric-global-docker`: desde la segunda vez arranca mucho más rápido.
- **La contra:** el contenedor global necesita `--privileged` (lo exige un motor de Docker dentro de un contenedor), que le da acceso amplio al kernel de la PC. Es un modo para no instalar nada, no un aislamiento más fuerte que `start.sh`.

## 3. `docker compose` directo

Sin análisis de seguridad, para quien ya sabe lo que hace:

```bash
docker compose up -d --build
docker compose logs -f              # logs en vivo
docker compose down                 # apagar
```

## 4. Terraform (infraestructura como código)

Levanta el mismo stack con el provider `kreuzwerker/docker`, pero con su **propio PostgreSQL local** en una red interna, sin tocar Supabase.

```bash
cd infra/terraform
cp variables.tfvars.example terraform.tfvars   # valores locales; nunca commitear este archivo
terraform init
terraform plan    -var-file="terraform.tfvars"
terraform apply   -var-file="terraform.tfvars"
terraform destroy -var-file="terraform.tfvars" # para desmontarlo
```

## Acceso desde otras PC de la red

El frontend se publica en el puerto 3000 de todas las interfaces. `start.sh` y `contenedor.sh` muestran al final la URL para la red (`http://<ip-de-la-pc>:3000`).

- **Windows:** el firewall bloquea por defecto las conexiones entrantes. La primera vez, acepta el aviso de Docker Desktop o crea una regla de entrada para el puerto **3000/TCP** (Firewall de Windows Defender → Configuración avanzada → Reglas de entrada → Nueva regla → Puerto → TCP → 3000). La IP de la PC se ve con `ipconfig` ("Dirección IPv4").
- **Para que sobreviva un reinicio:** todos los servicios tienen `restart: unless-stopped`. En Windows, activa en Docker Desktop "Start Docker Desktop when you log in"; el stack vuelve solo en cuanto arranca el motor.

## Windows como servidor central

El requisito común es [Docker Desktop](https://www.docker.com/products/docker-desktop/): los contenedores son Linux y corren igual en cualquier sistema.

- **Opción A — CMD, sin WSL2:** `scripts\start.bat` y `scripts\pipeline-local.bat` son el equivalente nativo de los `.sh`. Hace falta Docker Desktop, Node.js en el `PATH` (npm audit y las pruebas corren en Windows) y [Gpg4win](https://gpg4win.org/) si vas a descifrar `.env.gpg`; `start.bat` intenta instalar lo que falte con `winget`.
- **Opción B — WSL2:** con `wsl --install` y la integración de Docker Desktop con la distribución (Settings → Resources → WSL Integration), los `.sh` corren sin cambios. Clona el repo dentro del sistema de archivos de Linux (`~`), no en `/mnt/c/...`, que es mucho más lento.

## Datos de demostración

`db/init.sql` deja listo lo necesario para probar sin cargar nada a mano:

| Elemento | Valor |
|---|---|
| Administrador de arranque | usuario `admin`, credencial fija definida en `db/init.sql` |
| Padrón de demostración | cédulas `1000000001` a `1000000005`, en "Puesto Central" (Mesa 1 y 2) y "Puesto Norte" (Mesa 1); PIN definido en `db/init.sql` / `db/migrations/003_voter_access_codes.sql` |
| Plantillas | "Elección de ejemplo" (3 opciones) y "Elección Presidencial de Ejemplo" (3 candidatos numerados) |

> ⚠️ Son credenciales fijas y conocidas, solo para el primer uso: entra, ve a **Usuarios** y crea tu propio administrador antes de usar el sistema con datos reales (ver [decisiones y riesgos](decisiones-y-riesgos.md)).

## Recorrido por la interfaz

1. Entra a **http://localhost:3000** → "Administrador" → usuario `admin` con la credencial de arranque.
2. En **Usuarios**, crea tu propio administrador (contraseña de al menos 10 caracteres).
3. En **Plantillas**, usa "Elección Presidencial de Ejemplo" o crea una nueva con candidatos (número, nombre y foto).
4. En **Elecciones**, instancia una con una ventana corta (2–3 minutos) para ver el ciclo completo.
5. En una ventana de incógnito → "Votante" → cédula `1000000001` con su PIN de demostración → vota. Repite con `1000000003` (otra mesa) para tener votos en más de una mesa.
6. En **Elecciones** puedes pulsar "Detener" para cerrarla antes de tiempo.
7. En **Resultados**: "En vivo" mientras está activa; tras cerrarla, "✓ Certificado", el ganador y el desglose por mesa.
8. En **Escrutinio**, "Verificar cadena de escrutinio" confirma que ningún acta fue alterada.
9. En **Reportes**, arma un tablero con widgets: resultados, participación, proyección, momento de definición, integridad del acta, accesos sospechosos, etc. Se exporta a PDF.
10. En **Auditoría**, revisa todos los intentos de ingreso, exitosos y fallidos.

## Flujo por línea de comandos

Las APIs responden en `127.0.0.1` (o a través del frontend: `http://localhost:3000/auth/...`, `/voting/...`, etc.):

```bash
# Salud de cada servicio
curl http://127.0.0.1:3001/health   # auth
curl http://127.0.0.1:3002/health   # voting
curl http://127.0.0.1:3003/health   # analytics
curl http://127.0.0.1:3004/health   # scrutiny
docker compose logs -f scheduler-worker   # el worker no expone puerto

# Login de admin (reemplaza <password> por la credencial de arranque de db/init.sql)
curl -X POST http://127.0.0.1:3001/login/admin \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"<password>"}'

# Login de votante (cédula + PIN)
curl -X POST http://127.0.0.1:3001/login/voter \
  -H "Content-Type: application/json" -d '{"cedula":"1000000001","pin":"<pin>"}'

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

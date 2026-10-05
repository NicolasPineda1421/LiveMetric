# LiveMetric - Infraestructura como Codigo (Local-First)
#
# Este archivo aprovisiona, usando el provider "kreuzwerker/docker",
# exactamente la misma topologia que docker-compose.yml, pero de forma
# declarativa y versionable con Terraform. Util para el evaluador que
# quiera reproducir el entorno con `terraform apply` en lugar de compose.
#
# Ningun secreto esta hardcodeado: todas las variables sensibles se marcan
# `sensitive = true` y se deben inyectar via TF_VAR_* o un archivo
# terraform.tfvars (excluido en .gitignore), nunca en este archivo.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

provider "docker" {
  # Usa el daemon Docker local del evaluador (Local-First: sin credenciales
  # de nube, sin backends remotos).
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "postgres_db" {
  type    = string
  default = "livemetric"
}

variable "postgres_user" {
  type    = string
  default = "livemetric_admin"
}

variable "postgres_password" {
  type      = string
  sensitive = true
  # Sin default: se debe pasar via TF_VAR_postgres_password o *.tfvars local
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "jwt_expires_in" {
  type    = string
  default = "1h"
}

variable "voter_jwt_expires_in" {
  type    = string
  default = "10m"
}

# Horas que vale cada PIN de votante desde que se genera (1 a 2160).
variable "pin_vigencia_horas" {
  type    = number
  default = 24
}

variable "voter_id_salt" {
  type      = string
  sensitive = true
  # Salt privado, conocido SOLO por auth-service, para SHA-256(cedula+salt).
}

variable "voters_encryption_key" {
  type      = string
  sensitive = true
  # Clave AES-256 (32 bytes) en base64 para cifrar cedula/puesto/mesa de
  # "voters" en reposo. La usan auth-service y analytics-service
  # (services/*/src/voterCrypto.js), que fallan al arrancar si falta o no
  # tiene el largo correcto.
}

variable "internal_service_token" {
  type      = string
  sensitive = true
  # Secreto compartido entre scheduler-worker y scrutiny-service.
  # Nunca debe salir de la red interna "app_net".
}

variable "acta_signing_key" {
  type      = string
  sensitive = true
  # Clave PRIVADA Ed25519 (32 bytes en base64) con la que scrutiny-service
  # firma cada acta. Solo la recibe ese servicio. Se genera en pareja con
  # acta_public_key: node scripts/lib/generar-env.js (ver .env.example).
}

variable "acta_public_key" {
  type = string
  # Clave publica que corresponde a acta_signing_key: con ella
  # analytics-service verifica la firma de las actas.
}

variable "scheduler_cron" {
  type    = string
  default = "* * * * *"
}

variable "frontend_origin" {
  type    = string
  default = "http://localhost:3000"
}

# ---------------------------------------------------------------------------
# Redes
# ---------------------------------------------------------------------------

resource "docker_network" "db_net" {
  name     = "livemetric_db-net"
  internal = true # PostgreSQL no tiene ruta de salida ni acceso desde el host
}

resource "docker_network" "app_net" {
  name = "livemetric_app-net"
}

resource "docker_volume" "pgdata" {
  name = "livemetric_pgdata"
}

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------

resource "docker_image" "postgres" {
  name         = "postgres:16-alpine"
  keep_locally = true
}

resource "docker_container" "postgres" {
  name    = "livemetric-postgres"
  image   = docker_image.postgres.image_id
  restart = "unless-stopped"

  env = [
    "POSTGRES_DB=${var.postgres_db}",
    "POSTGRES_USER=${var.postgres_user}",
    "POSTGRES_PASSWORD=${var.postgres_password}",
  ]

  volumes {
    volume_name    = docker_volume.pgdata.name
    container_path = "/var/lib/postgresql/data"
  }

  # Montado como en docker-compose.yml, de solo lectura. No con "upload":
  # sobre un sistema de archivos de solo lectura, Docker no puede copiar nada
  # al contenedor.
  volumes {
    host_path      = abspath("${path.module}/../../db/init.sql")
    container_path = "/docker-entrypoint-initdb.d/init.sql"
    read_only      = true
  }

  # Igual que en docker-compose.yml: sistema de archivos de solo lectura
  # (salvo sus datos y los tmpfs) y sin poder ganar privilegios.
  read_only     = true
  tmpfs         = { "/tmp" = "", "/var/run/postgresql" = "" }
  security_opts = ["no-new-privileges:true"]

  networks_advanced {
    name = docker_network.db_net.name
  }

  # Sin bloque "ports": no se publica al host, igual que en docker-compose.
}

# ---------------------------------------------------------------------------
# Microservicio A - Auth
# ---------------------------------------------------------------------------

resource "docker_image" "auth" {
  name = "livemetric/auth-service:local"
  build {
    context = "${path.module}/../../services/auth"
  }
}

resource "docker_container" "auth" {
  name    = "livemetric-auth"
  image   = docker_image.auth.image_id
  restart = "unless-stopped"

  # Igual que en docker-compose.yml: sistema de archivos de solo lectura
  # (salvo /tmp) y sin poder ganar privilegios.
  read_only     = true
  tmpfs         = { "/tmp" = "" }
  security_opts = ["no-new-privileges:true"]

  env = [
    "NODE_ENV=production",
    "PORT=3001",
    "JWT_SECRET=${var.jwt_secret}",
    "JWT_EXPIRES_IN=${var.jwt_expires_in}",
    "VOTER_JWT_EXPIRES_IN=${var.voter_jwt_expires_in}",
    "PIN_VIGENCIA_HORAS=${var.pin_vigencia_horas}",
    "VOTER_ID_SALT=${var.voter_id_salt}",
    "VOTERS_ENCRYPTION_KEY=${var.voters_encryption_key}",
    "FRONTEND_ORIGIN=${var.frontend_origin}",
    "DB_HOST=livemetric-postgres",
    "DB_PORT=5432",
    "DB_NAME=${var.postgres_db}",
    "DB_USER=${var.postgres_user}",
    "DB_PASSWORD=${var.postgres_password}",
  ]

  ports {
    internal = 3001
    external = 3001
    ip       = "127.0.0.1"
  }

  networks_advanced { name = docker_network.db_net.name }
  # El alias "auth-service" es el mismo nombre de servicio que usa
  # docker-compose.yml (que Compose alia automaticamente en su red); el
  # nginx.conf del frontend tiene ese hostname fijo en sus proxy_pass, y
  # Terraform no crea ese alias por si solo (solo alia por el "name" del
  # contenedor), asi que hay que declararlo explicitamente aqui.
  networks_advanced {
    name    = docker_network.app_net.name
    aliases = ["auth-service"]
  }

  depends_on = [docker_container.postgres]
}

# ---------------------------------------------------------------------------
# Microservicio B - Voting
# ---------------------------------------------------------------------------

resource "docker_image" "voting" {
  name = "livemetric/voting-service:local"
  build {
    context = "${path.module}/../../services/voting"
  }
}

resource "docker_container" "voting" {
  name    = "livemetric-voting"
  image   = docker_image.voting.image_id
  restart = "unless-stopped"

  # Igual que en docker-compose.yml: sistema de archivos de solo lectura
  # (salvo /tmp) y sin poder ganar privilegios.
  read_only     = true
  tmpfs         = { "/tmp" = "" }
  security_opts = ["no-new-privileges:true"]

  env = [
    "NODE_ENV=production",
    "PORT=3002",
    "JWT_SECRET=${var.jwt_secret}",
    "FRONTEND_ORIGIN=${var.frontend_origin}",
    "DB_HOST=livemetric-postgres",
    "DB_PORT=5432",
    "DB_NAME=${var.postgres_db}",
    "DB_USER=${var.postgres_user}",
    "DB_PASSWORD=${var.postgres_password}",
  ]

  ports {
    internal = 3002
    external = 3002
    ip       = "127.0.0.1"
  }

  networks_advanced { name = docker_network.db_net.name }
  networks_advanced {
    name    = docker_network.app_net.name
    aliases = ["voting-service"]
  }

  depends_on = [docker_container.postgres]
}

# ---------------------------------------------------------------------------
# Microservicio C - Analytics
# ---------------------------------------------------------------------------

resource "docker_image" "analytics" {
  name = "livemetric/analytics-service:local"
  build {
    context = "${path.module}/../../services/analytics"
  }
}

resource "docker_container" "analytics" {
  name    = "livemetric-analytics"
  image   = docker_image.analytics.image_id
  restart = "unless-stopped"

  # Igual que en docker-compose.yml: sistema de archivos de solo lectura
  # (salvo /tmp) y sin poder ganar privilegios.
  read_only     = true
  tmpfs         = { "/tmp" = "" }
  security_opts = ["no-new-privileges:true"]

  env = [
    "NODE_ENV=production",
    "PORT=3003",
    "JWT_SECRET=${var.jwt_secret}",
    "VOTERS_ENCRYPTION_KEY=${var.voters_encryption_key}",
    "ACTA_PUBLIC_KEY=${var.acta_public_key}",
    "FRONTEND_ORIGIN=${var.frontend_origin}",
    "DB_HOST=livemetric-postgres",
    "DB_PORT=5432",
    "DB_NAME=${var.postgres_db}",
    "DB_USER=${var.postgres_user}",
    "DB_PASSWORD=${var.postgres_password}",
  ]

  ports {
    internal = 3003
    external = 3003
    ip       = "127.0.0.1"
  }

  networks_advanced { name = docker_network.db_net.name }
  networks_advanced {
    name    = docker_network.app_net.name
    aliases = ["analytics-service"]
  }

  depends_on = [docker_container.postgres, docker_container.auth]
}

# ---------------------------------------------------------------------------
# Microservicio D - Scrutiny (certificacion con cadena de hashes)
# ---------------------------------------------------------------------------

resource "docker_image" "scrutiny" {
  name = "livemetric/scrutiny-service:local"
  build {
    context = "${path.module}/../../services/scrutiny"
  }
}

resource "docker_container" "scrutiny" {
  name    = "livemetric-scrutiny"
  image   = docker_image.scrutiny.image_id
  restart = "unless-stopped"

  # Igual que en docker-compose.yml: sistema de archivos de solo lectura
  # (salvo /tmp) y sin poder ganar privilegios.
  read_only     = true
  tmpfs         = { "/tmp" = "" }
  security_opts = ["no-new-privileges:true"]

  env = [
    "NODE_ENV=production",
    "PORT=3004",
    "JWT_SECRET=${var.jwt_secret}",
    "INTERNAL_SERVICE_TOKEN=${var.internal_service_token}",
    "ACTA_SIGNING_KEY=${var.acta_signing_key}",
    "ACTA_PUBLIC_KEY=${var.acta_public_key}",
    "FRONTEND_ORIGIN=${var.frontend_origin}",
    "DB_HOST=livemetric-postgres",
    "DB_PORT=5432",
    "DB_NAME=${var.postgres_db}",
    "DB_USER=${var.postgres_user}",
    "DB_PASSWORD=${var.postgres_password}",
  ]

  ports {
    internal = 3004
    external = 3004
    ip       = "127.0.0.1"
  }

  networks_advanced { name = docker_network.db_net.name }
  networks_advanced {
    name    = docker_network.app_net.name
    aliases = ["scrutiny-service"]
  }

  depends_on = [docker_container.postgres]
}

# ---------------------------------------------------------------------------
# Worker - Scheduler (cron: abre/cierra elecciones y dispara certificacion)
# ---------------------------------------------------------------------------

resource "docker_image" "scheduler" {
  name = "livemetric/scheduler-worker:local"
  build {
    context = "${path.module}/../../services/scheduler"
  }
}

resource "docker_container" "scheduler" {
  name    = "livemetric-scheduler"
  image   = docker_image.scheduler.image_id
  restart = "unless-stopped"

  # Igual que en docker-compose.yml: sistema de archivos de solo lectura
  # (salvo /tmp) y sin poder ganar privilegios.
  read_only     = true
  tmpfs         = { "/tmp" = "" }
  security_opts = ["no-new-privileges:true"]

  env = [
    "NODE_ENV=production",
    "PORT=3005",
    "SCHEDULER_CRON=${var.scheduler_cron}",
    "SCRUTINY_INTERNAL_URL=http://livemetric-scrutiny:3004",
    "INTERNAL_SERVICE_TOKEN=${var.internal_service_token}",
    "DB_HOST=livemetric-postgres",
    "DB_PORT=5432",
    "DB_NAME=${var.postgres_db}",
    "DB_USER=${var.postgres_user}",
    "DB_PASSWORD=${var.postgres_password}",
  ]

  # Sin bloque "ports": el worker no se publica al host.

  networks_advanced { name = docker_network.db_net.name }
  networks_advanced { name = docker_network.app_net.name }

  depends_on = [docker_container.postgres, docker_container.scrutiny]
}

# ---------------------------------------------------------------------------
# Frontend - SPA en React servida por nginx
# ---------------------------------------------------------------------------

resource "docker_image" "frontend" {
  name = "livemetric/frontend:local"
  build {
    context = "${path.module}/../../services/frontend"
  }
}

resource "docker_container" "frontend" {
  name    = "livemetric-frontend"
  image   = docker_image.frontend.image_id
  restart = "unless-stopped"

  # Igual que en docker-compose.yml: sistema de archivos de solo lectura
  # (salvo /tmp) y sin poder ganar privilegios.
  read_only     = true
  tmpfs         = { "/tmp" = "" }
  security_opts = ["no-new-privileges:true"]

  # Rutas relativas: el navegador solo habla con el frontend, y nginx
  # reenvia a cada servicio por app_net (igual que en docker-compose.yml).
  # Asi la Content-Security-Policy puede limitar las conexiones a este origen.
  env = [
    "AUTH_URL=/auth",
    "VOTING_URL=/voting",
    "ANALYTICS_URL=/analytics",
    "SCRUTINY_URL=/scrutiny",
  ]

  ports {
    internal = 8080 # nginx corre sin root, ver services/frontend/Dockerfile
    external = 3000
    ip       = "127.0.0.1"
  }

  networks_advanced { name = docker_network.app_net.name }

  depends_on = [
    docker_container.auth,
    docker_container.voting,
    docker_container.analytics,
    docker_container.scrutiny,
  ]
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "auth_service_url" {
  value = "http://127.0.0.1:3001"
}

output "voting_service_url" {
  value = "http://127.0.0.1:3002"
}

output "analytics_service_url" {
  value = "http://127.0.0.1:3003"
}

output "scrutiny_service_url" {
  value = "http://127.0.0.1:3004"
}

output "frontend_url" {
  value = "http://127.0.0.1:3000"
}

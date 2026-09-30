#!/usr/bin/env bash
# =============================================================================
# LiveMetric — Despliegue orquestado en Docker Swarm
#
# Uso:  ./deploy.sh v1.3.2
#
# Requisitos previos:
#   - Docker Swarm inicializado:  docker swarm init
#   - Archivo .env en la raiz del repositorio (el mismo de docker compose)
#   - Variable DOCKERHUB_NAMESPACE definida en el .env o en el entorno
#   - Las imagenes de esa version publicadas en Docker Hub
# =============================================================================

set -euo pipefail

STACK_NAME="livemetric"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# -----------------------------------------------------------------------------
# 1) Version a desplegar
# -----------------------------------------------------------------------------
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "❌ Falta la version. Uso: ./deploy.sh v1.3.2"
  exit 1
fi

if ! echo "$VERSION" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "❌ Version invalida: '$VERSION'. Formato esperado: vX.Y.Z"
  exit 1
fi

# Las imagenes en Docker Hub llevan la version SIN la "v" inicial.
export LIVEMETRIC_VERSION="${VERSION#v}"

# -----------------------------------------------------------------------------
# 2) Swarm activo
# -----------------------------------------------------------------------------
if ! docker info 2>/dev/null | grep -q "Swarm: active"; then
  echo "❌ Docker Swarm no esta inicializado en este host."
  echo "   Ejecuta primero:  docker swarm init"
  exit 1
fi

# -----------------------------------------------------------------------------
# 3) Cargar el .env
#
# A diferencia de "docker compose", "docker stack deploy" NO lee el archivo
# .env automaticamente: hay que exportar las variables al entorno antes de
# invocarlo. Eso hace "set -a".
# -----------------------------------------------------------------------------
ENV_FILE="${REPO_ROOT}/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ No se encontro ${ENV_FILE}"
  echo "   Generalo con: node scripts/lib/generar-env.js (o corriendo ./scripts/start.sh una vez)."
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# -----------------------------------------------------------------------------
# 4) Validar variables obligatorias
# -----------------------------------------------------------------------------
REQUIRED=(DOCKERHUB_NAMESPACE JWT_SECRET VOTER_ID_SALT VOTERS_ENCRYPTION_KEY INTERNAL_SERVICE_TOKEN POSTGRES_PASSWORD ACTA_SIGNING_KEY ACTA_PUBLIC_KEY)
MISSING=()
for var in "${REQUIRED[@]}"; do
  if [ -z "${!var:-}" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌ Faltan variables obligatorias en el .env:"
  printf '   - %s\n' "${MISSING[@]}"
  exit 1
fi

# -----------------------------------------------------------------------------
# 5) Verificar que las imagenes existan antes de desplegar
#
# Fallar aqui es mucho mas barato que desplegar y quedarse con replicas
# reiniciandose en bucle porque la imagen no existe.
# -----------------------------------------------------------------------------
echo "🔎 Verificando imagenes ${DOCKERHUB_NAMESPACE}/livemetric-*:${LIVEMETRIC_VERSION}"
for s in auth voting analytics scrutiny scheduler frontend; do
  IMG="${DOCKERHUB_NAMESPACE}/livemetric-${s}:${LIVEMETRIC_VERSION}"
  if ! docker manifest inspect "$IMG" >/dev/null 2>&1; then
    echo "❌ No se encontro la imagen ${IMG} en el registro."
    echo "   ¿Ya corrio el workflow de release para ${VERSION}?"
    exit 1
  fi
  echo "   ✅ ${IMG}"
done

# -----------------------------------------------------------------------------
# 6) Desplegar
# -----------------------------------------------------------------------------
echo ""
echo "🚀 Desplegando el stack '${STACK_NAME}' version ${VERSION}"
docker stack deploy \
  --compose-file "${SCRIPT_DIR}/docker-stack.yml" \
  --with-registry-auth \
  --prune \
  "$STACK_NAME"

# -----------------------------------------------------------------------------
# 7) Migraciones
#
# Si el volumen de la base ya existia (un stack desplegado con una version
# anterior), init.sql no vuelve a correr y la base se queda con el esquema
# viejo: el codigo nuevo fallaria (por ejemplo, al firmar las actas). Se le
# aplican las migraciones de db/migrations/, que son idempotentes: en una
# base nueva no cambian nada. Es lo mismo que hace el servicio "migraciones"
# de docker-compose.yml, que Swarm no puede correr como tarea de una vez.
# -----------------------------------------------------------------------------
echo ""
echo "🗄️  Aplicando las migraciones de la base..."
PG_ID=""
for _ in $(seq 1 60); do
  PG_ID="$(docker ps -q -f "name=${STACK_NAME}_postgres" | head -n 1)"
  if [ -n "$PG_ID" ] && docker exec "$PG_ID" pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-livemetric}" > /dev/null 2>&1; then
    break
  fi
  PG_ID=""
  sleep 3
done
if [ -z "$PG_ID" ]; then
  echo "❌ La base no quedo lista a tiempo: no se pudieron aplicar las migraciones."
  echo "   Revisa: docker service logs ${STACK_NAME}_postgres"
  exit 1
fi
for MIGRACION in "${REPO_ROOT}"/db/migrations/*.sql; do
  docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$PG_ID" \
    psql -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-livemetric}" -d "${POSTGRES_DB:-livemetric}" < "$MIGRACION"
  echo "   ✅ $(basename "$MIGRACION")"
done

echo ""
echo "⏳ Esperando a que converjan las replicas..."
sleep 15
docker stack services "$STACK_NAME"

echo ""
echo "✅ Stack desplegado."
echo "   Aplicacion:  http://localhost:3000"
echo ""
echo "   Con la base nueva, crea el primer administrador (cuando auth-service este arriba):"
echo "   docker exec -it \$(docker ps -q -f name=${STACK_NAME}_auth-service | head -n 1) node src/scripts/crearAdmin.js --si-no-hay"
echo ""
echo "   Ver servicios:   docker stack services ${STACK_NAME}"
echo "   Ver replicas:    docker stack ps ${STACK_NAME}"
echo "   Ver logs:        docker service logs -f ${STACK_NAME}_auth-service"
echo "   Retirar:         docker stack rm ${STACK_NAME}"

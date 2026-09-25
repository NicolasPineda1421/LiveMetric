#!/usr/bin/env bash
# =============================================================================
# LiveMetric — Despliegue orquestado en Docker Swarm
#
# Uso:  ./deploy.sh v1.0.0
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
  echo "❌ Falta la version. Uso: ./deploy.sh v1.0.0"
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
  echo "   Copia .env.example a .env y completa los valores."
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# -----------------------------------------------------------------------------
# 4) Validar variables obligatorias
# -----------------------------------------------------------------------------
REQUIRED=(DOCKERHUB_NAMESPACE JWT_SECRET VOTER_ID_SALT VOTERS_ENCRYPTION_KEY INTERNAL_SERVICE_TOKEN SUPABASE_DB_HOST SUPABASE_DB_PASSWORD)
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

echo ""
echo "⏳ Esperando a que converjan las replicas..."
sleep 15
docker stack services "$STACK_NAME"

echo ""
echo "✅ Stack desplegado."
echo "   Aplicacion:  http://localhost:3000"
echo ""
echo "   Ver servicios:   docker stack services ${STACK_NAME}"
echo "   Ver replicas:    docker stack ps ${STACK_NAME}"
echo "   Ver logs:        docker service logs -f ${STACK_NAME}_auth-service"
echo "   Retirar:         docker stack rm ${STACK_NAME}"

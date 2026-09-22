#!/usr/bin/env bash
# LiveMetric - Punto de entrada unico: prepara el .env, corre el mismo
# analisis de seguridad que el pipeline de CI (Gitleaks, Semgrep, SCA,
# Trivy, pruebas unitarias) mostrando el detalle en la terminal, y SOLO si
# todo pasa levanta el stack completo y muestra el link donde queda
# desplegado.
#
# Si el analisis encuentra algo en rojo, el script se detiene ahi: no
# levanta contenedores con codigo que no paso sus propios controles.
#
# Requisitos: Docker, y (si todavia no existe tu .env) gpg + .env.gpg, o
# .env.example completado a mano (ver README, seccion 3).
#
# Uso:
#   ./scripts/start.sh

set -uo pipefail

cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════════════════"
echo " LiveMetric - arranque con verificacion de seguridad"
echo "════════════════════════════════════════════════════════════"
echo ""

# 1. Preparar el .env -------------------------------------------------------
if [ ! -f .env ]; then
  if [ -f .env.gpg ]; then
    echo "No hay .env, pero si .env.gpg. Descifrando (te pedira la passphrase)..."
    if ! gpg --output .env --decrypt .env.gpg; then
      echo "Error: no se pudo descifrar .env.gpg (¿passphrase incorrecta?)." >&2
      exit 1
    fi
  else
    echo "Error: no hay .env ni .env.gpg en $(pwd)." >&2
    echo "Copia .env.example a .env y completa los valores (ver README, seccion 3)," >&2
    echo "o pedi el .env.gpg + la passphrase a quien te comparta el proyecto." >&2
    exit 1
  fi
else
  echo "✓ .env ya existe, se usa tal cual."
fi
echo ""

# 2. Analisis de seguridad completo (el mismo que corre en CI) --------------
echo "════════════════════════════════════════════════════════════"
echo " Analisis de seguridad (Gitleaks, Semgrep, SCA, Trivy, pruebas)"
echo " Esto puede tardar varios minutos - construye las 6 imagenes reales."
echo "════════════════════════════════════════════════════════════"
echo ""
if ! ./scripts/pipeline-local.sh; then
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "❌ El analisis encontro problemas. NO se levantan los contenedores."
  echo "   Revisa el detalle de arriba (cada linea en rojo indica donde"
  echo "   esta el log completo) antes de volver a intentarlo."
  echo "════════════════════════════════════════════════════════════"
  exit 1
fi
echo ""

# 3. Levantar el stack --------------------------------------------------------
echo "════════════════════════════════════════════════════════════"
echo " Todo en verde. Levantando el stack (docker compose up --build)..."
echo "════════════════════════════════════════════════════════════"
docker compose up -d --build

echo ""
echo "Esperando a que el frontend responda..."
FRONTEND_UP=false
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000 > /dev/null 2>&1; then
    FRONTEND_UP=true
    break
  fi
  sleep 2
done

echo ""
echo "════════════════════════════════════════════════════════════"
echo " Contenedores (docker ps)"
echo "════════════════════════════════════════════════════════════"
docker ps --filter "name=livemetric-" \
  --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
if $FRONTEND_UP; then
  echo "════════════════════════════════════════════════════════════"
  echo "✅ LiveMetric esta arriba."
  echo ""
  echo "   Frontend:  http://localhost:3000"
  echo ""
  echo "   Logs en vivo:  docker compose logs -f"
  echo "════════════════════════════════════════════════════════════"
else
  echo "⚠️  El stack se levanto pero el frontend todavia no respondio a"
  echo "   tiempo. Revisa el estado con: docker ps"
  echo "   y los logs con:               docker compose logs -f"
fi

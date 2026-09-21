#!/usr/bin/env bash
# LiveMetric - Descifra el .env entregado (.env.gpg) y levanta el stack
# completo en un solo paso, para que quien reciba el repo no tenga que
# recordar la sintaxis de gpg ni escribirla a mano.
#
# La passphrase la sigue pidiendo gpg de forma interactiva (prompt oculto,
# nunca queda en el comando ni en el historial de la shell) — este script
# no la conoce ni la almacena en ningún momento.
#
# Requisitos: gpg y docker compose instalados; .env.gpg en la raíz del repo
# (te lo entrega quien te compartió el proyecto, por un canal separado de
# la passphrase).
#
# Uso:
#   ./scripts/deploy.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env.gpg ]; then
  echo "Error: no se encontró .env.gpg en $(pwd)." >&2
  echo "Pídeselo a quien te compartió el proyecto (junto con la passphrase, por otro canal)." >&2
  exit 1
fi

if [ -f .env ]; then
  read -r -p "Ya existe un .env en este directorio. ¿Sobrescribirlo? [s/N] " respuesta
  case "$respuesta" in
    [sS]|[sS][iI])
      ;;
    *)
      echo "Cancelado: se conserva el .env actual."
      exit 0
      ;;
  esac
fi

echo "Descifrando .env.gpg (te pedirá la passphrase)..."
gpg --output .env --decrypt .env.gpg

echo "Listo. Levantando el stack con docker compose..."
docker compose up -d --build

echo ""
echo "Stack levantado. Frontend disponible en http://localhost:3000"

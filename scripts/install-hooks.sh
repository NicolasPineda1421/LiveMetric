#!/usr/bin/env bash
# LiveMetric - Instala los git hooks locales del repo (hoy: pre-commit con
# Gitleaks). Cada desarrollador lo corre UNA vez después de clonar; los
# hooks de Git no se versionan directamente en .git/hooks, así que se
# guardan en scripts/git-hooks/ y este script los copia al lugar donde Git
# realmente los busca.
#
# Uso:
#   ./scripts/install-hooks.sh

set -euo pipefail

cd "$(dirname "$0")/.."

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="${REPO_ROOT}/scripts/git-hooks"
HOOKS_DEST="${REPO_ROOT}/.git/hooks"

for hook in "${HOOKS_SRC}"/*; do
  name="$(basename "$hook")"
  cp "$hook" "${HOOKS_DEST}/${name}"
  chmod +x "${HOOKS_DEST}/${name}"
  echo "Instalado: .git/hooks/${name}"
done

echo ""
echo "Listo. Estos hooks corren solo en tu copia local del repo."

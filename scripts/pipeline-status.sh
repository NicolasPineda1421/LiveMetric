#!/usr/bin/env bash
# LiveMetric - Muestra en la terminal el mismo resumen de seguridad que el
# pipeline arma en GitHub Actions (job "Security Gate (resumen)"), para no
# tener que abrir el navegador ni recargar la pestaña de Actions cada vez.
#
# No corre ningún escaneo localmente: solo consulta, vía la API de GitHub,
# el resultado real de la corrida más reciente (o la que le indiques) y
# arma el mismo checklist agrupando los jobs por categoría, tal como lo
# hace el paso "Resumen del Runner DevSecOps" del workflow.
#
# Requisitos: GitHub CLI (gh) autenticado, y jq.
#
# Uso:
#   ./scripts/pipeline-status.sh              # última corrida en tu rama actual
#   ./scripts/pipeline-status.sh main          # última corrida en una rama
#   ./scripts/pipeline-status.sh 35660170892   # una corrida específica por ID

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gh &> /dev/null; then
  echo "Error: este script necesita el GitHub CLI (gh) instalado y autenticado." >&2
  echo "Instalación: https://cli.github.com/" >&2
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "Error: este script necesita 'jq' instalado (sudo apt install jq)." >&2
  exit 1
fi

ARG="${1:-}"
if [[ "$ARG" =~ ^[0-9]+$ ]]; then
  RUN_ID="$ARG"
else
  BRANCH="${ARG:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  echo "Buscando la corrida más reciente del pipeline en la rama '$BRANCH'..."
  RUN_ID=$(gh run list --workflow devsecops.yml --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  if [ -z "$RUN_ID" ]; then
    echo "No se encontró ninguna corrida del pipeline DevSecOps en la rama '$BRANCH'." >&2
    exit 1
  fi
fi

RUN_JSON=$(gh run view "$RUN_ID" --json status,conclusion,headSha,headBranch,url,jobs)
STATUS=$(echo "$RUN_JSON" | jq -r '.status')
SHA=$(echo "$RUN_JSON" | jq -r '.headSha' | cut -c1-7)
RUN_BRANCH=$(echo "$RUN_JSON" | jq -r '.headBranch')
URL=$(echo "$RUN_JSON" | jq -r '.url')

if [ "$STATUS" != "completed" ]; then
  echo "La corrida $RUN_ID ($SHA) todavía está en progreso (estado: $STATUS)."
  echo "Seguila en vivo con: gh run watch $RUN_ID"
  exit 0
fi

# Agrega el resultado de un grupo de jobs por prefijo de nombre (los jobs en
# matriz, como "npm audit - auth" / "npm audit - voting" / etc., cuentan
# como una sola categoría): "success" solo si TODOS pasaron.
group_result() {
  local prefix="$1"
  echo "$RUN_JSON" | jq -r --arg p "$prefix" '
    [.jobs[] | select(.name | startswith($p))] as $js
    | if ($js | length) == 0 then "missing"
      elif ($js | all(.conclusion == "success")) then "success"
      else "failure" end
  '
}

check() {
  local result="$1" label="$2"
  case "$result" in
    success) echo "✅ $label" ;;
    missing) echo "⚪ $label (no corrió en esta corrida)" ;;
    *)       echo "❌ $label (resultado real: $result)" ;;
  esac
}

echo ""
echo "🚀 Commit $SHA en rama $RUN_BRANCH. Resumen del Runner DevSecOps:"
echo ""
check "$(group_result 'Gitleaks')"               "🔑 Secret Scanning (Gitleaks) — sin secretos expuestos"
check "$(group_result 'SAST - Semgrep')"         "🔍 SAST (Semgrep: OWASP Top 10 / Express / JWT)"
check "$(group_result 'npm audit')"              "📦 SCA (npm audit) — sin CVEs de severidad alta o mayor"
check "$(group_result 'SCA - Trivy fs')"         "📦 SCA (Trivy fs, sobre package.json) — sin CVEs de severidad alta o mayor"
check "$(group_result 'Trivy - ')"               "🐳 Container Scan (Trivy, imágenes reales) — sin CVEs critical/high sin excepción"
check "$(group_result 'Checkov')"                "☁️ IaC Guard (Checkov sobre Terraform)"
check "$(group_result 'Pruebas unitarias')"      "🧪 Pruebas unitarias (Jest + Supertest, 5 microservicios)"
check "$(group_result 'Despliegue automatizado')" "🏗️ Despliegue automatizado (Terraform apply + smoke test + destroy)"
check "$(group_result 'Despliegue de staging')"  "🕷️ DAST (OWASP ZAP Baseline Scan)"
echo ""

OVERALL=$(echo "$RUN_JSON" | jq -r '.conclusion')
if [ "$OVERALL" = "success" ]; then
  echo "✅ QUALITY GATE SUPERADO. Todos los controles de seguridad pasaron correctamente."
else
  echo "❌ QUALITY GATE NO SUPERADO (resultado real: $OVERALL)."
fi
echo ""
echo "Corrida completa: $URL"

#!/usr/bin/env bash
# LiveMetric - Aplica la protección de rama "main" vía GitHub CLI.
#
# GitHub no permite declarar branch protection dentro del propio repositorio
# (no es un archivo versionable como docker-compose.yml o main.tf), así que
# este script documenta y automatiza la configuración recomendada para que
# sea reproducible y auditable, en vez de dejarla como un paso manual "de memoria".
#
# Requisitos: GitHub CLI autenticado (`gh auth login`) con permisos de admin
# sobre el repositorio.
#
# Uso:
#   ./scripts/setup-branch-protection.sh <owner>/<repo>

set -euo pipefail

REPO="${1:?Uso: $0 <owner>/<repo>}"

echo "Aplicando reglas de protección de rama en ${REPO}:main ..."

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/main/protection" \
  -f "required_status_checks[strict]=true" \
  -f "required_status_checks[contexts][]=Security Gate (resumen)" \
  -f "required_pull_request_reviews[required_approving_review_count]=1" \
  -f "required_pull_request_reviews[require_code_owner_reviews]=true" \
  -f "enforce_admins=true" \
  -f "required_linear_history=true" \
  -f "allow_force_pushes=false" \
  -f "allow_deletions=false"

echo "Listo. 'main' ahora exige:"
echo "  - Pull Request obligatorio (sin push directo)"
echo "  - Aprobación de al menos 1 CODEOWNER"
echo "  - Check requerido: 'Security Gate (resumen)' en verde"
echo "  - Historial lineal (sin merge commits de fusión libre)"
echo "  - Sin force-push ni borrado de la rama"

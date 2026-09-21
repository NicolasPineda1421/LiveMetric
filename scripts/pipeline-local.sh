#!/usr/bin/env bash
# LiveMetric - Corre localmente, con Docker, los mismos controles de
# seguridad del pipeline de GitHub Actions: construye las 6 imagenes reales
# con "docker build" (igual que hace scripts/deploy.sh para levantar el
# stack) y las escanea con las mismas herramientas y comandos exactos que
# usa .github/workflows/devsecops.yml - para detectar problemas ANTES de
# hacer push, sin esperar a que corra en GitHub Actions.
#
# A diferencia de scripts/pipeline-status.sh (que solo CONSULTA el
# resultado de una corrida ya hecha en GitHub), este script EJECUTA los
# escaneos de verdad contra tu copia local del repo.
#
# No incluye el despliegue con Terraform ni el DAST con OWASP ZAP: esos
# pasos levantan el stack completo y tardan varios minutos mas; se siguen
# verificando en GitHub Actions (o a mano con "cd infra/terraform &&
# terraform apply", ver README).
#
# Requisitos: Docker, y (para las pruebas unitarias) un .env real en la
# raiz del repo con las credenciales de Supabase.
#
# Uso:
#   ./scripts/pipeline-local.sh

set -uo pipefail  # sin -e a proposito: un control que falla no debe abortar el resto

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

SERVICES=(auth voting analytics scrutiny scheduler frontend)
BACKEND_SERVICES=(auth voting analytics scrutiny scheduler)
LOG_DIR="$(mktemp -d /tmp/livemetric-pipeline-local.XXXXXX)"

declare -A RESULT
pass() { echo "   ✓ $1"; }
fail() { echo "   ✗ $1"; }

if ! command -v docker &> /dev/null; then
  echo "Error: este script necesita Docker instalado y corriendo." >&2
  exit 1
fi

echo "🚀 Corriendo el pipeline DevSecOps localmente (logs en $LOG_DIR)"
echo ""

# 1. Gitleaks -----------------------------------------------------------
echo "🔑 Secret Scanning (Gitleaks)..."
if docker run --rm -v "$REPO_ROOT:/repo" zricethezav/gitleaks:latest \
    detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner \
    > "$LOG_DIR/gitleaks.log" 2>&1; then
  RESULT[gitleaks]=success
  pass "sin secretos expuestos"
else
  RESULT[gitleaks]=failure
  fail "hallazgos encontrados (ver $LOG_DIR/gitleaks.log)"
fi
echo ""

# 2. Semgrep (SAST) -------------------------------------------------------
# Igual que en CI: Semgrep termina en 0 sin importar cuantos hallazgos
# reporte (no se le pasa --error) - el pipeline lo usa para SUBIR resultados
# a GitHub Security, no como gate por cantidad de hallazgos. Lo que este
# paso valida localmente es que el escaneo corra sin romperse y genere el
# SARIF, igual que hace el paso "Verificar SARIF generado" del workflow.
echo "🔍 SAST (Semgrep: OWASP Top 10 / Express / JWT)..."
if docker run --rm -v "$REPO_ROOT:/src" -w /src semgrep/semgrep \
    semgrep scan --config=p/owasp-top-ten --config=p/expressjs --config=p/nodejsscan --config=p/jwt \
    --sarif --output=/src/semgrep-local.sarif . > "$LOG_DIR/semgrep.log" 2>&1 \
    && [ -s "$REPO_ROOT/semgrep-local.sarif" ]; then
  RESULT[semgrep]=success
  pass "escaneo completado, SARIF generado (ver $LOG_DIR/semgrep.log para los hallazgos)"
else
  RESULT[semgrep]=failure
  fail "el escaneo no corrio correctamente (ver $LOG_DIR/semgrep.log)"
fi
rm -f "$REPO_ROOT/semgrep-local.sarif"
echo ""

# 3-4. npm audit + Trivy fs (SCA) por servicio -----------------------------
echo "📦 SCA (npm audit + Trivy fs) por servicio..."
NPM_AUDIT_OK=true
TRIVY_FS_OK=true
for svc in "${SERVICES[@]}"; do
  (cd "services/$svc" && npm install --package-lock-only --silent) \
    > "$LOG_DIR/npm-install-$svc.log" 2>&1

  if (cd "services/$svc" && npm audit --omit=dev --audit-level=high) \
      > "$LOG_DIR/npm-audit-$svc.log" 2>&1; then
    pass "npm audit - $svc"
  else
    fail "npm audit - $svc (ver $LOG_DIR/npm-audit-$svc.log)"
    NPM_AUDIT_OK=false
  fi

  if docker run --rm -v "$REPO_ROOT:/repo" -w /repo aquasec/trivy:0.70.0 \
      fs "services/$svc" --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed \
      --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check \
      > "$LOG_DIR/trivy-fs-$svc.log" 2>&1; then
    pass "Trivy fs - $svc"
  else
    fail "Trivy fs - $svc (ver $LOG_DIR/trivy-fs-$svc.log)"
    TRIVY_FS_OK=false
  fi
done
$NPM_AUDIT_OK && RESULT[npm_audit]=success || RESULT[npm_audit]=failure
$TRIVY_FS_OK && RESULT[trivy_fs]=success || RESULT[trivy_fs]=failure
echo ""

# 5. docker build + Trivy image (Container Scan) --------------------------
echo "🐳 Construyendo las 6 imagenes (docker build) y escaneandolas con Trivy..."
echo "   Esto puede tardar varios minutos, igual que en GitHub Actions."
CONTAINER_OK=true
for svc in "${SERVICES[@]}"; do
  if docker build -t "livemetric-$svc-localcheck" "services/$svc" \
      > "$LOG_DIR/docker-build-$svc.log" 2>&1; then
    if docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$REPO_ROOT:/repo" \
        aquasec/trivy:0.70.0 image "livemetric-$svc-localcheck" --severity CRITICAL,HIGH \
        --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore \
        --skip-version-check > "$LOG_DIR/trivy-image-$svc.log" 2>&1; then
      pass "docker build + Trivy image - $svc"
    else
      fail "Trivy image - $svc (ver $LOG_DIR/trivy-image-$svc.log)"
      CONTAINER_OK=false
    fi
  else
    fail "docker build - $svc (ver $LOG_DIR/docker-build-$svc.log)"
    CONTAINER_OK=false
  fi
  docker rmi "livemetric-$svc-localcheck" > /dev/null 2>&1
done
$CONTAINER_OK && RESULT[container]=success || RESULT[container]=failure
echo ""

# 6. Pruebas unitarias ------------------------------------------------------
if [ -f .env ]; then
  echo "🧪 Pruebas unitarias (Jest + Supertest, usa tu .env real)..."
  UNIT_OK=true
  for svc in "${BACKEND_SERVICES[@]}"; do
    if (cd "services/$svc" && npm install --silent && npm test) \
        > "$LOG_DIR/test-$svc.log" 2>&1; then
      pass "pruebas - $svc"
    else
      fail "pruebas - $svc (ver $LOG_DIR/test-$svc.log)"
      UNIT_OK=false
    fi
  done
  $UNIT_OK && RESULT[tests]=success || RESULT[tests]=failure
else
  echo "🧪 Pruebas unitarias: OMITIDAS (no hay .env en la raiz del repo)."
  RESULT[tests]=missing
fi
echo ""

echo "ℹ️  No corren aqui: Checkov (el CLI en Docker no detecta recursos de"
echo "   forma confiable en este entorno; se verifica en CI via la GitHub"
echo "   Action), el despliegue con Terraform y el DAST con OWASP ZAP"
echo "   (requieren levantar el stack completo). Esos tres se validan en"
echo "   GitHub Actions."
echo ""

# Resumen final -----------------------------------------------------------
check() {
  case "$1" in
    success) echo "✅ $2" ;;
    missing) echo "⚪ $2 (no se corrio)" ;;
    *)       echo "❌ $2" ;;
  esac
}

echo "Resumen del Runner DevSecOps (local):"
echo ""
check "${RESULT[gitleaks]}"  "🔑 Secret Scanning (Gitleaks) — sin secretos expuestos"
check "${RESULT[semgrep]}"   "🔍 SAST (Semgrep: OWASP Top 10 / Express / JWT)"
check "${RESULT[npm_audit]}" "📦 SCA (npm audit) — sin CVEs de severidad alta o mayor"
check "${RESULT[trivy_fs]}"  "📦 SCA (Trivy fs, sobre package.json) — sin CVEs de severidad alta o mayor"
check "${RESULT[container]}" "🐳 Container Scan (docker build + Trivy, imagenes reales)"
check "${RESULT[tests]}"     "🧪 Pruebas unitarias (Jest + Supertest)"
echo ""

if [[ "${RESULT[gitleaks]:-}" == "success" && "${RESULT[semgrep]:-}" == "success" && \
      "${RESULT[npm_audit]:-}" == "success" && "${RESULT[trivy_fs]:-}" == "success" && \
      "${RESULT[container]:-}" == "success" && "${RESULT[tests]:-}" != "failure" ]]; then
  echo "✅ Todo en verde localmente. Es seguro hacer push."
  exit 0
else
  echo "❌ Hay controles en rojo. Revisa los logs en $LOG_DIR antes de hacer push."
  exit 1
fi

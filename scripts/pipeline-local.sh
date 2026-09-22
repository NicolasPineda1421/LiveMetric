#!/usr/bin/env bash
# LiveMetric - Corre localmente, con Docker, los mismos controles de
# seguridad del pipeline de GitHub Actions: construye las 6 imagenes reales
# con "docker build" (igual que hace scripts/deploy.sh para levantar el
# stack) y las escanea con las mismas herramientas y comandos exactos que
# usa .github/workflows/devsecops.yml - para detectar problemas ANTES de
# hacer push, sin esperar a que corra en GitHub Actions.
#
# A diferencia de un simple check/x, cada paso muestra en vivo la salida
# real de la herramienta (no solo el resultado final) para poder leerla e
# interpretarla mientras corre - la misma idea que expandir un paso en un
# log de GitHub Actions. Ademas de verse en pantalla, cada salida queda
# guardada en un archivo por si queres volver a revisarla despues.
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

section() {
  echo ""
  echo "── $1 ────────────────────────────────────────────────"
}

result_line() {
  if [ "$2" = "success" ]; then
    echo "   ✓ $1"
  else
    echo "   ✗ $1"
  fi
}

if ! command -v docker &> /dev/null; then
  echo "Error: este script necesita Docker instalado y corriendo." >&2
  exit 1
fi

echo "🚀 Corriendo el pipeline DevSecOps localmente (copia de cada log en $LOG_DIR)"

# 1. Gitleaks -----------------------------------------------------------
section "🔑 Secret Scanning (Gitleaks)"
if docker run --rm -v "$REPO_ROOT:/repo" zricethezav/gitleaks:latest \
    detect --source /repo --config /repo/.gitleaks.toml --redact --verbose --no-banner \
    2>&1 | tee "$LOG_DIR/gitleaks.log"; then
  RESULT[gitleaks]=success
else
  RESULT[gitleaks]=failure
fi
result_line "Secret Scanning (Gitleaks)" "${RESULT[gitleaks]}"

# 2. Semgrep (SAST) -------------------------------------------------------
# Igual que en CI: Semgrep termina en 0 sin importar cuantos hallazgos
# reporte (no se le pasa --error) - el pipeline lo usa para SUBIR resultados
# a GitHub Security, no como gate por cantidad de hallazgos. Este paso
# imprime cada hallazgo (severidad, archivo, linea, por que importa) igual
# que lo veriamos en la terminal si corrieramos semgrep a mano; el gate
# real es que el escaneo corra sin romperse y genere el SARIF.
section "🔍 SAST (Semgrep: OWASP Top 10 / Express / JWT)"
if docker run --rm -v "$REPO_ROOT:/src" -w /src semgrep/semgrep \
    semgrep scan --config=p/owasp-top-ten --config=p/expressjs --config=p/nodejsscan --config=p/jwt \
    --sarif --output=/src/semgrep-local.sarif . 2>&1 | tee "$LOG_DIR/semgrep.log" \
    && [ -s "$REPO_ROOT/semgrep-local.sarif" ]; then
  RESULT[semgrep]=success
else
  RESULT[semgrep]=failure
fi
rm -f "$REPO_ROOT/semgrep-local.sarif"
result_line "SAST (Semgrep)" "${RESULT[semgrep]}"

# 3-4. npm audit + Trivy fs (SCA) por servicio -----------------------------
NPM_AUDIT_OK=true
TRIVY_FS_OK=true
for svc in "${SERVICES[@]}"; do
  (cd "services/$svc" && npm install --package-lock-only --silent) \
    > "$LOG_DIR/npm-install-$svc.log" 2>&1

  section "📦 npm audit - $svc"
  if (cd "services/$svc" && npm audit --omit=dev --audit-level=high) \
      2>&1 | tee "$LOG_DIR/npm-audit-$svc.log"; then
    result_line "npm audit - $svc" success
  else
    result_line "npm audit - $svc" failure
    NPM_AUDIT_OK=false
  fi

  section "📦 Trivy fs (SCA) - $svc"
  if docker run --rm -v "$REPO_ROOT:/repo" -w /repo aquasec/trivy:0.70.0 \
      fs "services/$svc" --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed \
      --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress \
      2>&1 | tee "$LOG_DIR/trivy-fs-$svc.log"; then
    result_line "Trivy fs - $svc" success
  else
    result_line "Trivy fs - $svc" failure
    TRIVY_FS_OK=false
  fi
done
$NPM_AUDIT_OK && RESULT[npm_audit]=success || RESULT[npm_audit]=failure
$TRIVY_FS_OK && RESULT[trivy_fs]=success || RESULT[trivy_fs]=failure

# 5. docker build + Trivy image (Container Scan) --------------------------
CONTAINER_OK=true
for svc in "${SERVICES[@]}"; do
  section "🐳 docker build - $svc"
  if docker build -t "livemetric-$svc-localcheck" "services/$svc" \
      2>&1 | tee "$LOG_DIR/docker-build-$svc.log"; then
    result_line "docker build - $svc" success

    section "🐳 Trivy image (Container Scan) - $svc"
    if docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$REPO_ROOT:/repo" \
        aquasec/trivy:0.70.0 image "livemetric-$svc-localcheck" --severity CRITICAL,HIGH \
        --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore \
        --skip-version-check --no-progress 2>&1 | tee "$LOG_DIR/trivy-image-$svc.log"; then
      result_line "Trivy image - $svc" success
    else
      result_line "Trivy image - $svc" failure
      CONTAINER_OK=false
    fi
  else
    result_line "docker build - $svc" failure
    CONTAINER_OK=false
  fi
  docker rmi "livemetric-$svc-localcheck" > /dev/null 2>&1
done
$CONTAINER_OK && RESULT[container]=success || RESULT[container]=failure

# 6. Pruebas unitarias ------------------------------------------------------
if [ -f .env ]; then
  UNIT_OK=true
  for svc in "${BACKEND_SERVICES[@]}"; do
    (cd "services/$svc" && npm install --silent) > "$LOG_DIR/npm-install-test-$svc.log" 2>&1

    section "🧪 Pruebas unitarias - $svc"
    if (cd "services/$svc" && npm test) 2>&1 | tee "$LOG_DIR/test-$svc.log"; then
      result_line "pruebas - $svc" success
    else
      result_line "pruebas - $svc" failure
      UNIT_OK=false
    fi
  done
  $UNIT_OK && RESULT[tests]=success || RESULT[tests]=failure
else
  section "🧪 Pruebas unitarias"
  echo "   OMITIDAS: no hay .env en la raiz del repo."
  RESULT[tests]=missing
fi

section "ℹ️  Fuera de alcance local"
echo "   Checkov (el CLI en Docker no detecta recursos de forma confiable en"
echo "   este entorno; se verifica en CI via la GitHub Action), el despliegue"
echo "   con Terraform y el DAST con OWASP ZAP (requieren levantar el stack"
echo "   completo). Esos tres se validan solo en GitHub Actions."

# Resumen final -----------------------------------------------------------
check() {
  case "$1" in
    success) echo "✅ $2" ;;
    missing) echo "⚪ $2 (no se corrio)" ;;
    *)       echo "❌ $2" ;;
  esac
}

section "Resumen del Runner DevSecOps (local)"
echo ""
check "${RESULT[gitleaks]}"  "🔑 Secret Scanning (Gitleaks) — sin secretos expuestos"
check "${RESULT[semgrep]}"   "🔍 SAST (Semgrep: OWASP Top 10 / Express / JWT)"
check "${RESULT[npm_audit]}" "📦 SCA (npm audit) — sin CVEs de severidad alta o mayor"
check "${RESULT[trivy_fs]}"  "📦 SCA (Trivy fs, sobre package.json) — sin CVEs de severidad alta o mayor"
check "${RESULT[container]}" "🐳 Container Scan (docker build + Trivy, imagenes reales)"
check "${RESULT[tests]}"     "🧪 Pruebas unitarias (Jest + Supertest)"
echo ""
echo "Logs completos guardados en: $LOG_DIR"
echo ""

if [[ "${RESULT[gitleaks]:-}" == "success" && "${RESULT[semgrep]:-}" == "success" && \
      "${RESULT[npm_audit]:-}" == "success" && "${RESULT[trivy_fs]:-}" == "success" && \
      "${RESULT[container]:-}" == "success" && "${RESULT[tests]:-}" != "failure" ]]; then
  echo "✅ Todo en verde localmente. Es seguro hacer push."
  exit 0
else
  echo "❌ Hay controles en rojo. Revisa el detalle de arriba (o los logs en $LOG_DIR) antes de hacer push."
  exit 1
fi

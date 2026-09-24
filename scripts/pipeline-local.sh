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

# Colores ANSI: azul para procesos en curso, verde para lo que aprueba,
# rojo para lo que falla. Si la salida no va a una terminal (por ejemplo,
# redirigida a un archivo) se dejan vacios para no ensuciar el log con
# codigos de escape.
if [ -t 1 ]; then
  BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
  BLUE=''; GREEN=''; RED=''; BOLD=''; NC=''
fi

section() {
  printf '\n%b── %s ────────────────────────────────────────────────%b\n' "${BLUE}${BOLD}" "$1" "$NC"
}

result_line() {
  if [ "$2" = "success" ]; then
    printf '   %b✓ %s%b\n' "$GREEN" "$1" "$NC"
  else
    printf '   %b✗ %s%b\n' "$RED" "$1" "$NC"
  fi
}

if ! command -v docker &> /dev/null; then
  echo "Error: este script necesita Docker instalado y corriendo." >&2
  exit 1
fi

# DOCKER_MOUNT_ROOT es la ruta a usar como origen en los "-v X:/repo" que
# le pasamos a "docker run" para gitleaks/semgrep/trivy. Normalmente es
# igual a REPO_ROOT. Pero si este script corre DENTRO de un contenedor que
# solo comparte el socket de Docker con el host (Docker-fuera-de-Docker,
# sin un demonio realmente anidado - el patron tipico para probar esto en
# un contenedor "limpio"), cualquier "-v" que pasemos lo resuelve el
# demonio del HOST, no este contenedor: "REPO_ROOT" (la vista de ESTE
# contenedor) ya no sirve como origen, hace falta la ruta real del host.
# Se detecta consultando los propios bind mounts de este mismo contenedor
# a traves de ese mismo socket compartido, y traduciendo el prefijo. Si la
# deteccion automatica no alcanza, "DOCKER_MOUNT_ROOT" se puede fijar a
# mano antes de correr el script (export DOCKER_MOUNT_ROOT=/ruta/del/host).
DOCKER_MOUNT_ROOT="${DOCKER_MOUNT_ROOT:-$REPO_ROOT}"
# El chequeo de si hace falta traducir NO puede ser un "[ -f ... ]" comun
# sobre REPO_ROOT: ese archivo siempre existe desde el punto de vista de
# ESTE contenedor (esta bind-mounteado tal cual aca), independientemente
# de si el demonio del HOST podria resolver esa misma ruta. La unica forma
# real de saber si va a funcionar es probarlo exactamente como lo va a
# usar gitleaks: pidiendole al demonio compartido que monte esa ruta.
if [ -f /.dockerenv ] && [ "$DOCKER_MOUNT_ROOT" = "$REPO_ROOT" ] && \
   ! docker run --rm -v "$REPO_ROOT:/repo" alpine test -f /repo/.gitleaks.toml 2>/dev/null; then
  SELF_ID="$(cat /etc/hostname 2>/dev/null || true)"
  TRANSLATED=""
  if [ -n "$SELF_ID" ]; then
    TRANSLATED="$(docker inspect "$SELF_ID" \
      --format '{{range .Mounts}}{{.Destination}}	{{.Source}}
{{end}}' 2>/dev/null | awk -F'\t' -v cwd="$REPO_ROOT" '
        index(cwd, $1) == 1 && length($1) > best_len {
          best_len = length($1); best_src = $2
        }
        END { if (best_len > 0) print best_src substr(cwd, best_len + 1) }
      ')"
  fi
  # OJO: "$TRANSLATED" es una ruta del HOST, no de este contenedor - un
  # "[ -f ... ]" comun aca comprobaria el filesystem de ESTE contenedor
  # (donde esa ruta del host casi nunca existe tal cual) y siempre daria
  # falso, aunque la traduccion este perfecta. La unica forma real de
  # validarla es preguntarle al propio demonio del host, montandola en un
  # contenedor descartable.
  if [ -n "$TRANSLATED" ] && \
     docker run --rm -v "$TRANSLATED:/repo" alpine test -f /repo/.gitleaks.toml 2>/dev/null; then
    echo "ℹ️  Corriendo dentro de un contenedor con el socket de Docker"
    echo "   compartido (Docker-fuera-de-Docker). Ruta real del host para"
    echo "   los montajes de Docker: $TRANSLATED"
    DOCKER_MOUNT_ROOT="$TRANSLATED"
  else
    echo "⚠️  Parece que este script corre dentro de un contenedor con el"
    echo "   socket de Docker compartido, pero no se pudo traducir la ruta"
    echo "   real del host automáticamente. Si los pasos de Gitleaks/Semgrep/"
    echo "   Trivy fallan con \"no such file or directory\", corré este script"
    echo "   con: DOCKER_MOUNT_ROOT=/ruta/real/del/host ./scripts/pipeline-local.sh"
    echo "   (la ruta que le pasaste a -v al crear ESTE contenedor)."
  fi
fi

printf '%b🚀 Corriendo el pipeline DevSecOps localmente (copia de cada log en %s)%b\n' "$BLUE" "$LOG_DIR" "$NC"

# 1. Gitleaks -----------------------------------------------------------
section "🔑 Secret Scanning (Gitleaks)"
if docker run --rm -v "$DOCKER_MOUNT_ROOT:/repo" zricethezav/gitleaks:latest \
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
# Semgrep descarga las reglas (p/owasp-top-ten, etc.) de semgrep.dev en cada
# corrida, desde una imagen Alpine (musl). Algunos DNS - tipicamente el de
# "Compartir conexion a Internet" / hotspot de Windows (192.168.137.1,
# dominio mshome.net) - responden NXDOMAIN a la consulta IPv6 (AAAA) de un
# nombre que solo tiene IPv4, en vez de "sin registros". glibc (el host) lo
# ignora; musl le cree y da el nombre por inexistente, asi que Semgrep falla
# con "Name does not resolve" aunque el host tenga internet. Se detecta con
# un contenedor Alpine descartable y, si con DNS publicos si resuelve, se
# usan esos DNS solo para el contenedor de Semgrep.
SEMGREP_DNS_ARGS=()
if ! docker run --rm alpine getent ahosts semgrep.dev > /dev/null 2>&1 && \
   docker run --rm --dns 1.1.1.1 --dns 8.8.8.8 alpine getent ahosts semgrep.dev > /dev/null 2>&1; then
  echo "ℹ️  El DNS de esta red no le resuelve semgrep.dev a los contenedores"
  echo "   Alpine (responde NXDOMAIN a la consulta IPv6). Se usan DNS publicos"
  echo "   (1.1.1.1, 8.8.8.8) solo para el contenedor de Semgrep."
  SEMGREP_DNS_ARGS=(--dns 1.1.1.1 --dns 8.8.8.8)
fi
if docker run --rm "${SEMGREP_DNS_ARGS[@]}" -v "$DOCKER_MOUNT_ROOT:/src" -w /src semgrep/semgrep \
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
  (cd "services/$svc" && npm install --package-lock-only --silent --ignore-scripts) \
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
  if docker run --rm -v "$DOCKER_MOUNT_ROOT:/repo" -w /repo aquasec/trivy:0.70.0 \
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
    if docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$DOCKER_MOUNT_ROOT:/repo" \
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
    (cd "services/$svc" && npm ci --silent --ignore-scripts) > "$LOG_DIR/npm-install-test-$svc.log" 2>&1

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
    success) printf '%b✅ %s%b\n' "$GREEN" "$2" "$NC" ;;
    missing) printf '⚪ %s (no se corrio)\n' "$2" ;;
    *)       printf '%b❌ %s%b\n' "$RED" "$2" "$NC" ;;
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
  printf '%b✅ Todo en verde localmente. Es seguro hacer push.%b\n' "$GREEN" "$NC"
  exit 0
else
  printf '%b❌ Hay controles en rojo. Revisa el detalle de arriba (o los logs en %s) antes de hacer push.%b\n' "$RED" "$LOG_DIR" "$NC"
  exit 1
fi

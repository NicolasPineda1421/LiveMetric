#!/usr/bin/env bash
# LiveMetric - Corre localmente, con Docker, los mismos controles de
# seguridad del pipeline de GitHub Actions: construye las 6 imagenes reales
# con "docker build" (igual que hace scripts/deploy.sh para levantar el
# stack) y las escanea con las mismas herramientas y comandos exactos que
# usa .github/workflows/devsecops.yml - para detectar problemas ANTES de
# hacer push, sin esperar a que corra en GitHub Actions.
#
# Salida pensada para leerse de un vistazo: cada control muestra UNA linea
# con su resultado ya interpretado (por ejemplo "2 CRITICAL, 1 HIGH" o
# "11/12 pruebas OK") y, si falla, los hallazgos concretos (CVE, archivo,
# prueba). Al final hay un resumen por control, una matriz por servicio y,
# para cada falla, que hacer y las ultimas lineas de su log. La salida
# completa de cada herramienta queda guardada en un archivo por paso; con
# --verbose se ve ademas en vivo, igual que expandir un paso en GitHub
# Actions. El parseo de los logs lo hace scripts/lib/report.js.
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
# Requisitos: Docker, Node.js/npm, y (para las pruebas unitarias) un .env
# real en la raiz del repo con las credenciales de Supabase.
#
# Uso:
#   ./scripts/pipeline-local.sh             # salida resumida (por defecto)
#   ./scripts/pipeline-local.sh --verbose   # ademas, la salida cruda en vivo
#   NO_COLOR=1 ./scripts/pipeline-local.sh  # sin colores

set -uo pipefail  # sin -e a proposito: un control que falla no debe abortar el resto

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=true ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opcion desconocida: $arg (usa --verbose o --help)" >&2; exit 2 ;;
  esac
done
[ "${LIVEMETRIC_VERBOSE:-0}" = "1" ] && VERBOSE=true

SERVICES=(auth voting analytics scrutiny scheduler frontend)
BACKEND_SERVICES=(auth voting analytics scrutiny scheduler)
LOG_DIR="$(mktemp -d /tmp/livemetric-pipeline-local.XXXXXX)"
TOTAL_STEPS=6
PIPELINE_START=$SECONDS

declare -A RESULT   # resultado global de cada control
declare -A CELL     # resultado por "control:servicio" (para la matriz final)
FAILS=()            # "titulo|log|que hacer|tipo" de cada falla, para el resumen

# Colores ANSI: azul para los pasos, verde para lo que aprueba, rojo para lo
# que falla, amarillo para lo omitido/informativo y gris para el detalle
# secundario. Si la salida no va a una terminal (por ejemplo, redirigida a
# un archivo) o se define NO_COLOR, se dejan vacios para no ensuciar el log
# con codigos de escape (y no se muestra el indicador de progreso).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BLUE=$'\033[1;34m'; GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'; GRAY=$'\033[0;90m'; BOLD=$'\033[1m'; NC=$'\033[0m'
  BG_GREEN=$'\033[1;97;42m'; BG_RED=$'\033[1;97;41m'
  IS_TTY=true
else
  BLUE=''; GREEN=''; RED=''; YELLOW=''; CYAN=''; GRAY=''; BOLD=''; NC=''
  BG_GREEN=''; BG_RED=''
  IS_TTY=false
fi

RULE='────────────────────────────────────────────────────────────────────'

report() {
  node "$REPO_ROOT/scripts/lib/report.js" "$@" 2>/dev/null
}

fmt_time() {
  if [ "$1" -ge 60 ]; then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi
}

# step <numero> <titulo> <que revisa, en una frase>
step() {
  printf '\n%s[%s/%s] %s%s\n' "$BLUE" "$1" "$TOTAL_STEPS" "$2" "$NC"
  printf '      %s%s%s\n' "$GRAY" "$3" "$NC"
}

# run_logged <etiqueta> <log> <comando...>
# Corre el comando guardando toda su salida en <log>. Mientras corre muestra
# un indicador con el tiempo transcurrido (o, con --verbose, la salida real
# en vivo). Devuelve el codigo de salida del comando y deja en LAST_SECS
# cuanto tardo.
run_logged() {
  local label="$1" log="$2" start=$SECONDS rc
  shift 2
  if $VERBOSE; then
    printf '      %s┌── salida de %s%s\n' "$GRAY" "$label" "$NC"
    "$@" 2>&1 | tee "$log"
    rc=$?
    printf '      %s└──%s\n' "$GRAY" "$NC"
  else
    "$@" > "$log" 2>&1 &
    local pid=$! i=0 spin='|/-\'
    if $IS_TTY; then
      while kill -0 "$pid" 2> /dev/null; do
        printf '\r      %s%s%s %s... %s%s%s ' "$CYAN" "${spin:i++%4:1}" "$NC" "$label" \
          "$GRAY" "$(fmt_time $((SECONDS - start)))" "$NC"
        sleep 0.2
      done
      printf '\r\033[K'
    fi
    wait "$pid"
    rc=$?
  fi
  LAST_SECS=$((SECONDS - start))
  return $rc
}

# row <success|failure|missing> <donde> <herramienta> <detalle>
row() {
  local icon color
  case "$1" in
    success) icon='✓'; color=$GREEN ;;
    missing) icon='-'; color=$YELLOW ;;
    *)       icon='✗'; color=$RED ;;
  esac
  printf '      %s%s%s %-10s %-12s %s%s%s %s(%s)%s\n' "$color" "$icon" "$NC" "$2" "$3" \
    "$color" "$4" "$NC" "$GRAY" "$(fmt_time "${LAST_SECS:-0}")" "$NC"
}

# details <tipo> <archivo> [n]: lista los hallazgos concretos bajo una fila.
details() {
  local items
  items="$(report details "$1" "$2" "${3:-5}")"
  [ -n "$items" ] || return 0
  while IFS= read -r line; do
    printf '          %s•%s %s\n' "$GRAY" "$NC" "$line"
  done <<< "$items"
}

add_fail() { FAILS+=("$1|$2|$3|${4:-}"); }  # <titulo> <log> <que hacer> [tipo de report.js]

if ! command -v docker &> /dev/null; then
  printf '%s✗ Este script necesita Docker instalado y corriendo.%s\n' "$RED" "$NC" >&2
  exit 1
fi
if ! command -v node &> /dev/null; then
  printf '%s✗ Este script necesita Node.js/npm (npm audit, pruebas y el resumen).%s\n' "$RED" "$NC" >&2
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

printf '%s%s%s\n' "$BLUE" "$RULE" "$NC"
printf '%s 🚀 Pipeline DevSecOps local%s  %s(%s servicios, %s controles)%s\n' \
  "$BOLD" "$NC" "$GRAY" "${#SERVICES[@]}" "$TOTAL_STEPS" "$NC"
printf '%s    Logs completos: %s%s\n' "$GRAY" "$LOG_DIR" "$NC"
$VERBOSE || printf '%s    Tip: --verbose muestra la salida cruda de cada herramienta en vivo.%s\n' "$GRAY" "$NC"
printf '%s%s%s\n' "$BLUE" "$RULE" "$NC"

# 1. Gitleaks -----------------------------------------------------------
step 1 "🔑 Secretos en el codigo (Gitleaks)" \
  "Busca contrasenas, tokens o claves escritas por error en el repositorio."
LOG="$LOG_DIR/gitleaks.log"
if run_logged "Gitleaks" "$LOG" docker run --rm -v "$DOCKER_MOUNT_ROOT:/repo" zricethezav/gitleaks:latest \
    detect --source /repo --config /repo/.gitleaks.toml --redact --verbose --no-banner; then
  RESULT[gitleaks]=success
else
  RESULT[gitleaks]=failure
fi
row "${RESULT[gitleaks]}" "repo" "Gitleaks" "$(report summary gitleaks "$LOG")"
if [ "${RESULT[gitleaks]}" != success ]; then
  details gitleaks "$LOG"
  add_fail "Secretos en el codigo (Gitleaks)" "$LOG" \
    "Saca el secreto del codigo y rotalo (ya quedo expuesto en el historial). Si es un falso positivo, agregalo a .gitleaks.toml." \
    gitleaks
fi

# 2. Semgrep (SAST) -------------------------------------------------------
# Igual que en CI: Semgrep termina en 0 sin importar cuantos hallazgos
# reporte (no se le pasa --error) - el pipeline lo usa para SUBIR resultados
# a GitHub Security, no como gate por cantidad de hallazgos. El gate real
# es que el escaneo corra sin romperse y genere el SARIF; los hallazgos se
# muestran igual (los mas graves primero) como informacion para revisar.
step 2 "🔍 Analisis estatico del codigo (Semgrep SAST)" \
  "Reglas OWASP Top 10 / Express / JWT. Los hallazgos son informativos: no bloquean."
LOG="$LOG_DIR/semgrep.log"
SARIF="$LOG_DIR/semgrep.sarif"
rm -f "$REPO_ROOT/semgrep-local.sarif"
if run_logged "Semgrep" "$LOG" docker run --rm -v "$DOCKER_MOUNT_ROOT:/src" -w /src semgrep/semgrep \
    semgrep scan --config=p/owasp-top-ten --config=p/expressjs --config=p/nodejsscan --config=p/jwt \
    --sarif --output=/src/semgrep-local.sarif . \
    && [ -s "$REPO_ROOT/semgrep-local.sarif" ]; then
  RESULT[semgrep]=success
else
  RESULT[semgrep]=failure
fi
[ -f "$REPO_ROOT/semgrep-local.sarif" ] && mv "$REPO_ROOT/semgrep-local.sarif" "$SARIF"
row "${RESULT[semgrep]}" "repo" "Semgrep" "$(report summary semgrep "$SARIF")"
if [ "${RESULT[semgrep]}" = success ]; then
  details semgrep "$SARIF" 5
else
  add_fail "Analisis estatico (Semgrep)" "$LOG" \
    "El escaneo no llego a generar el reporte. Revisa el log: suele ser un problema de red al bajar las reglas o del montaje del repo en Docker."
fi

# 3. npm audit (SCA) por servicio ---------------------------------------
audit_service() {
  (cd "services/$1" && npm install --package-lock-only --silent --ignore-scripts) \
    > "$LOG_DIR/npm-install-$1.log" 2>&1
  (cd "services/$1" && npm audit --omit=dev --audit-level=high)
}

step 3 "📦 Dependencias vulnerables (npm audit)" \
  "Revisa las librerias de produccion de cada servicio contra la base de CVEs de npm."
RESULT[npm_audit]=success
for svc in "${SERVICES[@]}"; do
  LOG="$LOG_DIR/npm-audit-$svc.log"
  if run_logged "npm audit $svc" "$LOG" audit_service "$svc"; then
    CELL[npm:$svc]=success
  else
    CELL[npm:$svc]=failure
    RESULT[npm_audit]=failure
  fi
  row "${CELL[npm:$svc]}" "$svc" "npm audit" "$(report summary npm-audit "$LOG")"
  if [ "${CELL[npm:$svc]}" != success ]; then
    details npm-audit "$LOG"
    add_fail "npm audit - $svc" "$LOG" \
      "Hay dependencias con CVEs HIGH/CRITICAL. Proba: cd services/$svc && npm audit fix (y volve a correr las pruebas)." \
      npm-audit
  fi
done

# 4. Trivy fs (SCA) por servicio ------------------------------------------
step 4 "📦 Dependencias vulnerables (Trivy fs)" \
  "Segunda opinion sobre package.json/package-lock.json: solo CVEs HIGH/CRITICAL con arreglo disponible."
RESULT[trivy_fs]=success
for svc in "${SERVICES[@]}"; do
  LOG="$LOG_DIR/trivy-fs-$svc.log"
  if run_logged "Trivy fs $svc" "$LOG" docker run --rm -v "$DOCKER_MOUNT_ROOT:/repo" -w /repo aquasec/trivy:0.70.0 \
      fs "services/$svc" --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed \
      --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress; then
    CELL[trivyfs:$svc]=success
  else
    CELL[trivyfs:$svc]=failure
    RESULT[trivy_fs]=failure
  fi
  row "${CELL[trivyfs:$svc]}" "$svc" "Trivy fs" "$(report summary trivy "$LOG")"
  if [ "${CELL[trivyfs:$svc]}" != success ]; then
    details trivy "$LOG"
    add_fail "Trivy fs - $svc" "$LOG" \
      "Actualiza en services/$svc/package.json las librerias listadas a la version corregida. Si el riesgo esta aceptado, documentalo en .trivyignore." \
      trivy
  fi
done

# 5. docker build + Trivy image (Container Scan) --------------------------
step 5 "🐳 Imagenes de contenedor (docker build + Trivy image)" \
  "Construye las imagenes reales y escanea el sistema operativo base y las librerias que quedan adentro."
RESULT[container]=success
for svc in "${SERVICES[@]}"; do
  LOG="$LOG_DIR/docker-build-$svc.log"
  if run_logged "docker build $svc" "$LOG" docker build -t "livemetric-$svc-localcheck" "services/$svc"; then
    CELL[build:$svc]=success
    row success "$svc" "build" "$(report summary build "$LOG")"

    LOG="$LOG_DIR/trivy-image-$svc.log"
    if run_logged "Trivy image $svc" "$LOG" docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$DOCKER_MOUNT_ROOT:/repo" aquasec/trivy:0.70.0 image "livemetric-$svc-localcheck" \
        --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed --scanners vuln \
        --ignorefile /repo/.trivyignore --skip-version-check --no-progress; then
      CELL[image:$svc]=success
    else
      CELL[image:$svc]=failure
      RESULT[container]=failure
    fi
    row "${CELL[image:$svc]}" "$svc" "Trivy image" "$(report summary trivy "$LOG")"
    if [ "${CELL[image:$svc]}" != success ]; then
      details trivy "$LOG"
      add_fail "Trivy image - $svc" "$LOG" \
        "Si el CVE es del sistema base, actualiza la imagen FROM de services/$svc/Dockerfile; si es de una libreria, actualizala en package.json." \
        trivy
    fi
  else
    CELL[build:$svc]=failure
    CELL[image:$svc]=missing
    RESULT[container]=failure
    row failure "$svc" "build" "$(report summary build "$LOG")"
    details build "$LOG" 3
    LAST_SECS=0
    row missing "$svc" "Trivy image" "no se escaneo (fallo el build)"
    add_fail "docker build - $svc" "$LOG" \
      "La imagen no compila. Revisa el paso del Dockerfile que falla (al final del log)."
  fi
  docker rmi "livemetric-$svc-localcheck" > /dev/null 2>&1
done

# 6. Pruebas unitarias ------------------------------------------------------
test_service() {
  (cd "services/$1" && npm ci --silent --ignore-scripts) > "$LOG_DIR/npm-install-test-$1.log" 2>&1
  (cd "services/$1" && npm test)
}

step 6 "🧪 Pruebas unitarias (Jest + Supertest)" \
  "Corre la suite de cada microservicio backend."
if [ -f .env ]; then
  RESULT[tests]=success
  for svc in "${BACKEND_SERVICES[@]}"; do
    LOG="$LOG_DIR/test-$svc.log"
    if run_logged "pruebas $svc" "$LOG" test_service "$svc"; then
      CELL[tests:$svc]=success
    else
      CELL[tests:$svc]=failure
      RESULT[tests]=failure
    fi
    row "${CELL[tests:$svc]}" "$svc" "Jest" "$(report summary jest "$LOG")"
    if [ "${CELL[tests:$svc]}" != success ]; then
      details jest "$LOG"
      add_fail "Pruebas unitarias - $svc" "$LOG" \
        "Reproducilo con: cd services/$svc && npm test" jest
    fi
  done
else
  RESULT[tests]=missing
  LAST_SECS=0
  row missing "-" "Jest" "OMITIDAS: no hay .env en la raiz del repo"
fi

printf '\n      %sFuera de alcance local (se validan solo en GitHub Actions): Checkov,%s\n' "$GRAY" "$NC"
printf '      %sdespliegue con Terraform y DAST con OWASP ZAP.%s\n' "$GRAY" "$NC"

# Resumen final -----------------------------------------------------------
# count_fail <prefijo> <servicios...>: cuantos servicios fallaron un control.
count_fail() {
  local prefix="$1" n=0 svc
  shift
  for svc in "$@"; do
    if [ "$prefix" = container ]; then
      # Una imagen cuenta como fallida si no compila o si Trivy encuentra algo.
      [ "${CELL[build:$svc]:-}" = failure ] || [ "${CELL[image:$svc]:-}" = failure ] && n=$((n + 1))
    else
      [ "${CELL[$prefix:$svc]:-}" = failure ] && n=$((n + 1))
    fi
  done
  echo "$n"
}

summary_line() {  # <resultado> <control> <detalle>
  local icon color word
  case "$1" in
    success) icon='✓'; color=$GREEN;  word='APROBADO' ;;
    missing) icon='-'; color=$YELLOW; word='OMITIDO' ;;
    *)       icon='✗'; color=$RED;    word='FALLA' ;;
  esac
  printf '   %s%s %-9s%s %-38s %s%s%s\n' "$color" "$icon" "$word" "$NC" "$2" "$GRAY" "$3" "$NC"
}

by_service() {  # <prefijo> <servicios...>
  local total=$(($# - 1)) failed
  failed=$(count_fail "$@")
  if [ "$failed" -eq 0 ]; then echo "$total/$total servicios OK"; else echo "$failed de $total servicios con problemas"; fi
}

cell() {  # <resultado> -> simbolo centrado en una columna de 11 caracteres
  case "${1:-}" in
    success) printf '     %s✓%s     ' "$GREEN" "$NC" ;;
    failure) printf '     %s✗%s     ' "$RED" "$NC" ;;
    *)       printf '     %s-%s     ' "$GRAY" "$NC" ;;
  esac
}

printf '\n%s%s%s\n' "$BLUE" "$RULE" "$NC"
printf '%s 📋 RESUMEN DEL ANALISIS%s  %s(duracion total: %s)%s\n' "$BOLD" "$NC" "$GRAY" \
  "$(fmt_time $((SECONDS - PIPELINE_START)))" "$NC"
printf '%s%s%s\n\n' "$BLUE" "$RULE" "$NC"

summary_line "${RESULT[gitleaks]}"  "🔑 Secretos en el codigo (Gitleaks)" "$(report summary gitleaks "$LOG_DIR/gitleaks.log")"
summary_line "${RESULT[semgrep]}"   "🔍 Analisis estatico (Semgrep)"      "$(report summary semgrep "$SARIF")"
summary_line "${RESULT[npm_audit]}" "📦 Dependencias (npm audit)"         "$(by_service npm "${SERVICES[@]}")"
summary_line "${RESULT[trivy_fs]}"  "📦 Dependencias (Trivy fs)"          "$(by_service trivyfs "${SERVICES[@]}")"
summary_line "${RESULT[container]}" "🐳 Imagenes (build + Trivy image)"  "$(by_service container "${SERVICES[@]}")"
if [ "${RESULT[tests]}" = missing ]; then
  summary_line missing "🧪 Pruebas unitarias (Jest)" "no hay .env en la raiz del repo"
else
  summary_line "${RESULT[tests]}" "🧪 Pruebas unitarias (Jest)" "$(by_service tests "${BACKEND_SERVICES[@]}")"
fi

printf '\n   %s%-11s  npm audit   Trivy fs    build    Trivy img   pruebas  %s\n' "$BOLD" "Servicio" "$NC"
printf '   %s%s%s\n' "$GRAY" "───────────────────────────────────────────────────────────────────" "$NC"
for svc in "${SERVICES[@]}"; do
  printf '   %-11s ' "$svc"
  cell "${CELL[npm:$svc]:-}"; cell "${CELL[trivyfs:$svc]:-}"; cell "${CELL[build:$svc]:-}"
  cell "${CELL[image:$svc]:-}"; cell "${CELL[tests:$svc]:-}"
  echo
done
printf '   %sLeyenda:%s %s✓%s aprobado   %s✗%s falla   %s-%s no aplica / no se corrio\n' \
  "$GRAY" "$NC" "$GREEN" "$NC" "$RED" "$NC" "$GRAY" "$NC"

if [ "${#FAILS[@]}" -gt 0 ]; then
  printf '\n%s 🛠  QUE HACER (%s problema%s)%s\n' "$BOLD$RED" "${#FAILS[@]}" \
    "$([ "${#FAILS[@]}" -eq 1 ] || echo s)" "$NC"
  n=0
  for f in "${FAILS[@]}"; do
    n=$((n + 1))
    IFS='|' read -r title log hint kind <<< "$f"
    printf '\n   %s%d) %s%s\n' "$RED$BOLD" "$n" "$title" "$NC"
    # Si se pudieron extraer los hallazgos concretos se muestran esos; si no,
    # las ultimas lineas del log, que es donde suele estar el error.
    found=""
    [ -n "$kind" ] && found="$(report details "$kind" "$log" 5)"
    if [ -n "$found" ]; then
      while IFS= read -r line; do printf '      %s•%s %s\n' "$GRAY" "$NC" "$line"; done <<< "$found"
    else
      printf '      %s┌── ultimas lineas del log%s\n' "$GRAY" "$NC"
      report tail "$log" 8 | while IFS= read -r line; do
        printf '      %s│%s %s\n' "$GRAY" "$NC" "$line"
      done
      printf '      %s└──%s\n' "$GRAY" "$NC"
    fi
    printf '      %s→ Que hacer:%s %s\n' "$YELLOW" "$NC" "$hint"
    printf '      %s  Log completo: %s%s\n' "$GRAY" "$log" "$NC"
  done
fi

echo ""
if [[ "${RESULT[gitleaks]:-}" == "success" && "${RESULT[semgrep]:-}" == "success" && \
      "${RESULT[npm_audit]:-}" == "success" && "${RESULT[trivy_fs]:-}" == "success" && \
      "${RESULT[container]:-}" == "success" && "${RESULT[tests]:-}" != "failure" ]]; then
  printf '%s  ✅ TODO EN VERDE  %s  Todos los controles aprobaron localmente. Es seguro hacer push.\n' "$BG_GREEN" "$NC"
  [ "${RESULT[tests]}" = missing ] && \
    printf '   %s(Las pruebas unitarias se omitieron por falta de .env.)%s\n' "$YELLOW" "$NC"
  printf '   %sLogs completos: %s%s\n' "$GRAY" "$LOG_DIR" "$NC"
  exit 0
else
  printf '%s  ❌ HAY CONTROLES EN ROJO  %s  Revisa la seccion "QUE HACER" de arriba antes de hacer push.\n' "$BG_RED" "$NC"
  printf '   %sLogs completos: %s%s\n' "$GRAY" "$LOG_DIR" "$NC"
  exit 1
fi

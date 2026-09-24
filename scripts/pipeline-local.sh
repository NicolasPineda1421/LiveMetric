#!/usr/bin/env bash
# LiveMetric - Corre localmente, con Docker, los mismos controles de
# seguridad del pipeline de GitHub Actions: construye las 6 imagenes reales
# con "docker build" (igual que hace scripts/deploy.sh para levantar el
# stack) y las escanea con las mismas herramientas y comandos exactos que
# usa .github/workflows/devsecops.yml - para detectar problemas ANTES de
# hacer push, sin esperar a que corra en GitHub Actions.
#
# Cada paso termina en una linea ya interpretada (cuantos secretos, CVE,
# hallazgos o pruebas fallidas, y en que servicio) y, si algo falla, las
# lineas del log que explican por que; al final, un cuadro con todos los
# controles por servicio. La salida completa de cada herramienta queda
# guardada en un log por paso, y con --detalle ademas se ve en vivo
# mientras corre - la misma idea que expandir un paso en un log de GitHub
# Actions. La interpretacion vive en scripts/lib/pipeline-resumen.js,
# compartida con la version para Windows (pipeline-local.bat).
#
# A diferencia de scripts/pipeline-status.sh (que solo CONSULTA el
# resultado de una corrida ya hecha en GitHub), este script EJECUTA los
# escaneos de verdad contra tu copia local del repo.
#
# No incluye el despliegue con Terraform ni el DAST con OWASP ZAP: esos
# pasos levantan el stack completo y tardan varios minutos mas; se siguen
# verificando en GitHub Actions (o a mano con "cd infra/terraform &&
# terraform apply", ver docs/instalacion-y-despliegue.md).
#
# Requisitos: Docker, Node.js/npm, y (para las pruebas unitarias) un .env
# real en la raiz del repo con las credenciales de Supabase.
#
# Uso:
#   ./scripts/pipeline-local.sh             resumen interpretado de cada paso
#   ./scripts/pipeline-local.sh --detalle   ademas, la salida real en vivo

set -uo pipefail  # sin -e a proposito: un control que falla no debe abortar el resto

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# shellcheck source=lib/ui.sh
source "$REPO_ROOT/scripts/lib/ui.sh"

for arg in "$@"; do
  case "$arg" in
    -d|--detalle) DETALLE=true ;;
    -h|--help) sed -n '/^# Uso:/,/^$/s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $arg (ver --help)" >&2; exit 2 ;;
  esac
done

SERVICES=(auth voting analytics scrutiny scheduler frontend)
BACKEND_SERVICES=(auth voting analytics scrutiny scheduler)

for requisito in docker node npm; do
  if ! command -v "$requisito" &> /dev/null; then
    falla "Este script necesita $requisito instalado (ver README)." >&2
    exit 1
  fi
done

LOG_DIR="$(mktemp -d /tmp/livemetric-pipeline-local.XXXXXX)"
RESULTADOS="$LOG_DIR/resultados.jsonl"
node scripts/lib/pipeline-resumen.js inicio "$RESULTADOS"

# resumir <control> <servicio|-> <codigo-de-salida> <log> [sarif]
# Interpreta el resultado de un paso e imprime su linea (ver
# scripts/lib/pipeline-resumen.js); tambien lo anota para el cuadro final.
resumir() { node scripts/lib/pipeline-resumen.js resultado "$RESULTADOS" "$@"; }

# paso <n> - encabezado del paso n (sus textos estan en pipeline-resumen.js,
# compartidos con la version para Windows).
paso() { node scripts/lib/pipeline-resumen.js paso "$1"; }

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

# start.sh ya muestra su propio encabezado para esta etapa.
if [ -z "${LIVEMETRIC_DESDE_START:-}" ]; then
  banner "$C_AZUL" "Pipeline DevSecOps local · mismos controles que GitHub Actions"
fi
info "Salida completa de cada paso: $LOG_DIR"
[ "$DETALLE" = true ] || info "Para verla en vivo mientras corre: --detalle"

# 1. Gitleaks -----------------------------------------------------------
paso 1
correr "$LOG_DIR/gitleaks.log" "Gitleaks revisando el historial" \
  docker run --rm -v "$DOCKER_MOUNT_ROOT:/repo" zricethezav/gitleaks:latest \
  detect --source /repo --config /repo/.gitleaks.toml --redact --verbose --no-banner
resumir gitleaks - $? "$LOG_DIR/gitleaks.log"

# 2. Semgrep (SAST) -------------------------------------------------------
# Igual que en CI: Semgrep termina en 0 sin importar cuantos hallazgos
# reporte (no se le pasa --error) - el pipeline lo usa para SUBIR resultados
# a GitHub Security, no como gate por cantidad de hallazgos. Por eso sus
# hallazgos se muestran como "para revisar" (amarillo) y no bloquean; el
# gate real es que el escaneo corra sin romperse y genere el SARIF.
paso 2
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
  info "El DNS de esta red no le resuelve semgrep.dev a los contenedores Alpine"
  info "(responde NXDOMAIN a la consulta IPv6): se usan DNS públicos (1.1.1.1,"
  info "8.8.8.8) solo para el contenedor de Semgrep."
  SEMGREP_DNS_ARGS=(--dns 1.1.1.1 --dns 8.8.8.8)
fi
correr "$LOG_DIR/semgrep.log" "Semgrep analizando el código" \
  docker run --rm "${SEMGREP_DNS_ARGS[@]}" -v "$DOCKER_MOUNT_ROOT:/src" -w /src semgrep/semgrep \
  semgrep scan --config=p/owasp-top-ten --config=p/expressjs --config=p/nodejsscan --config=p/jwt \
  --sarif --output=/src/semgrep-local.sarif .
SEMGREP_RC=$?
# El SARIF se escribe dentro del repo (es lo unico que el contenedor ve); se
# pasa a la carpeta de logs para no dejarlo suelto en el arbol de trabajo.
mv -f "$REPO_ROOT/semgrep-local.sarif" "$LOG_DIR/semgrep.sarif" 2>/dev/null \
  || rm -f "$REPO_ROOT/semgrep-local.sarif"
resumir semgrep - "$SEMGREP_RC" "$LOG_DIR/semgrep.log" "$LOG_DIR/semgrep.sarif"

# 3-4. npm audit + Trivy fs (SCA) por servicio -----------------------------
npm_audit() {
  cd "services/$1" || return 1
  npm install --package-lock-only --silent --ignore-scripts > "$LOG_DIR/npm-install-$1.log" 2>&1
  npm audit --omit=dev --audit-level=high
}

paso 3
for svc in "${SERVICES[@]}"; do
  correr "$LOG_DIR/npm-audit-$svc.log" "$svc · npm audit" npm_audit "$svc"
  resumir npm-audit "$svc" $? "$LOG_DIR/npm-audit-$svc.log"

  correr "$LOG_DIR/trivy-fs-$svc.log" "$svc · Trivy (deps)" \
    docker run --rm -v "$DOCKER_MOUNT_ROOT:/repo" -w /repo aquasec/trivy:0.70.0 \
    fs "services/$svc" --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed \
    --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress
  resumir trivy-fs "$svc" $? "$LOG_DIR/trivy-fs-$svc.log"
done

# 5. docker build + Trivy image (Container Scan) --------------------------
paso 4
for svc in "${SERVICES[@]}"; do
  correr "$LOG_DIR/docker-build-$svc.log" "$svc · construyendo la imagen" \
    docker build -t "livemetric-$svc-localcheck" "services/$svc"
  BUILD_RC=$?
  resumir build "$svc" "$BUILD_RC" "$LOG_DIR/docker-build-$svc.log"

  if [ "$BUILD_RC" -eq 0 ]; then
    correr "$LOG_DIR/trivy-image-$svc.log" "$svc · Trivy (imagen)" \
      docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$DOCKER_MOUNT_ROOT:/repo" \
      aquasec/trivy:0.70.0 image "livemetric-$svc-localcheck" --severity CRITICAL,HIGH \
      --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore \
      --skip-version-check --no-progress
    resumir trivy-image "$svc" $? "$LOG_DIR/trivy-image-$svc.log"
  fi
  docker rmi "livemetric-$svc-localcheck" > /dev/null 2>&1
done

# 6. Pruebas unitarias ------------------------------------------------------
pruebas() {
  cd "services/$1" || return 1
  npm ci --silent --ignore-scripts > "$LOG_DIR/npm-install-test-$1.log" 2>&1
  npm test
}

paso 5
if [ -f .env ]; then
  for svc in "${BACKEND_SERVICES[@]}"; do
    correr "$LOG_DIR/test-$svc.log" "$svc · pruebas" pruebas "$svc"
    resumir pruebas "$svc" $? "$LOG_DIR/test-$svc.log"
  done
else
  node scripts/lib/pipeline-resumen.js omitido "$RESULTADOS" pruebas - "falta el .env en la raíz del repo"
fi

# Cuadro final: decide ademas el codigo de salida (1 si algo que bloquea fallo).
node scripts/lib/pipeline-resumen.js final "$RESULTADOS" "$LOG_DIR"
exit $?

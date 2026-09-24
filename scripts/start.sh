#!/usr/bin/env bash
# LiveMetric - Punto de entrada unico: instala los requisitos que falten,
# prepara el .env, corre el mismo analisis de seguridad que el pipeline de
# CI (Gitleaks, Semgrep, SCA, Trivy, pruebas unitarias) mostrando el
# detalle en la terminal, y SOLO si todo pasa levanta el stack completo y
# muestra el link donde queda desplegado.
#
# Si el analisis encuentra algo en rojo, el script se detiene ahi: no
# levanta contenedores con codigo que no paso sus propios controles.
#
# Requisitos (se intentan instalar solos si faltan): Docker, gpg, curl,
# Node.js/npm. La instalacion automatica detecta el gestor de paquetes
# (apt/dnf/yum/pacman/zypper/apk) y usa "sudo" si no se corre como root;
# Docker se instala con el script oficial (get.docker.com), igual que
# recomienda la propia documentacion de Docker.
#
# La salida esta organizada en 4 pasos numerados con colores (verde = ok,
# rojo = error, amarillo = aviso) y termina con un panel que muestra el
# estado de cada contenedor y los links donde quedo cada servicio.
#
# Uso:
#   ./scripts/start.sh             # analisis resumido (por defecto)
#   ./scripts/start.sh --verbose   # ademas, la salida cruda de cada herramienta
#   NO_COLOR=1 ./scripts/start.sh  # sin colores

set -uo pipefail

cd "$(dirname "$0")/.."

PIPELINE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) PIPELINE_ARGS+=(--verbose) ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opcion desconocida: $arg (usa --verbose o --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BLUE=$'\033[1;34m'; GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'
  GRAY=$'\033[0;90m'; BOLD=$'\033[1m'; NC=$'\033[0m'
  BG_GREEN=$'\033[1;97;42m'; BG_RED=$'\033[1;97;41m'; BG_YELLOW=$'\033[1;30;43m'
else
  BLUE=''; GREEN=''; RED=''; YELLOW=''; GRAY=''; BOLD=''; NC=''
  BG_GREEN=''; BG_RED=''; BG_YELLOW=''
fi

RULE='════════════════════════════════════════════════════════════════════'
START_TIME=$SECONDS

# Mensajes con el mismo formato en todo el script.
ok()   { printf '   %s✓%s %s\n' "$GREEN" "$NC" "$*"; }
fail() { printf '   %s✗ %s%s\n' "$RED" "$*" "$NC"; }
warn() { printf '   %s! %s%s\n' "$YELLOW" "$*" "$NC"; }
info() { printf '   %s→%s %s\n' "$BLUE" "$NC" "$*"; }
hint() { printf '     %s%s%s\n' "$GRAY" "$*" "$NC"; }

# step <numero> <titulo>
step() {
  printf '\n%sPASO %s/4 · %s%s\n' "$BLUE" "$1" "$2" "$NC"
  printf '%s%s%s\n' "$GRAY" "────────────────────────────────────────────────────────────────────" "$NC"
}

fmt_time() {
  if [ "$1" -ge 60 ]; then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi
}

printf '%s%s%s\n' "$BLUE" "$RULE" "$NC"
printf '%s  🗳  LiveMetric%s - arranque con verificacion de seguridad\n' "$BOLD" "$NC"
printf '%s  1) Requisitos  2) Configuracion  3) Analisis de seguridad  4) Despliegue%s\n' "$GRAY" "$NC"
printf '%s%s%s\n' "$BLUE" "$RULE" "$NC"

# 0. Verificar/instalar requisitos -------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo &> /dev/null; then
  SUDO="sudo"
fi

if command -v apt-get &> /dev/null; then PKG_MGR="apt"
elif command -v dnf &> /dev/null; then PKG_MGR="dnf"
elif command -v yum &> /dev/null; then PKG_MGR="yum"
elif command -v pacman &> /dev/null; then PKG_MGR="pacman"
elif command -v zypper &> /dev/null; then PKG_MGR="zypper"
elif command -v apk &> /dev/null; then PKG_MGR="apk"
else PKG_MGR="unknown"
fi

install_pkg() {
  # $@: uno o mas nombres de paquete, tal como los conoce el gestor detectado.
  case "$PKG_MGR" in
    apt)    $SUDO apt-get update -qq && $SUDO apt-get install -y "$@" ;;
    dnf)    $SUDO dnf install -y "$@" ;;
    yum)    $SUDO yum install -y "$@" ;;
    pacman) $SUDO pacman -Sy --noconfirm "$@" ;;
    zypper) $SUDO zypper --non-interactive install "$@" ;;
    apk)    $SUDO apk add --no-cache "$@" ;;
    *) return 1 ;;
  esac
}

REQUISITOS_OK=true

ensure_tool() {
  local cmd="$1"; shift
  local pkgs=("$@")
  if command -v "$cmd" &> /dev/null; then
    ok "$cmd ya está instalado."
    return 0
  fi
  if [ "$PKG_MGR" = "unknown" ]; then
    fail "$cmd no está instalado, y no se detectó un gestor de paquetes"
    hint "conocido (apt/dnf/yum/pacman/zypper/apk) para instalarlo solo."
    REQUISITOS_OK=false
    return 1
  fi
  info "$cmd no está instalado. Instalando con $PKG_MGR (${pkgs[*]})..."
  if install_pkg "${pkgs[@]}" && command -v "$cmd" &> /dev/null; then
    ok "$cmd instalado correctamente."
  else
    fail "no se pudo instalar $cmd automáticamente. Instalalo a mano."
    REQUISITOS_OK=false
  fi
}

ensure_node() {
  if command -v npm &> /dev/null; then
    ok "npm ya está instalado."
    return 0
  fi
  if [ "$PKG_MGR" = "unknown" ]; then
    fail "npm no está instalado, y no se detectó un gestor de paquetes"
    hint "conocido para instalarlo solo."
    REQUISITOS_OK=false
    return 1
  fi
  # El paquete "nodejs" de dnf/yum ya incluye npm; en el resto de los
  # gestores hace falta pedir "npm" como paquete aparte.
  local pkgs=(nodejs npm)
  [ "$PKG_MGR" = "dnf" ] || [ "$PKG_MGR" = "yum" ] && pkgs=(nodejs)
  info "npm no está instalado. Instalando Node.js con $PKG_MGR..."
  if install_pkg "${pkgs[@]}" && command -v npm &> /dev/null; then
    ok "npm instalado correctamente."
  else
    fail "no se pudo instalar Node.js automáticamente. Instalalo a mano."
    REQUISITOS_OK=false
  fi
}

ensure_docker() {
  if ! command -v docker &> /dev/null; then
    info "Docker no está instalado. Instalando con el script oficial de Docker..."
    if curl -fsSL https://get.docker.com | $SUDO sh > /dev/null 2>&1; then
      ok "Docker instalado."
    else
      fail "no se pudo instalar Docker automáticamente. Instalalo a mano:"
      hint "https://docs.docker.com/engine/install/"
      REQUISITOS_OK=false
      return 1
    fi
  fi

  if docker info &> /dev/null; then
    ok "Docker está instalado y el motor responde."
    return 0
  fi

  # El motor no responde. Si hay systemd corriendo como PID 1, se puede
  # arrancar el servicio asi; si no (el caso tipico de estar corriendo este
  # script DENTRO de un contenedor, donde el propio PID 1 nunca es
  # systemd), "systemctl" no tiene con que hablar y falla con un error que
  # no tiene nada que ver con Docker.
  if [ -d /run/systemd/system ] && command -v systemctl &> /dev/null; then
    info "Docker está instalado pero el motor no responde. Iniciando el servicio..."
    if $SUDO systemctl start docker 2>/dev/null && sleep 2 && docker info &> /dev/null; then
      ok "Motor de Docker iniciado correctamente."
      return 0
    fi
    fail "no se pudo iniciar el servicio de Docker. Probá a mano:"
    hint "sudo systemctl start docker"
    hint "(y si el problema es de permisos: sudo usermod -aG docker \$USER,"
    hint "después cerrá sesión y volvé a entrar para que tome efecto)."
    REQUISITOS_OK=false
    return 1
  fi

  # Sin systemd: probablemente estamos dentro de un contenedor. Se intenta
  # arrancar el demonio directamente, sin depender de un sistema de init -
  # esto SOLO puede funcionar si el contenedor ya tiene los privilegios
  # necesarios para correr Docker anidado (--privileged o capacidades
  # equivalentes), algo que este script no puede otorgarse a si mismo.
  info "Docker está instalado pero el motor no responde, y no hay systemd"
  hint "para arrancarlo como servicio (parece que este script está"
  hint "corriendo dentro de un contenedor). Probando arrancar dockerd"
  hint "directamente..."
  $SUDO dockerd > /tmp/dockerd.log 2>&1 &
  disown
  for _ in $(seq 1 10); do
    sleep 1
    if docker info &> /dev/null; then
      ok "Motor de Docker iniciado correctamente (dockerd en segundo plano)."
      return 0
    fi
  done

  fail "no se pudo iniciar el motor de Docker (detalle en /tmp/dockerd.log)."
  hint "Si este script está corriendo DENTRO de un contenedor Docker, hace"
  hint "falta que ESE contenedor tenga acceso real a Docker - algo que hay"
  hint "que resolver desde afuera, no algo que este script pueda arreglar"
  hint "por si solo. Las dos formas correctas son:"
  hint "  1) Montar el socket del Docker del HOST en vez de instalar Docker"
  hint "     adentro: agregá al 'docker run' que crea este contenedor"
  hint "     -v /var/run/docker.sock:/var/run/docker.sock"
  hint "  2) O crear el contenedor en modo --privileged para que pueda"
  hint "     correr su propio demonio Docker anidado de verdad."
  REQUISITOS_OK=false
  return 1
}

step 1 "Requisitos (curl, gpg, Node.js, Docker)"
ensure_tool curl curl
ensure_tool gpg gnupg
ensure_node
ensure_docker
if ! $REQUISITOS_OK; then
  echo ""
  printf '%s  ❌ FALTAN REQUISITOS  %s  No se pudieron instalar solos.\n' "$BG_RED" "$NC"
  hint "Revisa los mensajes en rojo de arriba, instalalos a mano y volve a correr este script."
  exit 1
fi

# 2. Preparar el .env -------------------------------------------------------
step 2 "Configuracion (.env)"
if [ ! -f .env ]; then
  if [ -f .env.gpg ]; then
    info "No hay .env, pero si .env.gpg. Descifrando (te pedira la passphrase)..."
    if ! gpg --output .env --decrypt .env.gpg; then
      fail "No se pudo descifrar .env.gpg (¿passphrase incorrecta?)." >&2
      exit 1
    fi
    ok ".env descifrado a partir de .env.gpg."
  else
    fail "No hay .env ni .env.gpg en $(pwd)." >&2
    hint "Copia .env.example a .env y completa los valores (ver README, seccion 3)," >&2
    hint "o pedi el .env.gpg + la passphrase a quien te comparta el proyecto." >&2
    exit 1
  fi
else
  ok ".env ya existe, se usa tal cual."
fi

# 3. Analisis de seguridad completo (el mismo que corre en CI) --------------
step 3 "Analisis de seguridad (el mismo que corre en CI)"
hint "Gitleaks, Semgrep, npm audit, Trivy y pruebas unitarias. Puede tardar varios"
hint "minutos: construye las 6 imagenes reales. Si algo falla, NO se levanta el stack."
echo ""
if ! ./scripts/pipeline-local.sh ${PIPELINE_ARGS[@]+"${PIPELINE_ARGS[@]}"}; then
  echo ""
  printf '%s%s%s\n' "$RED" "$RULE" "$NC"
  printf '%s  ⛔ DESPLIEGUE CANCELADO  %s  El analisis encontro problemas.\n' "$BG_RED" "$NC"
  hint "No se levanto ningun contenedor. Corregi lo indicado en \"QUE HACER\" (arriba)"
  hint "y volve a correr ./scripts/start.sh"
  printf '%s%s%s\n' "$RED" "$RULE" "$NC"
  exit 1
fi

# 4. Levantar el stack --------------------------------------------------------
step 4 "Despliegue (docker compose up --build)"
BUILD_LOG="$(mktemp /tmp/livemetric-compose.XXXXXX.log)"
info "Construyendo y levantando los contenedores, puede tardar unos minutos..."
hint "Detalle en $BUILD_LOG"
if ! docker compose up -d --build > "$BUILD_LOG" 2>&1; then
  fail "docker compose up fallo. Ultimas lineas del log:"
  tail -n 15 "$BUILD_LOG" | sed "s/^/     ${GRAY}│${NC} /"
  exit 1
fi
ok "Contenedores creados."

info "Esperando a que el frontend responda (hasta 60s)..."
FRONTEND_UP=false
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000 > /dev/null 2>&1; then
    FRONTEND_UP=true
    break
  fi
  sleep 2
done

# service_row <nombre> <contenedor> <url o ""> <nota>
# Muestra el estado real del contenedor (y, si tiene puerto, si responde).
ALL_UP=true
service_row() {
  local name="$1" container="$2" url="$3" note="$4" state health icon color label
  state="$(docker inspect -f '{{.State.Status}}' "$container" 2> /dev/null || echo "no existe")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2> /dev/null)"
  if [ "$state" != running ]; then
    icon='✗'; color=$RED; label="$state"; ALL_UP=false
  elif [ "$health" = unhealthy ]; then
    icon='✗'; color=$RED; label="unhealthy"; ALL_UP=false
  elif [ -n "$url" ] && ! curl -sf "$url" > /dev/null 2>&1; then
    icon='!'; color=$YELLOW; label="no responde aun"; ALL_UP=false
  else
    icon='✓'; color=$GREEN; label="${health:-en linea}"
  fi
  printf '   %s%s %-10s%s %s%-16s%s %-29s %s%s%s\n' "$color" "$icon" "$name" "$NC" \
    "$color" "$label" "$NC" "${url:--}" "$GRAY" "$note" "$NC"
}

echo ""
printf '%s%s%s\n' "$BLUE" "$RULE" "$NC"
printf '%s  📡 ESTADO DE LOS SERVICIOS%s\n' "$BOLD" "$NC"
printf '%s%s%s\n\n' "$BLUE" "$RULE" "$NC"
printf '   %s  %-10s %-16s %-29s %s%s\n' "$BOLD" "Servicio" "Estado" "URL" "Notas" "$NC"
service_row frontend  livemetric-frontend  "http://localhost:3000"        "panel + votacion (abrir en el navegador)"
service_row auth      livemetric-auth      "http://localhost:3001/health" "API de login (solo este equipo)"
service_row voting    livemetric-voting    "http://localhost:3002/health" "API de votacion (solo este equipo)"
service_row analytics livemetric-analytics "http://localhost:3003/health" "API de resultados (solo este equipo)"
service_row scrutiny  livemetric-scrutiny  "http://localhost:3004/health" "API de escrutinio (solo este equipo)"
service_row scheduler livemetric-scheduler ""                             "worker interno, sin puerto"
service_row postgres  livemetric-postgres  ""                             "red interna, sin puerto"

# IP de este equipo en la red local: el frontend se publica en 0.0.0.0:3000,
# asi que otros equipos de la misma red pueden entrar por ahi.
LAN_IP="$(hostname -I 2> /dev/null | awk '{print $1}')"

echo ""
printf '%s%s%s\n' "$BLUE" "$RULE" "$NC"
if $FRONTEND_UP && $ALL_UP; then
  printf '%s  ✅ LIVEMETRIC ESTA ARRIBA  %s  (listo en %s)\n\n' "$BG_GREEN" "$NC" "$(fmt_time $((SECONDS - START_TIME)))"
elif $FRONTEND_UP; then
  printf '%s  ⚠️  LIVEMETRIC ARRIBA CON AVISOS  %s  Algun servicio no esta sano (ver tabla).\n\n' "$BG_YELLOW" "$NC"
else
  printf '%s  ⚠️  EL FRONTEND NO RESPONDIO A TIEMPO  %s  Puede estar terminando de iniciar.\n\n' "$BG_YELLOW" "$NC"
fi
printf '   %s👉 Abrir:%s           %shttp://localhost:3000%s\n' "$BOLD" "$NC" "$GREEN$BOLD" "$NC"
[ -n "$LAN_IP" ] && printf '   %sDesde la red local:%s %shttp://%s:3000%s\n' "$BOLD" "$NC" "$GREEN" "$LAN_IP" "$NC"
echo ""
printf '   %sComandos utiles:%s\n' "$BOLD" "$NC"
printf '     %-34s %s%s%s\n' "docker compose logs -f"          "$GRAY" "ver los logs en vivo" "$NC"
printf '     %-34s %s%s%s\n' "docker compose logs -f <servicio>" "$GRAY" "logs de un solo servicio (ej: auth)" "$NC"
printf '     %-34s %s%s%s\n' "docker ps"                        "$GRAY" "estado de los contenedores" "$NC"
printf '     %-34s %s%s%s\n' "docker compose down"              "$GRAY" "apagar el stack" "$NC"
printf '%s%s%s\n' "$BLUE" "$RULE" "$NC"

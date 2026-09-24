#!/usr/bin/env bash
# LiveMetric - Punto de entrada unico: instala los requisitos que falten,
# prepara el .env, corre el mismo analisis de seguridad que el pipeline de
# CI (Gitleaks, Semgrep, SCA, Trivy, pruebas unitarias) mostrando el
# resultado interpretado de cada control, y SOLO si todo pasa levanta el
# stack completo y muestra el link donde queda desplegado.
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
# Uso:
#   ./scripts/start.sh             resumen interpretado de cada paso
#   ./scripts/start.sh --detalle   ademas, la salida real de cada herramienta en vivo

set -uo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/ui.sh
source scripts/lib/ui.sh

ARGS_PIPELINE=()
for arg in "$@"; do
  case "$arg" in
    -d|--detalle) DETALLE=true; ARGS_PIPELINE+=(--detalle) ;;
    -h|--help) sed -n '/^# Uso:/,/^$/s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $arg (ver --help)" >&2; exit 2 ;;
  esac
done

banner "$C_AZUL" "LiveMetric · arranque con verificación de seguridad"

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
    ok "$cmd"
    return 0
  fi
  if [ "$PKG_MGR" = "unknown" ]; then
    falla "$cmd no está instalado, y no se detectó un gestor de paquetes"
    info "conocido (apt/dnf/yum/pacman/zypper/apk) para instalarlo solo."
    REQUISITOS_OK=false
    return 1
  fi
  aviso "$cmd no está instalado. Instalando con $PKG_MGR (${pkgs[*]})..."
  if install_pkg "${pkgs[@]}" && command -v "$cmd" &> /dev/null; then
    ok "$cmd (instalado recién)"
  else
    falla "no se pudo instalar $cmd automáticamente. Instalalo a mano."
    REQUISITOS_OK=false
  fi
}

ensure_node() {
  if command -v npm &> /dev/null; then
    ok "Node.js / npm"
    return 0
  fi
  if [ "$PKG_MGR" = "unknown" ]; then
    falla "npm no está instalado, y no se detectó un gestor de paquetes"
    info "conocido para instalarlo solo."
    REQUISITOS_OK=false
    return 1
  fi
  # El paquete "nodejs" de dnf/yum ya incluye npm; en el resto de los
  # gestores hace falta pedir "npm" como paquete aparte.
  local pkgs=(nodejs npm)
  [ "$PKG_MGR" = "dnf" ] || [ "$PKG_MGR" = "yum" ] && pkgs=(nodejs)
  aviso "npm no está instalado. Instalando Node.js con $PKG_MGR..."
  if install_pkg "${pkgs[@]}" && command -v npm &> /dev/null; then
    ok "Node.js / npm (instalado recién)"
  else
    falla "no se pudo instalar Node.js automáticamente. Instalalo a mano."
    REQUISITOS_OK=false
  fi
}

ensure_docker() {
  if ! command -v docker &> /dev/null; then
    aviso "Docker no está instalado. Instalando con el script oficial de Docker..."
    if curl -fsSL https://get.docker.com | $SUDO sh > /dev/null 2>&1; then
      ok "Docker (instalado recién)"
    else
      falla "no se pudo instalar Docker automáticamente. Instalalo a mano:"
      info "https://docs.docker.com/engine/install/"
      REQUISITOS_OK=false
      return 1
    fi
  fi

  if docker info &> /dev/null; then
    ok "Docker (el motor responde)"
    return 0
  fi

  # El motor no responde. Si hay systemd corriendo como PID 1, se puede
  # arrancar el servicio asi; si no (el caso tipico de estar corriendo este
  # script DENTRO de un contenedor, donde el propio PID 1 nunca es
  # systemd), "systemctl" no tiene con que hablar y falla con un error que
  # no tiene nada que ver con Docker.
  if [ -d /run/systemd/system ] && command -v systemctl &> /dev/null; then
    aviso "Docker está instalado pero el motor no responde. Iniciando el servicio..."
    if $SUDO systemctl start docker 2>/dev/null && sleep 2 && docker info &> /dev/null; then
      ok "Docker (motor iniciado)"
      return 0
    fi
    falla "no se pudo iniciar el servicio de Docker. Probá a mano:"
    info "sudo systemctl start docker"
    info "(y si el problema es de permisos: sudo usermod -aG docker \$USER,"
    info "después cerrá sesión y volvé a entrar para que tome efecto)."
    REQUISITOS_OK=false
    return 1
  fi

  # Sin systemd: probablemente estamos dentro de un contenedor. Se intenta
  # arrancar el demonio directamente, sin depender de un sistema de init -
  # esto SOLO puede funcionar si el contenedor ya tiene los privilegios
  # necesarios para correr Docker anidado (--privileged o capacidades
  # equivalentes), algo que este script no puede otorgarse a si mismo.
  aviso "Docker está instalado pero el motor no responde, y no hay systemd"
  info "para arrancarlo como servicio (parece que este script está"
  info "corriendo dentro de un contenedor). Probando arrancar dockerd"
  info "directamente..."
  $SUDO dockerd > /tmp/dockerd.log 2>&1 &
  disown
  for _ in $(seq 1 10); do
    sleep 1
    if docker info &> /dev/null; then
      ok "Docker (dockerd iniciado en segundo plano)"
      return 0
    fi
  done

  falla "no se pudo iniciar el motor de Docker (detalle en /tmp/dockerd.log)."
  info "Si este script está corriendo DENTRO de un contenedor Docker, hace"
  info "falta que ESE contenedor tenga acceso real a Docker - algo que hay"
  info "que resolver desde afuera, no algo que este script pueda arreglar"
  info "por sí solo. Las dos formas correctas son:"
  info "  1) Montar el socket del Docker del HOST en vez de instalar Docker"
  info "     adentro: agregá al 'docker run' que crea este contenedor"
  info "     -v /var/run/docker.sock:/var/run/docker.sock"
  info "  2) O crear el contenedor en modo --privileged para que pueda"
  info "     correr su propio demonio Docker anidado de verdad."
  REQUISITOS_OK=false
  return 1
}

fase 1 4 "Requisitos"
ensure_tool curl curl
ensure_tool gpg gnupg
ensure_node
ensure_docker
if ! $REQUISITOS_OK; then
  banner "$C_ROJO" "✘ Faltan requisitos que no se pudieron instalar solos." \
    "  Revisá los mensajes de arriba, instalalos a mano y volvé a correr este script."
  exit 1
fi

# 1. Preparar el .env -------------------------------------------------------
fase 2 4 "Configuración (.env)"
if [ -f .env ]; then
  ok ".env ya existe, se usa tal cual."
elif [ -f .env.gpg ]; then
  info "No hay .env, pero sí .env.gpg: descifrándolo (te va a pedir la passphrase)..."
  if gpg --quiet --output .env --decrypt .env.gpg; then
    ok ".env descifrado desde .env.gpg"
  else
    falla "No se pudo descifrar .env.gpg (¿passphrase incorrecta, o se canceló?)."
    info "Volvé a correr este script para intentarlo de nuevo."
    exit 1
  fi
else
  falla "No hay .env ni .env.gpg en $(pwd)."
  info "Copiá .env.example a .env y completá los valores (ver README, sección 3),"
  info "o pedí el .env.gpg + la passphrase a quien te comparta el proyecto."
  exit 1
fi

# 2. Analisis de seguridad completo (el mismo que corre en CI) --------------
fase 3 4 "Análisis de seguridad"
info "Los mismos controles que GitHub Actions. Puede tardar varios minutos:"
info "construye las 6 imágenes reales."
# El Ctrl+C lo reciben los dos scripts; pipeline-local.sh ya avisa.
SILENCIAR_CANCELADO=true
LIVEMETRIC_DESDE_START=1 ./scripts/pipeline-local.sh "${ARGS_PIPELINE[@]}"
PIPELINE_RC=$?
SILENCIAR_CANCELADO=false
if [ "$PIPELINE_RC" -ne 0 ]; then
  banner "$C_ROJO" "✘ El análisis encontró problemas: NO se levanta LiveMetric." \
    "  Corregí lo marcado con ✘ arriba y volvé a correr ./scripts/start.sh"
  exit 1
fi

# 3. Levantar el stack --------------------------------------------------------
fase 4 4 "Levantar LiveMetric"
COMPOSE_LOG="$(mktemp /tmp/livemetric-compose.XXXXXX)"
correr "$COMPOSE_LOG" "docker compose up --build (construye y arranca los contenedores)" \
  docker compose up -d --build
if [ $? -ne 0 ]; then
  falla "docker compose no pudo levantar el stack. Últimas líneas del log:"
  tail -n 15 "$COMPOSE_LOG" | sed "s/^/       ${C_GRIS}/; s/\$/${C_RESET}/"
  info "Log completo: $COMPOSE_LOG"
  exit 1
fi
ok "Contenedores creados."

# Espera (sin limite de tiempo mientras sigan arrancando) a que TODOS queden
# sanos, mostrando el estado de cada uno en vivo; ver el detalle en
# scripts/lib/esperar-contenedores.js.
echo ""
if ! node scripts/lib/esperar-contenedores.js; then
  banner "$C_ROJO" "✘ LiveMetric no quedó sano: revisá el motivo de cada contenedor arriba." \
    "  Logs en vivo: docker compose logs -f"
  exit 1
fi

# Con el contenedor del frontend sano, esto solo confirma que el puerto 3000
# tambien responde desde afuera de Docker (mapeo de puertos, firewall).
FRONTEND_OK=false
for _ in 1 2 3 4 5; do
  curl -sf http://127.0.0.1:3000 > /dev/null 2>&1 && { FRONTEND_OK=true; break; }
  sleep 1
done
# URL para otras PCs de la misma red (el frontend se publica en
# 0.0.0.0:3000). Dentro de WSL2 la IP de Linux es la de su VM interna, que
# las otras PCs no ven: ahi la que sirve es la de Windows.
if grep -qi microsoft /proc/version 2> /dev/null; then
  URL_RED="http://<IP de Windows>:3000 (verla con ipconfig en Windows)"
else
  IP_LAN="$(node scripts/lib/ip-local.js 2> /dev/null)"
  URL_RED="${IP_LAN:+http://$IP_LAN:3000}"
fi

if $FRONTEND_OK; then
  banner "$C_VERDE" "✔ LiveMetric está arriba" \
    "" \
    "  En esta PC:               http://localhost:3000" \
    "  Desde otra PC de la red:  ${URL_RED:-no se detectó una conexión de red}" \
    "  Logs en vivo:             docker compose logs -f"
else
  banner "$C_AMARILLO" "⚠ Los contenedores están sanos, pero http://localhost:3000 no responde desde el host." \
    "  Revisá que nada más use el puerto 3000 y los logs con: docker compose logs -f frontend"
fi

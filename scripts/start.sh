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
# Uso:
#   ./scripts/start.sh

set -uo pipefail

cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════════════════"
echo " LiveMetric - arranque con verificacion de seguridad"
echo "════════════════════════════════════════════════════════════"
echo ""

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
    echo "   ✓ $cmd ya está instalado."
    return 0
  fi
  if [ "$PKG_MGR" = "unknown" ]; then
    echo "   ✗ $cmd no está instalado, y no se detectó un gestor de paquetes"
    echo "     conocido (apt/dnf/yum/pacman/zypper/apk) para instalarlo solo."
    REQUISITOS_OK=false
    return 1
  fi
  echo "   $cmd no está instalado. Instalando con $PKG_MGR (${pkgs[*]})..."
  if install_pkg "${pkgs[@]}" && command -v "$cmd" &> /dev/null; then
    echo "   ✓ $cmd instalado correctamente."
  else
    echo "   ✗ no se pudo instalar $cmd automáticamente. Instalalo a mano."
    REQUISITOS_OK=false
  fi
}

ensure_node() {
  if command -v npm &> /dev/null; then
    echo "   ✓ npm ya está instalado."
    return 0
  fi
  if [ "$PKG_MGR" = "unknown" ]; then
    echo "   ✗ npm no está instalado, y no se detectó un gestor de paquetes"
    echo "     conocido para instalarlo solo."
    REQUISITOS_OK=false
    return 1
  fi
  # El paquete "nodejs" de dnf/yum ya incluye npm; en el resto de los
  # gestores hace falta pedir "npm" como paquete aparte.
  local pkgs=(nodejs npm)
  [ "$PKG_MGR" = "dnf" ] || [ "$PKG_MGR" = "yum" ] && pkgs=(nodejs)
  echo "   npm no está instalado. Instalando Node.js con $PKG_MGR..."
  if install_pkg "${pkgs[@]}" && command -v npm &> /dev/null; then
    echo "   ✓ npm instalado correctamente."
  else
    echo "   ✗ no se pudo instalar Node.js automáticamente. Instalalo a mano."
    REQUISITOS_OK=false
  fi
}

ensure_docker() {
  if ! command -v docker &> /dev/null; then
    echo "   Docker no está instalado. Instalando con el script oficial de Docker..."
    if curl -fsSL https://get.docker.com | $SUDO sh > /dev/null 2>&1; then
      echo "   ✓ Docker instalado."
    else
      echo "   ✗ no se pudo instalar Docker automáticamente. Instalalo a mano:"
      echo "     https://docs.docker.com/engine/install/"
      REQUISITOS_OK=false
      return 1
    fi
  fi

  if docker info &> /dev/null; then
    echo "   ✓ Docker está instalado y el motor responde."
    return 0
  fi

  # El motor no responde. Si hay systemd corriendo como PID 1, se puede
  # arrancar el servicio asi; si no (el caso tipico de estar corriendo este
  # script DENTRO de un contenedor, donde el propio PID 1 nunca es
  # systemd), "systemctl" no tiene con que hablar y falla con un error que
  # no tiene nada que ver con Docker.
  if [ -d /run/systemd/system ] && command -v systemctl &> /dev/null; then
    echo "   Docker está instalado pero el motor no responde. Iniciando el servicio..."
    if $SUDO systemctl start docker 2>/dev/null && sleep 2 && docker info &> /dev/null; then
      echo "   ✓ Motor de Docker iniciado correctamente."
      return 0
    fi
    echo "   ✗ no se pudo iniciar el servicio de Docker. Probá a mano:"
    echo "     sudo systemctl start docker"
    echo "     (y si el problema es de permisos: sudo usermod -aG docker \$USER,"
    echo "     después cerrá sesión y volvé a entrar para que tome efecto)."
    REQUISITOS_OK=false
    return 1
  fi

  # Sin systemd: probablemente estamos dentro de un contenedor. Se intenta
  # arrancar el demonio directamente, sin depender de un sistema de init -
  # esto SOLO puede funcionar si el contenedor ya tiene los privilegios
  # necesarios para correr Docker anidado (--privileged o capacidades
  # equivalentes), algo que este script no puede otorgarse a si mismo.
  echo "   Docker está instalado pero el motor no responde, y no hay systemd"
  echo "   para arrancarlo como servicio (parece que este script está"
  echo "   corriendo dentro de un contenedor). Probando arrancar dockerd"
  echo "   directamente..."
  $SUDO dockerd > /tmp/dockerd.log 2>&1 &
  disown
  for _ in $(seq 1 10); do
    sleep 1
    if docker info &> /dev/null; then
      echo "   ✓ Motor de Docker iniciado correctamente (dockerd en segundo plano)."
      return 0
    fi
  done

  echo "   ✗ no se pudo iniciar el motor de Docker (detalle en /tmp/dockerd.log)."
  echo "     Si este script está corriendo DENTRO de un contenedor Docker, hace"
  echo "     falta que ESE contenedor tenga acceso real a Docker - algo que hay"
  echo "     que resolver desde afuera, no algo que este script pueda arreglar"
  echo "     por si solo. Las dos formas correctas son:"
  echo "       1) Montar el socket del Docker del HOST en vez de instalar Docker"
  echo "          adentro: agregá al 'docker run' que crea este contenedor"
  echo "          -v /var/run/docker.sock:/var/run/docker.sock"
  echo "       2) O crear el contenedor en modo --privileged para que pueda"
  echo "          correr su propio demonio Docker anidado de verdad."
  REQUISITOS_OK=false
  return 1
}

echo "-- Requisitos --------------------------------------------------------"
ensure_tool curl curl
ensure_tool gpg gnupg
ensure_node
ensure_docker
if ! $REQUISITOS_OK; then
  echo ""
  echo "❌ Faltan requisitos que no se pudieron instalar solos. Revisa los"
  echo "   mensajes de arriba, instalalos a mano, y volvé a correr este script."
  exit 1
fi
echo ""

# 1. Preparar el .env -------------------------------------------------------
if [ ! -f .env ]; then
  if [ -f .env.gpg ]; then
    echo "No hay .env, pero si .env.gpg. Descifrando (te pedira la passphrase)..."
    if ! gpg --output .env --decrypt .env.gpg; then
      echo "Error: no se pudo descifrar .env.gpg (¿passphrase incorrecta?)." >&2
      exit 1
    fi
  else
    echo "Error: no hay .env ni .env.gpg en $(pwd)." >&2
    echo "Copia .env.example a .env y completa los valores (ver README, seccion 3)," >&2
    echo "o pedi el .env.gpg + la passphrase a quien te comparta el proyecto." >&2
    exit 1
  fi
else
  echo "✓ .env ya existe, se usa tal cual."
fi
echo ""

# 2. Analisis de seguridad completo (el mismo que corre en CI) --------------
echo "════════════════════════════════════════════════════════════"
echo " Analisis de seguridad (Gitleaks, Semgrep, SCA, Trivy, pruebas)"
echo " Esto puede tardar varios minutos - construye las 6 imagenes reales."
echo "════════════════════════════════════════════════════════════"
echo ""
if ! ./scripts/pipeline-local.sh; then
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "❌ El analisis encontro problemas. NO se levantan los contenedores."
  echo "   Revisa el detalle de arriba (cada linea en rojo indica donde"
  echo "   esta el log completo) antes de volver a intentarlo."
  echo "════════════════════════════════════════════════════════════"
  exit 1
fi
echo ""

# 3. Levantar el stack --------------------------------------------------------
echo "════════════════════════════════════════════════════════════"
echo " Todo en verde. Levantando el stack (docker compose up --build)..."
echo "════════════════════════════════════════════════════════════"
docker compose up -d --build

echo ""
echo "Esperando a que el frontend responda..."
FRONTEND_UP=false
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000 > /dev/null 2>&1; then
    FRONTEND_UP=true
    break
  fi
  sleep 2
done

echo ""
echo "════════════════════════════════════════════════════════════"
echo " Contenedores (docker ps)"
echo "════════════════════════════════════════════════════════════"
docker ps --filter "name=livemetric-" \
  --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
if $FRONTEND_UP; then
  echo "════════════════════════════════════════════════════════════"
  echo "✅ LiveMetric esta arriba."
  echo ""
  echo "   Frontend:  http://localhost:3000"
  echo ""
  echo "   Logs en vivo:  docker compose logs -f"
  echo "════════════════════════════════════════════════════════════"
else
  echo "⚠️  El stack se levanto pero el frontend todavia no respondio a"
  echo "   tiempo. Revisa el estado con: docker ps"
  echo "   y los logs con:               docker compose logs -f"
fi

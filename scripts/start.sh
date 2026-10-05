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
# Requisitos (se intentan instalar solos si faltan): Docker, curl,
# Node.js/npm. La instalacion automatica detecta el gestor de paquetes
# (apt/dnf/yum/pacman/zypper/apk) y usa "sudo" si no se corre como root;
# Docker se instala con el script oficial (get.docker.com), igual que
# recomienda la propia documentacion de Docker.
#
# Con LiveMetric arriba levanta tambien el monitoreo (monitoring/):
# Prometheus, Grafana, Loki, cAdvisor y, en Linux, Falco. Grafana y
# Prometheus se publican SOLO en 127.0.0.1: no se alcanzan desde la red.
# Tiene los mismos comandos que scripts/contenedor.sh para verlo, cambiar la
# contraseña del administrador o apagarlo, aca sobre el Docker de la PC.
#
# Uso:
#   ./scripts/start.sh [iniciar] [--detalle]   instala lo que falte, analiza y levanta todo
#                                              (--detalle: además, la salida real de cada herramienta)
#   ./scripts/start.sh estado                  estado de cada contenedor
#   ./scripts/start.sh logs [servicio]         logs en vivo (también: logs falco, logs grafana...)
#   ./scripts/start.sh shell [servicio]        terminal dentro de un microservicio (sin servicio, auth-service)
#   ./scripts/start.sh admin [usuario]         cambia la contraseña de una cuenta del panel (sin usuario,
#                                              pregunta cuál; si no hay administrador, crea el primero)
#   ./scripts/start.sh detener                 apaga LiveMetric y el monitoreo (los datos quedan)
#   ./scripts/start.sh borrar                  además borra sus volúmenes (con la BASE DE DATOS) y sus imágenes
#
#   LIVEMETRIC_PUERTO=3100 ./scripts/start.sh   usa otro puerto de la PC
#   LIVEMETRIC_PUERTO_GRAFANA=3011 LIVEMETRIC_PUERTO_PROMETHEUS=9091 ./scripts/start.sh
#                                               otros puertos para el monitoreo
#   LIVEMETRIC_MONITOREO=0 ./scripts/start.sh   sin el monitoreo
#   LIVEMETRIC_FALCO=0 ./scripts/start.sh       con el monitoreo, pero sin Falco

set -uo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/ui.sh
source scripts/lib/ui.sh

PUERTO="${LIVEMETRIC_PUERTO:-3000}"
PUERTO_GRAFANA="${LIVEMETRIC_PUERTO_GRAFANA:-3010}"
PUERTO_PROMETHEUS="${LIVEMETRIC_PUERTO_PROMETHEUS:-9090}"
MONITOREO="${LIVEMETRIC_MONITOREO:-1}"
FALCO="${LIVEMETRIC_FALCO:-1}"
# docker compose toma de aca los puertos que publica (ver docker-compose.yml
# y monitoring/docker-compose.monitoring.yml).
export LIVEMETRIC_PUERTO="$PUERTO" LIVEMETRIC_PUERTO_GRAFANA="$PUERTO_GRAFANA" \
  LIVEMETRIC_PUERTO_PROMETHEUS="$PUERTO_PROMETHEUS"

# El monitoreo es otro proyecto de compose, aparte de la aplicacion: el
# monitoreo no debe poder tumbar lo que monitorea. --profile falco para que
# "down", "ps" y "logs" incluyan a Falco; al levantarlo, el perfil va solo
# si se puede.
MONITOREO_COMPOSE=(docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml)
SERVICIOS_MONITOREO=" prometheus grafana loki promtail cadvisor blackbox-exporter falco "
NOMBRE_GLOBAL=livemetric-global

# "docker compose exec" reserva una terminal: sin una de verdad
# (redirigido, CI) falla con "the input device is not a TTY".
ARGS_EXEC=()
{ [ -t 0 ] && [ -t 1 ]; } || ARGS_EXEC=(-T)

uso() { sed -n '/^# Uso:/,/^$/s/^# \{0,1\}//p' "$0"; }

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

# Para los subcomandos: Docker ya tiene que estar, no se instala nada.
requiere_docker() {
  if ! command -v docker &> /dev/null || ! docker info &> /dev/null; then
    falla "Docker no está instalado o el motor no responde: ./scripts/start.sh lo instala o lo inicia."
    exit 1
  fi
}

requiere_corriendo() {
  if [ -z "$(docker compose ps -q 2> /dev/null)" ]; then
    falla "LiveMetric no está corriendo. Arrancalo con: ./scripts/start.sh"
    exit 1
  fi
}

puerto_ocupado() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }

# puerto_disponible <puerto> <para que> <contenedor de LiveMetric que lo publica>
# Si el puerto lo usa ese mismo contenedor (una corrida anterior de este
# script), sirve: docker compose lo reemplaza. Si lo usa otra cosa, falla
# aca y no despues de todo el analisis.
puerto_disponible() {
  local puerto="$1" uso="$2" propio="$3" ocupantes
  if ! puerto_ocupado "$puerto"; then
    ok "Puerto $puerto libre ($uso)"
    return 0
  fi
  ocupantes="$(docker ps --filter "publish=$puerto" --format '{{.Names}}' | tr '\n' ' ')"
  if [ "$ocupantes" = "$propio " ]; then
    ok "Puerto $puerto ($uso): lo usa LiveMetric de una corrida anterior, se reemplaza"
    return 0
  fi
  falla "El puerto $puerto ($uso) ya está en uso en esta PC."
  if [[ " $ocupantes" == *" $NOMBRE_GLOBAL "* ]]; then
    info "Lo usa LiveMetric dentro del contenedor global (./scripts/contenedor.sh)."
    info "Apagalo con: ./scripts/contenedor.sh detener"
  elif [ -n "$ocupantes" ]; then
    info "Lo usa: $ocupantes"
  fi
  return 1
}

# Falco instrumenta el kernel con eBPF: necesita Linux con BTF, y no la VM
# de Docker Desktop (Windows con WSL2 o macOS), donde no hay garantias.
falco_posible() {
  [ "$MONITOREO" != 0 ] && [ "$FALCO" != 0 ] && [ "$(uname -s)" = Linux ] \
    && ! grep -qi microsoft /proc/version 2> /dev/null && [ -e /sys/kernel/btf/vmlinux ]
}

esperar_grafana() {
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PUERTO_GRAFANA/api/health" > /dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Primero el monitoreo: esta conectado a la red de la aplicacion, que si no
# no se puede borrar al bajarla.
bajar_monitoreo() { "${MONITOREO_COMPOSE[@]}" --profile falco down "$@"; }
monitoreo_creado() { "${MONITOREO_COMPOSE[@]}" --profile falco ps -a -q 2> /dev/null; }

# compose_de <servicio> <args...> - docker compose del proyecto al que
# pertenece <servicio>: el del monitoreo o el de la aplicacion.
compose_de() {
  local servicio="$1"; shift
  if [ -n "$servicio" ] && [[ "$SERVICIOS_MONITOREO" == *" $servicio "* ]]; then
    "${MONITOREO_COMPOSE[@]}" --profile falco "$@"
  else
    docker compose "$@"
  fi
}

iniciar() {
  local FASES=4
  [ "$MONITOREO" != 0 ] && FASES=5
  banner "$C_AZUL" "LiveMetric · arranque con verificación de seguridad"

  # 1. Requisitos y puertos ---------------------------------------------------
  fase 1 "$FASES" "Requisitos"
  ensure_tool curl curl
  ensure_node
  ensure_docker
  if ! $REQUISITOS_OK; then
    banner "$C_ROJO" "✘ Faltan requisitos que no se pudieron instalar solos." \
      "  Revisá los mensajes de arriba, instalalos a mano y volvé a correr este script."
    exit 1
  fi

  if ! puerto_disponible "$PUERTO" "LiveMetric" livemetric-frontend; then
    info "O usá otro puerto: LIVEMETRIC_PUERTO=3100 ./scripts/start.sh"
    exit 1
  fi
  if [ "$MONITOREO" != 0 ]; then
    if ! puerto_disponible "$PUERTO_GRAFANA" "Grafana" livemetric-grafana \
        || ! puerto_disponible "$PUERTO_PROMETHEUS" "Prometheus" livemetric-prometheus; then
      info "O usá otros puertos: LIVEMETRIC_PUERTO_GRAFANA=3011 LIVEMETRIC_PUERTO_PROMETHEUS=9091 ./scripts/start.sh"
      info "O sin monitoreo: LIVEMETRIC_MONITOREO=0 ./scripts/start.sh"
      exit 1
    fi
  fi

  # 2. Preparar el .env -------------------------------------------------------
  # Cada instalación tiene su propia base y sus propias claves: si no hay .env,
  # se genera con secretos aleatorios; si ya hay uno, solo se le agregan las
  # variables nuevas que falten (nunca se pisa un valor existente).
  fase 2 "$FASES" "Configuración (.env)"
  local resultado_env
  if ! resultado_env="$(node scripts/lib/generar-env.js)"; then
    falla "No se pudo preparar el .env."
    exit 1
  fi
  ok "$resultado_env"

  # 3. Analisis de seguridad completo (el mismo que corre en CI) --------------
  fase 3 "$FASES" "Análisis de seguridad"
  info "Los mismos controles que GitHub Actions. Puede tardar varios minutos:"
  info "construye las 6 imágenes reales."
  # El Ctrl+C lo reciben los dos scripts; pipeline-local.sh ya avisa.
  SILENCIAR_CANCELADO=true
  LIVEMETRIC_DESDE_START=1 ./scripts/pipeline-local.sh "${ARGS_PIPELINE[@]}"
  local rc=$?
  SILENCIAR_CANCELADO=false
  if [ "$rc" -ne 0 ]; then
    banner "$C_ROJO" "✘ El análisis encontró problemas: NO se levanta LiveMetric." \
      "  Corregí lo marcado con ✘ arriba y volvé a correr ./scripts/start.sh"
    exit 1
  fi

  # 4. Levantar el stack --------------------------------------------------------
  fase 4 "$FASES" "Levantar LiveMetric"
  local log_compose
  log_compose="$(mktemp /tmp/livemetric-compose.XXXXXX)"
  # La fecha del día invalida la capa de "apk upgrade" de un build de otro día
  # (ver ARG ACTUALIZAR_PAQUETES en los Dockerfile y docker-compose.yml).
  correr "$log_compose" "docker compose up --build (construye y arranca los contenedores)" \
    env ACTUALIZAR_PAQUETES="$(date +%F)" docker compose up -d --build
  if [ $? -ne 0 ]; then
    falla "docker compose no pudo levantar el stack. Últimas líneas del log:"
    tail -n 15 "$log_compose" | sed "s/^/       ${C_GRIS}/; s/\$/${C_RESET}/"
    info "Log completo: $log_compose"
    exit 1
  fi
  ok "Contenedores creados."

  # Espera (sin limite de tiempo mientras sigan arrancando) a que TODOS queden
  # sanos, mostrando el estado de cada uno en vivo; ver el detalle en
  # scripts/lib/esperar-contenedores.js.
  echo ""
  if ! node scripts/lib/esperar-contenedores.js; then
    banner "$C_ROJO" "✘ LiveMetric no quedó sano: revisá el motivo de cada contenedor arriba." \
      "  Logs en vivo: ./scripts/start.sh logs"
    exit 1
  fi

  # Primer administrador: en una base nueva no hay ninguno (el repositorio no
  # trae credenciales), así que se ofrece crearlo acá mismo. Si ya hay alguno,
  # crearAdmin.js --si-no-hay no hace nada. Necesita una terminal para pedir
  # la contraseña; sin ella (por ejemplo, en CI) solo se indica cómo hacerlo.
  # Si no se pudo crear (por ejemplo, tres contraseñas inseguras), el stack ya
  # está arriba igual: se avisa al final, bien visible, en lugar de seguir como
  # si nada. Sin administrador no se puede entrar al panel.
  echo ""
  local sin_admin=false
  if [ -t 0 ] && [ -t 1 ]; then
    docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay || sin_admin=true
  else
    info "Si todavía no hay ningún administrador, créalo con: ./scripts/start.sh admin"
  fi

  # 5. Monitoreo ---------------------------------------------------------------
  local lineas_monitoreo=()
  if [ "$MONITOREO" != 0 ]; then
    fase 5 "$FASES" "Monitoreo"
    local perfil=() falco="no disponible en este sistema (necesita Linux con eBPF)"
    [ "$FALCO" = 0 ] && falco="desactivado (LIVEMETRIC_FALCO=0)"
    if falco_posible; then
      perfil=(--profile falco)
      falco="alertas en el tablero de Grafana"
    else
      # Falco de una corrida anterior, cuando ahora no va.
      "${MONITOREO_COMPOSE[@]}" --profile falco rm -sf falco > /dev/null 2>&1
    fi
    local log_monitoreo
    log_monitoreo="$(mktemp /tmp/livemetric-monitoreo.XXXXXX)"
    if correr "$log_monitoreo" "Levantando Prometheus, Grafana, Loki, cAdvisor${perfil[*]:+ y Falco}" \
        "${MONITOREO_COMPOSE[@]}" "${perfil[@]}" up -d \
      && correr /dev/null "Esperando a Grafana" esperar_grafana; then
      ok "Monitoreo en marcha${perfil[*]:+, con Falco}"
      lineas_monitoreo=(
        ""
        "  Monitoreo (solo desde esta PC):"
        "    Grafana:     http://localhost:$PUERTO_GRAFANA   (usuario y contraseña: grep GRAFANA .env)"
        "    Prometheus:  http://localhost:$PUERTO_PROMETHEUS"
        "    Loki:        en Grafana, Explore → Loki"
        "    Falco:       $falco"
      )
    else
      aviso "El monitoreo no arrancó; LiveMetric sí está arriba. Log: $log_monitoreo"
    fi
  fi

  # Con el contenedor del frontend sano, esto solo confirma que el puerto
  # tambien responde desde afuera de Docker (mapeo de puertos, firewall).
  local frontend_ok=false
  for _ in 1 2 3 4 5; do
    curl -sf "http://127.0.0.1:$PUERTO" > /dev/null 2>&1 && { frontend_ok=true; break; }
    sleep 1
  done
  # URL para otras PCs de la misma red (el frontend se publica en
  # 0.0.0.0). Dentro de WSL2 la IP de Linux es la de su VM interna, que
  # las otras PCs no ven: ahi la que sirve es la de Windows.
  local url_red ip_lan
  if grep -qi microsoft /proc/version 2> /dev/null; then
    url_red="http://<IP de Windows>:$PUERTO (verla con ipconfig en Windows)"
  else
    ip_lan="$(node scripts/lib/ip-local.js 2> /dev/null)"
    url_red="${ip_lan:+http://$ip_lan:$PUERTO}"
  fi

  if $frontend_ok; then
    banner "$C_VERDE" "✔ LiveMetric está arriba" \
      "" \
      "  En esta PC:               http://localhost:$PUERTO" \
      "  Desde otra PC de la red:  ${url_red:-no se detectó una conexión de red}" \
      "${lineas_monitoreo[@]}" \
      "" \
      "  ./scripts/start.sh estado    estado de cada microservicio" \
      "  ./scripts/start.sh logs      logs en vivo (o: logs auth-service)" \
      "  ./scripts/start.sh shell     terminal dentro de un microservicio" \
      "  ./scripts/start.sh admin     cambiar la contraseña del administrador" \
      "  ./scripts/start.sh detener   apagar todo"
  else
    banner "$C_AMARILLO" "⚠ Los contenedores están sanos, pero http://localhost:$PUERTO no responde desde el host." \
      "  Revisá que nada más use el puerto $PUERTO y los logs con: ./scripts/start.sh logs frontend"
  fi

  if $sin_admin; then
    banner "$C_AMARILLO" "⚠ No se creó el administrador: sin él no se puede entrar al panel." \
      "  Créalo con una contraseña segura:  ./scripts/start.sh admin"
  fi
}

estado() {
  requiere_docker
  requiere_corriendo
  ok "LiveMetric en marcha (puerto $PUERTO)"
  echo ""
  # Los de la aplicacion y, si esta arriba, los del monitoreo: todos se
  # llaman livemetric-*, menos el contenedor global (otro modo).
  docker ps -a --filter name=livemetric- --format 'table {{.Names}}\t{{.Status}}' \
    | grep -v "^$NOMBRE_GLOBAL " | sed 's/^/     /'
  if docker ps -q --filter name=livemetric-grafana | grep -q .; then
    echo ""
    info "Grafana: http://localhost:$PUERTO_GRAFANA · Prometheus: http://localhost:$PUERTO_PROMETHEUS (solo desde esta PC)"
  fi
}

detener() {
  requiere_docker
  if [ -z "$(docker compose ps -a -q 2> /dev/null)$(monitoreo_creado)" ]; then
    ok "LiveMetric no estaba levantado: nada que apagar."
    return
  fi
  correr /dev/null "Apagando el monitoreo" bajar_monitoreo
  correr /dev/null "Apagando los microservicios" docker compose down --remove-orphans
  ok "LiveMetric apagado. La base de datos y el historial del monitoreo quedan en sus volúmenes."
}

borrar() {
  # Los volumenes guardan la base de datos: pedir confirmación si hay
  # alguien para darla.
  if [ -t 0 ]; then
    aviso "Esto borra también la base de datos de esta instalación (elecciones, padrón, actas)"
    info "y el historial del monitoreo. El .env queda."
    read -r -p "     ¿Seguro? [s/N] " respuesta
    case "$respuesta" in
      [sS] | [sS][iIíÍ]) ;;
      *) info "No se borró nada."; return 0 ;;
    esac
  fi
  requiere_docker
  correr /dev/null "Borrando el monitoreo y su historial" bajar_monitoreo -v
  # --rmi local: las imagenes que construyó docker compose, no las
  # descargadas (postgres), que pueden ser de otros proyectos.
  correr /dev/null "Borrando los microservicios, la base de datos y sus imágenes" \
    docker compose down -v --rmi local --remove-orphans
  ok "LiveMetric borrado: contenedores, volúmenes (con la base de datos) e imágenes construidas."
  return 0
}

COMANDO="iniciar"
case "${1:-}" in
  iniciar|estado|logs|shell|admin|detener|borrar) COMANDO="$1"; shift ;;
  -h|--help) uso; exit 0 ;;
esac

case "$COMANDO" in
  iniciar)
    ARGS_PIPELINE=()
    for arg in "$@"; do
      case "$arg" in
        -d|--detalle) DETALLE=true; ARGS_PIPELINE+=(--detalle) ;;
        *) echo "Opción desconocida: $arg (ver --help)" >&2; exit 2 ;;
      esac
    done
    iniciar
    ;;
  estado) estado ;;
  logs)
    requiere_docker
    requiere_corriendo
    compose_de "${1:-}" logs -f "$@"
    ;;
  shell)
    requiere_docker
    requiere_corriendo
    compose_de "${1:-auth-service}" exec "${ARGS_EXEC[@]}" "${1:-auth-service}" sh
    ;;
  admin)
    # Cambiar la contraseña de una cuenta (o crear el primer administrador):
    # services/auth/src/scripts/cambiarContrasena.js.
    requiere_docker
    requiere_corriendo
    if [ ! -t 0 ] || [ ! -t 1 ]; then
      falla "Necesita una terminal: pide la contraseña sin mostrarla."
      exit 1
    fi
    docker compose exec auth-service node src/scripts/cambiarContrasena.js "$@"
    ;;
  detener) detener ;;
  borrar) borrar ;;
esac

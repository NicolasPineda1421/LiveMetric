#!/usr/bin/env bash
# LiveMetric - Otra opcion de despliegue, ademas de scripts/start.sh: todo
# el proyecto dentro de UN contenedor ("contenedor global") que tiene su
# propio motor de Docker adentro. Hace lo mismo que start.sh - el mismo
# analisis de seguridad (scripts/pipeline-local.sh) y, solo si pasa, el
# mismo docker-compose.yml - pero todo corre DENTRO del contenedor global:
# los 7 contenedores del stack quedan adentro, no en el host. En el host
# solo hace falta Docker: este script no instala ni modifica nada del
# sistema operativo. (start.sh / start.bat no se usan ni se tocan.)
#
# Como funciona (ver tambien infra/contenedor-global/Dockerfile):
#   - La imagen "livemetric-global" lleva una copia del codigo actual (sin
#     el .env real ni node_modules) y las herramientas que el analisis usa
#     (Node.js, etc.), que asi no hace falta instalar en el host.
#   - El contenedor corre con --privileged: es lo que exige un motor de
#     Docker dentro de un contenedor (redes, capas, cgroups). Es la contra
#     de este modo: ese contenedor tiene acceso amplio al kernel del host.
#   - Las imagenes que se construyen adentro y la base de datos del stack
#     quedan en el volumen "livemetric-global-docker": la proxima vez no se
#     rehace todo, y los datos sobreviven a "detener".
#   - El frontend de adentro se publica en el puerto LIVEMETRIC_PUERTO del
#     host (3000 por defecto), abierto a la red local igual que con start.sh.
#   - El .env queda en esta carpeta (se genera con secretos aleatorios la
#     primera vez) y se monta en solo lectura: nunca entra en la imagen, y
#     sobrevive a que se recree el contenedor global, igual que la base.
#   - --restart unless-stopped: si la PC se reinicia, el contenedor global
#     vuelve solo, y con el los microservicios.
#   - Adentro corre tambien el monitoreo (monitoring/): Prometheus, Grafana,
#     Loki, cAdvisor y, en Linux, Falco. Tiene que ser adentro: se conecta a
#     la red livemetric_app-net, que en este modo solo existe ahi. Grafana y
#     Prometheus se publican en la PC SOLO en 127.0.0.1 (no desde la red),
#     igual que con start.sh; ver infra/contenedor-global/monitoreo.override.yml.
#   - Con Falco, el contenedor global corre ademas con --pid=host: Falco
#     recibe del kernel los numeros de proceso de la PC y completa cada
#     evento leyendo /proc; con el /proc propio del contenedor, esos numeros
#     son de otros procesos, y atribuia a los servicios cosas que hacia la PC
#     (escrituras de AppArmor o systemd como si fueran de scrutiny). La
#     contra: el contenedor global ve los procesos de la PC, lo que suma poco
#     a lo que ya permite --privileged. LIVEMETRIC_FALCO=0 lo evita (sin Falco).
#
# Uso:
#   ./scripts/contenedor.sh [iniciar] [--detalle]   construye, analiza y levanta todo adentro
#   ./scripts/contenedor.sh estado                  estado de cada contenedor de adentro
#   ./scripts/contenedor.sh logs [servicio]         logs en vivo del stack de adentro (también: logs falco, logs grafana...)
#   ./scripts/contenedor.sh shell                   terminal dentro del contenedor global
#   ./scripts/contenedor.sh detener                 apaga el contenedor global y todo lo de adentro
#   ./scripts/contenedor.sh borrar                  ademas borra su imagen y su volumen (con la BASE DE DATOS)
#
#   LIVEMETRIC_PUERTO=3100 ./scripts/contenedor.sh   usa otro puerto del host
#   LIVEMETRIC_PUERTO_GRAFANA=3011 LIVEMETRIC_PUERTO_PROMETHEUS=9091 ./scripts/contenedor.sh
#                                                    otros puertos para el monitoreo
#   LIVEMETRIC_MONITOREO=0 ./scripts/contenedor.sh   sin el monitoreo
#   LIVEMETRIC_FALCO=0 ./scripts/contenedor.sh       con el monitoreo, pero sin Falco (ni --pid=host)

set -uo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/ui.sh
source scripts/lib/ui.sh

NOMBRE=livemetric-global
IMAGEN=livemetric-global
VOLUMEN=livemetric-global-docker
PUERTO="${LIVEMETRIC_PUERTO:-3000}"
PUERTO_GRAFANA="${LIVEMETRIC_PUERTO_GRAFANA:-3010}"
PUERTO_PROMETHEUS="${LIVEMETRIC_PUERTO_PROMETHEUS:-9090}"
MONITOREO="${LIVEMETRIC_MONITOREO:-1}"
FALCO="${LIVEMETRIC_FALCO:-1}"

# El compose del monitoreo, tal como se usa adentro: con el ajuste de puertos
# y containerd del contenedor global. --profile falco para que "down" y
# "ps" incluyan a Falco; al levantarlo, el perfil va solo si se puede.
MONITOREO_COMPOSE=(docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml
  -f infra/contenedor-global/monitoreo.override.yml)
SERVICIOS_MONITOREO=" prometheus grafana loki promtail cadvisor blackbox-exporter falco "

uso() { sed -n '/^# Uso:/,/^$/s/^# \{0,1\}//p' "$0"; }

corriendo() { [ "$(docker container inspect -f '{{.State.Running}}' "$NOMBRE" 2> /dev/null)" = true ]; }

requiere_corriendo() {
  if ! corriendo; then
    falla "El contenedor global no está corriendo. Arrancalo con: ./scripts/contenedor.sh"
    exit 1
  fi
}

# "-it" solo si hay una terminal de verdad: sin ella (redirigido, CI)
# "docker exec -t" falla con "the input device is not a TTY".
ARGS_TTY=()
[ -t 0 ] && ARGS_TTY+=(-i)
[ -t 0 ] && [ -t 1 ] && ARGS_TTY+=(-t)

requiere_docker() {
  if ! command -v docker &> /dev/null; then
    falla "Docker no está instalado. Es lo único que este modo necesita en la PC:"
    info "https://docs.docker.com/engine/install/ (o Docker Desktop en Windows/macOS)"
    exit 1
  fi
  if ! docker info &> /dev/null; then
    falla "Docker está instalado pero el motor no responde."
    info "Linux: sudo systemctl start docker · Windows/macOS: abrí Docker Desktop"
    exit 1
  fi
}

# URL con la que otras PCs de la red llegan al frontend: la IP de ESTA PC
# (la de la ruta hacia afuera, como "ip route get") y el puerto publicado.
# Se calcula aca, en el host, porque desde adentro del contenedor global
# solo se ve la IP del contenedor.
url_red() {
  if grep -qi microsoft /proc/version 2> /dev/null; then
    # En WSL2 la IP de Linux es la de su VM interna: la que sirve es la de Windows.
    echo "http://<IP de Windows>:$PUERTO (verla con ipconfig en Windows)"
    return
  fi
  local ip="" interfaz
  if command -v ip &> /dev/null; then
    ip="$(ip route get 1.1.1.1 2> /dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  elif command -v route &> /dev/null && command -v ipconfig &> /dev/null; then  # macOS
    interfaz="$(route -n get 1.1.1.1 2> /dev/null | awk '/interface:/ {print $2}')"
    [ -n "$interfaz" ] && ip="$(ipconfig getifaddr "$interfaz" 2> /dev/null)"
  fi
  [ -n "$ip" ] && echo "http://$ip:$PUERTO"
}

esperar_motor_interno() {
  for _ in $(seq 1 60); do
    docker exec "$NOMBRE" docker info > /dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

puerto_ocupado() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }

# Falco instrumenta el kernel con eBPF: necesita Linux con BTF, y no la VM
# de Docker Desktop (Windows con WSL2 o macOS), donde no hay garantias.
falco_posible() {
  [ "$MONITOREO" != 0 ] && [ "$FALCO" != 0 ] && [ "$(uname -s)" = Linux ] \
    && ! grep -qi microsoft /proc/version 2> /dev/null && [ -e /sys/kernel/btf/vmlinux ]
}

esperar_grafana() {
  for _ in $(seq 1 60); do
    docker exec "$NOMBRE" wget -qO- http://127.0.0.1:3010/api/health > /dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Primero el monitoreo: esta conectado a la red de la aplicacion, que si no
# no se puede borrar al bajarla.
bajar_monitoreo() {
  docker exec "$NOMBRE" "${MONITOREO_COMPOSE[@]}" --profile falco down > /dev/null 2>&1
}

# docker exec con los mismos -i/-t que la terminal de este script.
adentro() { docker exec "${ARGS_TTY[@]}" "$NOMBRE" "$@"; }

iniciar() {
  local FASES=4
  [ "$MONITOREO" != 0 ] && FASES=5
  banner "$C_AZUL" "LiveMetric · contenedor global (el proyecto entero dentro de Docker)"

  # 1. Docker en esta PC ------------------------------------------------------
  fase 1 "$FASES" "Docker en esta PC"
  requiere_docker
  ok "Docker (el motor responde)"

  if docker container inspect "$NOMBRE" &> /dev/null; then
    aviso "Ya había un contenedor global: se reemplaza por uno nuevo con el código actual."
    docker rm -f "$NOMBRE" > /dev/null
  fi

  if puerto_ocupado "$PUERTO"; then
    falla "El puerto $PUERTO ya está en uso en esta PC."
    local ocupantes
    ocupantes="$(docker ps --filter "publish=$PUERTO" --format '{{.Names}}' | tr '\n' ' ')"
    if [[ "$ocupantes" == *livemetric-* ]]; then
      info "Lo usa LiveMetric corriendo directo en el host (./scripts/start.sh): $ocupantes"
      info "Bajalo con: docker compose down"
    elif [ -n "$ocupantes" ]; then
      info "Lo usa: $ocupantes"
    fi
    info "O usá otro puerto: LIVEMETRIC_PUERTO=3100 ./scripts/contenedor.sh"
    exit 1
  fi
  ok "Puerto $PUERTO libre"

  local publicar=(-p "$PUERTO:3000")
  if [ "$MONITOREO" != 0 ]; then
    local p
    for p in "$PUERTO_GRAFANA" "$PUERTO_PROMETHEUS"; do
      if puerto_ocupado "$p"; then
        falla "El puerto $p (monitoreo) ya está en uso en esta PC."
        if [ -n "$(docker ps -q --filter name=livemetric-grafana --filter name=livemetric-prometheus)" ]; then
          info "Lo usa el monitoreo corriendo directo en el host. Bajalo con:"
          info "  docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml --profile falco down"
        fi
        info "O usá otros puertos: LIVEMETRIC_PUERTO_GRAFANA=3011 LIVEMETRIC_PUERTO_PROMETHEUS=9091 ./scripts/contenedor.sh"
        info "O sin monitoreo: LIVEMETRIC_MONITOREO=0 ./scripts/contenedor.sh"
        exit 1
      fi
    done
    # Solo en 127.0.0.1: el monitoreo no se alcanza desde otra PC.
    publicar+=(-p "127.0.0.1:$PUERTO_GRAFANA:3010" -p "127.0.0.1:$PUERTO_PROMETHEUS:9090")
    ok "Puertos $PUERTO_GRAFANA (Grafana) y $PUERTO_PROMETHEUS (Prometheus) libres"
  fi
  # Falco necesita el /proc de la PC (ver arriba). Sin ser el proceso 1, tini
  # (el init de la imagen) tiene que registrarse para recoger los huérfanos.
  local procesos=()
  falco_posible && procesos=(--pid=host -e TINI_SUBREAPER=1)

  # 2. Contenedor global ------------------------------------------------------
  fase 2 "$FASES" "Contenedor global"
  local log_build
  log_build="$(mktemp /tmp/livemetric-global-build.XXXXXX)"
  correr "$log_build" "Construyendo la imagen $IMAGEN" \
    docker build -f infra/contenedor-global/Dockerfile -t "$IMAGEN" .
  if [ $? -ne 0 ]; then
    falla "No se pudo construir la imagen $IMAGEN. Últimas líneas del log:"
    tail -n 15 "$log_build" | sed "s/^/       ${C_GRIS}/; s/\$/${C_RESET}/"
    info "Log completo: $log_build"
    exit 1
  fi
  ok "Imagen $IMAGEN construida con el código actual (sin el .env)"

  # El .env tiene que quedar en ESTA carpeta y no solo dentro del contenedor:
  # la base vive en el volumen y sobrevive a que se recree el contenedor, y
  # con claves nuevas quedaría con otra contraseña y el padrón ilegible. Se
  # genera con la misma imagen (en el host no hace falta Node.js), con el
  # usuario de esta PC como dueño del archivo.
  local resultado_env
  if ! resultado_env="$(docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/destino" \
      --entrypoint node "$IMAGEN" scripts/lib/generar-env.js /destino/.env)"; then
    falla "No se pudo preparar el .env."
    exit 1
  fi
  ok "$resultado_env"

  if ! docker run -d --name "$NOMBRE" --privileged --restart unless-stopped "${procesos[@]}" \
      "${publicar[@]}" -v "$VOLUMEN:/var/lib/docker" -v "$PWD/.env:/livemetric/.env:ro" "$IMAGEN" > /dev/null; then
    falla "No se pudo arrancar el contenedor global."
    exit 1
  fi
  if ! correr /dev/null "Esperando al motor de Docker de adentro" esperar_motor_interno; then
    falla "El motor de Docker de adentro no arrancó. Últimas líneas de su log:"
    docker logs --tail 15 "$NOMBRE" 2>&1 | sed "s/^/       ${C_GRIS}/; s/\$/${C_RESET}/"
    exit 1
  fi
  ok "Contenedor global en marcha, con su propio motor de Docker"

  # El motor de adentro guarda sus contenedores en el volumen (junto con la
  # cache de imagenes) y, por "restart: unless-stopped", los vuelve a
  # arrancar solo: sin esto, el stack de una corrida anterior -con el codigo
  # de entonces- estaria arriba antes de que el analisis de esta pase.
  if [ -n "$(docker exec "$NOMBRE" "${MONITOREO_COMPOSE[@]}" --profile falco ps -a -q 2> /dev/null)" ]; then
    correr /dev/null "Bajando el monitoreo que quedó de una corrida anterior" bajar_monitoreo
  fi
  if [ -n "$(docker exec "$NOMBRE" docker compose ps -a -q 2> /dev/null)" ]; then
    correr /dev/null "Bajando el stack que quedó de una corrida anterior" \
      docker exec "$NOMBRE" docker compose down --remove-orphans
    ok "Stack anterior bajado: solo se levanta de nuevo si el análisis pasa"
  fi


  # 3. Analisis de seguridad (el mismo que corre en CI) ------------------------
  fase 3 "$FASES" "Análisis de seguridad (adentro del contenedor global)"
  info "Los mismos controles que GitHub Actions. Puede tardar varios minutos:"
  info "construye las 6 imágenes reales (la primera vez, además, descarga todo)."
  # LIVEMETRIC_DESDE_START: que pipeline-local.sh no repita su encabezado,
  # igual que cuando lo llama start.sh (esta fase ya lo muestra).
  local rc
  docker exec "${ARGS_TTY[@]}" -e LIVEMETRIC_DESDE_START=1 "$NOMBRE" ./scripts/pipeline-local.sh "$@"
  rc=$?
  if [ "$rc" -eq 130 ]; then
    exit 130
  elif [ "$rc" -ne 0 ]; then
    banner "$C_ROJO" "✘ El análisis encontró problemas: NO se levanta LiveMetric." \
      "  Corregí lo marcado con ✘ arriba y volvé a correr ./scripts/contenedor.sh" \
      "  (el contenedor global sigue en marcha: ./scripts/contenedor.sh shell para" \
      "  revisarlo por dentro, ./scripts/contenedor.sh detener para apagarlo)"
    exit 1
  fi

  # 4. Levantar el stack (adentro) ----------------------------------------------
  fase 4 "$FASES" "Levantar LiveMetric (adentro del contenedor global)"
  local log_compose
  log_compose="$(mktemp /tmp/livemetric-global-compose.XXXXXX)"
  correr "$log_compose" "docker compose up --build (construye y arranca los contenedores)" \
    docker exec -e ACTUALIZAR_PAQUETES="$(date +%F)" "$NOMBRE" docker compose up -d --build
  if [ $? -ne 0 ]; then
    falla "docker compose no pudo levantar el stack. Últimas líneas del log:"
    tail -n 15 "$log_compose" | sed "s/^/       ${C_GRIS}/; s/\$/${C_RESET}/"
    info "Log completo: $log_compose"
    exit 1
  fi
  ok "Contenedores creados."
  echo ""
  if ! adentro node scripts/lib/esperar-contenedores.js; then
    banner "$C_ROJO" "✘ LiveMetric no quedó sano: revisá el motivo de cada contenedor arriba." \
      "  Logs en vivo: ./scripts/contenedor.sh logs"
    exit 1
  fi

  # Primer administrador: en una base nueva no hay ninguno (el repositorio no
  # trae credenciales), así que se ofrece crearlo acá mismo; si ya hay
  # alguno, crearAdmin.js --si-no-hay no hace nada. Necesita una terminal
  # para pedir la contraseña.
  echo ""
  if [ -t 0 ] && [ -t 1 ]; then
    docker exec -it "$NOMBRE" docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay || true
  else
    info "Si todavía no hay ningún administrador, créalo desde ./scripts/contenedor.sh shell con:"
    info "  docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay"
  fi

  # 5. Monitoreo (adentro) ------------------------------------------------------
  local lineas_monitoreo=()
  if [ "$MONITOREO" != 0 ]; then
    fase 5 "$FASES" "Monitoreo (adentro del contenedor global)"
    local perfil=() falco="no disponible en este sistema (necesita Linux con eBPF)"
    [ "$FALCO" = 0 ] && falco="desactivado (LIVEMETRIC_FALCO=0)"
    if falco_posible; then
      perfil=(--profile falco)
      falco="alertas en el tablero de Grafana"
    fi
    local log_monitoreo
    log_monitoreo="$(mktemp /tmp/livemetric-global-monitoreo.XXXXXX)"
    if correr "$log_monitoreo" "Levantando Prometheus, Grafana, Loki, cAdvisor${perfil[*]:+ y Falco}" \
        docker exec "$NOMBRE" "${MONITOREO_COMPOSE[@]}" "${perfil[@]}" up -d \
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

  local url_lan
  url_lan="$(url_red)"
  banner "$C_VERDE" "✔ LiveMetric está arriba (dentro del contenedor global)" \
    "" \
    "  En esta PC:               http://localhost:$PUERTO" \
    "  Desde otra PC de la red:  ${url_lan:-no se detectó una conexión de red}" \
    "${lineas_monitoreo[@]}" \
    "" \
    "  ./scripts/contenedor.sh estado    estado de cada microservicio" \
    "  ./scripts/contenedor.sh logs      logs en vivo (o: logs auth-service)" \
    "  ./scripts/contenedor.sh shell     terminal adentro" \
    "  ./scripts/contenedor.sh detener   apagar todo"
}

estado() {
  requiere_docker
  requiere_corriendo
  ok "Contenedor global en marcha ($NOMBRE, puerto $PUERTO)"
  echo ""
  # Todos los de adentro: la aplicacion y, si esta arriba, el monitoreo.
  docker exec "$NOMBRE" docker ps -a --format 'table {{.Names}}\t{{.Status}}' | sed 's/^/     /'
  if docker exec "$NOMBRE" docker ps -q --filter name=livemetric-grafana | grep -q .; then
    echo ""
    info "Grafana: http://localhost:$PUERTO_GRAFANA · Prometheus: http://localhost:$PUERTO_PROMETHEUS (solo desde esta PC)"
  fi
}

detener() {
  requiere_docker
  if ! docker container inspect "$NOMBRE" &> /dev/null; then
    ok "El contenedor global no estaba creado: nada que apagar."
    return
  fi
  # Primero el stack de adentro: si no, queda guardado en el volumen y vuelve
  # solo la proxima vez que arranque un contenedor global.
  if corriendo; then
    correr /dev/null "Apagando el monitoreo de adentro" bajar_monitoreo
    correr /dev/null "Apagando los microservicios de adentro" \
      docker exec "$NOMBRE" docker compose down --remove-orphans
  fi
  correr /dev/null "Apagando el contenedor global" docker rm -f "$NOMBRE"
  ok "Contenedor global apagado. La base de datos y la caché de imágenes quedan en el volumen $VOLUMEN."
}

borrar() {
  # El volumen guarda la base de datos del stack de adentro: pedir
  # confirmación si hay alguien para darla.
  if [ -t 0 ]; then
    aviso "Esto borra también la base de datos de esta instalación (elecciones, padrón, actas)."
    read -r -p "     ¿Seguro? [s/N] " respuesta
    case "$respuesta" in
      [sS] | [sS][iIíÍ]) ;;
      *) info "No se borró nada."; return 0 ;;
    esac
  fi
  detener
  docker volume rm "$VOLUMEN" &> /dev/null && ok "Volumen $VOLUMEN borrado"
  docker image rm "$IMAGEN" &> /dev/null && ok "Imagen $IMAGEN borrada"
  return 0
}

COMANDO="iniciar"
case "${1:-}" in
  iniciar|estado|logs|shell|detener|borrar) COMANDO="$1"; shift ;;
  -h|--help) uso; exit 0 ;;
esac

case "$COMANDO" in
  iniciar)
    for arg in "$@"; do
      case "$arg" in
        -d|--detalle) DETALLE=true ;;
        *) echo "Opción desconocida: $arg (ver --help)" >&2; exit 2 ;;
      esac
    done
    iniciar "$@"
    ;;
  estado) estado ;;
  logs)
    requiere_docker
    requiere_corriendo
    if [ -n "${1:-}" ] && [[ "$SERVICIOS_MONITOREO" == *" $1 "* ]]; then
      docker exec "${ARGS_TTY[@]}" "$NOMBRE" "${MONITOREO_COMPOSE[@]}" --profile falco logs -f "$@"
    else
      docker exec "${ARGS_TTY[@]}" "$NOMBRE" docker compose logs -f "$@"
    fi
    ;;
  shell)
    requiere_docker
    requiere_corriendo
    docker exec "${ARGS_TTY[@]}" "$NOMBRE" bash
    ;;
  detener) detener ;;
  borrar) borrar ;;
esac

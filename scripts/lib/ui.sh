# LiveMetric - Utilidades de presentacion compartidas por scripts/start.sh y
# scripts/pipeline-local.sh: colores, encabezados, lineas de resultado y
# "correr", que ejecuta un paso largo mandando su salida completa a un log
# mientras muestra un indicador de progreso con el tiempo transcurrido.
#
# Se carga con "source", no se ejecuta sola. Antes de usar "correr" se puede
# fijar DETALLE=true para ver la salida real de la herramienta en vivo (en
# vez del indicador de progreso); el log se guarda igual en los dos modos.

# Colores ANSI solo si la salida va a una terminal (redirigida a un archivo
# ensuciarian el log con codigos de escape). NO_COLOR es la convencion
# estandar para desactivarlos a mano (https://no-color.org).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_AZUL=$'\033[34m'; C_VERDE=$'\033[32m'; C_ROJO=$'\033[31m'
  C_AMARILLO=$'\033[33m'; C_GRIS=$'\033[2m'; C_NEGRITA=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_AZUL=''; C_VERDE=''; C_ROJO=''; C_AMARILLO=''; C_GRIS=''; C_NEGRITA=''; C_RESET=''
fi

DETALLE="${DETALLE:-false}"

RAYA='━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

# banner <color> <linea>... - bloque destacado entre dos rayas.
banner() {
  local color="$1"; shift
  printf '\n%s%s%s\n' "$color" "$RAYA" "$C_RESET"
  local linea
  for linea in "$@"; do
    printf '%s  %s%s\n' "$color$C_NEGRITA" "$linea" "$C_RESET"
  done
  printf '%s%s%s\n' "$color" "$RAYA" "$C_RESET"
}

# fase <n> <total> <titulo> - encabezado de cada etapa grande de start.sh.
fase() {
  local largo=$(( 58 - ${#3} ))
  [ "$largo" -lt 3 ] && largo=3
  printf '\n%s━━ %s/%s  %s %s%s\n' "$C_AZUL$C_NEGRITA" "$1" "$2" "$3" "${RAYA:0:$largo}" "$C_RESET"
}

ok()    { printf '   %s✔%s %s\n' "$C_VERDE" "$C_RESET" "$*"; }
falla() { printf '   %s✘ %s%s\n' "$C_ROJO" "$*" "$C_RESET"; }
aviso() { printf '   %s⚠ %s%s\n' "$C_AMARILLO" "$*" "$C_RESET"; }
info()  { printf '     %s%s%s\n' "$C_GRIS" "$*" "$C_RESET"; }

# matar_arbol <pid> - termina un proceso y todos sus descendientes. Hace
# falta porque un comando lanzado en segundo plano (como hace "correr") NO
# recibe el Ctrl+C: sin esto, cortar el script dejaria corriendo el
# "docker run"/"docker build" que estaba en curso.
matar_arbol() {
  local hijo
  for hijo in $(pgrep -P "$1" 2>/dev/null); do
    matar_arbol "$hijo"
  done
  kill "$1" 2>/dev/null
}

# SILENCIAR_CANCELADO=true evita repetir el aviso cuando el Ctrl+C llega
# mientras corre OTRO script que ya lo muestra (start.sh corriendo
# pipeline-local.sh: los dos reciben la misma senal).
PID_EN_CURSO=""
SILENCIAR_CANCELADO=false
al_cancelar() {
  if [ -n "$PID_EN_CURSO" ]; then matar_arbol "$PID_EN_CURSO"; fi
  if [ "$SILENCIAR_CANCELADO" != true ]; then
    printf '\n%s✘ Cancelado por el usuario.%s\n' "$C_ROJO" "$C_RESET"
  fi
  exit 130
}
trap al_cancelar INT TERM

# correr <log> <texto> <comando> [args...]
# Ejecuta <comando> guardando toda su salida en <log> y devuelve su codigo
# de salida. Mientras corre muestra "<texto> (Ns)" con un indicador
# animado, que la linea de resultado posterior pisa (empieza con \r). Con
# DETALLE=true, en cambio, muestra la salida real en vivo, indentada.
correr() {
  local log="$1" texto="$2"; shift 2

  if [ "$DETALLE" = true ]; then
    printf '   %s▸ %s%s\n' "$C_GRIS" "$texto" "$C_RESET"
    "$@" 2>&1 | tee "$log" | sed "s/^/     ${C_GRIS}│${C_RESET} /"
    return "${PIPESTATUS[0]}"
  fi

  # Siempre en un subshell (aca con parentesis; en los otros dos modos ya lo
  # es por el pipe o el "&"): los pasos que hacen "cd" no deben mover al
  # script que los llama.
  if [ ! -t 1 ]; then
    printf '   … %s\n' "$texto"
    ( "$@" ) > "$log" 2>&1
    return $?
  fi

  "$@" > "$log" 2>&1 &
  PID_EN_CURSO=$!
  local cuadros=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) i=0 inicio=$SECONDS
  while kill -0 "$PID_EN_CURSO" 2>/dev/null; do
    printf '\r   %s%s%s %s %s(%ds)%s' "$C_AZUL" "${cuadros[i++ % 10]}" "$C_RESET" \
      "$texto" "$C_GRIS" $(( SECONDS - inicio )) "$C_RESET"
    sleep 0.1
  done
  wait "$PID_EN_CURSO"
  local rc=$?
  PID_EN_CURSO=""
  printf '\r\033[2K'
  return $rc
}

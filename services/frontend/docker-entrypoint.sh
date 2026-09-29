#!/bin/sh
# Genera el archivo de configuración en /tmp (escribible, tmpfs en compose
# y Swarm) en vez de /usr/share/nginx/html (de solo lectura por
# "read_only: true"). nginx.conf sirve /config.js con un alias apuntando
# aquí, así los archivos estáticos construidos por Vite permanecen intactos
# y de solo lectura.
set -eu

# /tmp llega vacío en cada arranque (tmpfs); nginx espera encontrar estas
# subcarpetas para sus buffers temporales (ver nginx.conf), así que se
# crean aquí antes de arrancar.
mkdir -p /tmp/nginx/client_temp \
         /tmp/nginx/proxy_temp \
         /tmp/nginx/fastcgi_temp \
         /tmp/nginx/uwsgi_temp \
         /tmp/nginx/scgi_temp

cat > /tmp/config.js << CONFIG
window.__LIVEMETRIC_CONFIG__ = {
  AUTH_URL: "${AUTH_URL:-http://localhost:3001}",
  VOTING_URL: "${VOTING_URL:-http://localhost:3002}",
  ANALYTICS_URL: "${ANALYTICS_URL:-http://localhost:3003}",
  SCRUTINY_URL: "${SCRUTINY_URL:-http://localhost:3004}",
};
CONFIG

exec nginx -g 'daemon off;'

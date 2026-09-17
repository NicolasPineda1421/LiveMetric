#!/bin/sh
# Genera el archivo de configuración en /var/run (montado como tmpfs, sí es
# escribible) en vez de /usr/share/nginx/html (montado como solo-lectura por
# "read_only: true" en docker-compose). nginx.conf sirve /config.js con un
# alias apuntando aquí, así los archivos estáticos construidos por Vite
# permanecen intactos y de solo lectura.
set -eu

# /var/cache/nginx se monta como tmpfs vacío en cada arranque (ver
# docker-compose.yml / main.tf); nginx espera encontrar estas subcarpetas
# para sus buffers temporales, así que se recrean aquí antes de arrancar.
mkdir -p /var/cache/nginx/client_temp \
         /var/cache/nginx/proxy_temp \
         /var/cache/nginx/fastcgi_temp \
         /var/cache/nginx/uwsgi_temp \
         /var/cache/nginx/scgi_temp

cat > /var/run/config.js << CONFIG
window.__LIVEMETRIC_CONFIG__ = {
  AUTH_URL: "${AUTH_URL:-http://localhost:3001}",
  VOTING_URL: "${VOTING_URL:-http://localhost:3002}",
  ANALYTICS_URL: "${ANALYTICS_URL:-http://localhost:3003}",
  SCRUTINY_URL: "${SCRUTINY_URL:-http://localhost:3004}",
};
CONFIG

exec nginx -g 'daemon off;'

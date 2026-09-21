# --- Etapa de build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# --- Etapa final: servido estático con nginx ---
#
# A diferencia de los microservicios Node.js de este proyecto, aquí NO se
# fuerza un usuario no-root para el proceso completo. Este es el modelo de
# seguridad estándar de nginx (el mismo que usa la imagen oficial sin
# modificar, y la mayoría de despliegues en producción):
#   - El proceso MAESTRO arranca como root SOLO para abrir el puerto 80
#     (puerto privilegiado <1024) y preparar /var/cache/nginx.
#   - Los procesos WORKER, que son los que realmente procesan las peticiones
#     de la red (la superficie de ataque real), se ejecutan sin privilegios
#     bajo el usuario "nginx" ya definido por la imagen base, mediante la
#     directiva "user nginx;" del nginx.conf por defecto (no se modifica).
# Forzar un usuario no-root en el proceso maestro rompe este diseño (no
# puede abrir el puerto 80 ni escribir su caché) sin aportar una mejora de
# seguridad real, porque el código que atiende tráfico externo YA corre
# sin privilegios en los workers.
FROM nginx:1.27-alpine

# Parchea paquetes de SO (zlib, libxml2, musl, etc.) del snapshot de Alpine
# de la imagen base oficial, que suele quedar unos dias detras de los
# ultimos parches de seguridad de Alpine entre una republicacion y otra.
RUN apk upgrade --no-cache

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]

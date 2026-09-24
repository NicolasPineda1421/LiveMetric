# --- Etapa de build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# --- Etapa final: servido estático con nginx ---
#
# Igual que los microservicios Node.js, el contenedor corre entero sin root
# (USER nginx, abajo) - no solo los workers: si alguien lograra ejecutar
# codigo en el proceso maestro, tampoco tendria root dentro del contenedor.
# Lo unico que el maestro necesitaba root era abrir el puerto 80 (<1024) y
# escribir su cache; por eso nginx escucha en 8080 (ver nginx.conf; hacia
# afuera sigue siendo el 3000) y las carpetas que escribe pasan a ser del
# usuario nginx.
FROM nginx:1.27-alpine

# Parchea paquetes de SO (zlib, libxml2, musl, etc.) del snapshot de Alpine
# de la imagen base oficial, que suele quedar unos dias detras de los
# ultimos parches de seguridad de Alpine entre una republicacion y otra.
RUN apk upgrade --no-cache

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
# - "user nginx;" solo tiene sentido si el maestro arranca como root: se
#   quita para que no avise que la ignora.
# - /var/cache/nginx (buffers) y /run (nginx.pid y el config.js que genera
#   docker-entrypoint.sh) pasan a ser del usuario nginx. Esto cubre cuando se
#   corre sin montajes extra, como en infra/terraform/main.tf; docker-compose
#   las monta como tmpfs y ahi el dueno se fija con uid/gid.
RUN chmod +x /docker-entrypoint.sh && \
    sed -i '/^user /d' /etc/nginx/nginx.conf && \
    chown -R nginx:nginx /var/cache/nginx /run

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]

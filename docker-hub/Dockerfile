# LiveMetric - Imagen de instalación (nicolaspineda1421/livemetric): la puerta
# de entrada en Docker Hub. Deja en la carpeta montada el docker-compose.yml y
# el .env con secretos propios de la instalación (ver instalar.js):
#
#   docker run --rm --pull always -v "${PWD}:/salida" nicolaspineda1421/livemetric
#   docker compose up -d --pull always
#
# Se construye desde la raíz del repositorio, porque usa la generación de
# secretos de auth; Dockerfile.dockerignore deja entrar solo lo necesario:
#   docker build -f docker-hub/Dockerfile .

FROM node:20-alpine

# Como en los servicios: los parches de Alpine posteriores a la imagen base,
# y sin npm ni corepack, que no hacen falta para ejecutar.
ARG ACTUALIZAR_PAQUETES=""
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app
COPY services/auth/src/secretosInstalacion.js services/auth/src/
COPY services/auth/src/scripts/generarEnv.js services/auth/src/scripts/
COPY docker-hub/docker-compose.yml docker-hub/instalar.js docker-hub/

# Sin USER a propósito (Semgrep: missing-user): escribe en la carpeta del
# usuario, que en Linux es de otro dueño, y le deja los archivos a ese dueño
# (instalar.js). No es un servicio: escribe el compose y el .env y termina.
# Los contenedores del sistema sí corren sin root, cada uno con su USER.
WORKDIR /salida
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["node", "/app/docker-hub/instalar.js"]
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["/salida"]

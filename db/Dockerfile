# LiveMetric - La base de datos lista para usar: PostgreSQL 16 con el esquema
# (init.sql) y las migraciones adentro. La usa el compose de Docker Hub
# (docker-hub/docker-compose.yml), que corre el sistema sin el repositorio:
# docker-compose.yml, en cambio, monta estos mismos archivos desde db/.

FROM postgres:16-alpine

# Como en los servicios: un valor nuevo hace que "apk upgrade" no salga de la
# cache, y los parches de Alpine publicados despues de la imagen base entran.
ARG ACTUALIZAR_PAQUETES=""
# gosu, con el que el entrypoint oficial deja de ser root, esta compilado en
# Go y trae su biblioteca estandar: Trivy le marca CVE altas que no son de
# Postgres. Se cambia por su-exec de Alpine (en C, la misma forma de uso):
# la imagen igual corre como "postgres" (abajo) y no lo necesita, pero
# arrancarla como root sigue funcionando.
RUN apk upgrade --no-cache && \
    apk add --no-cache su-exec && \
    rm -f /usr/local/bin/gosu /usr/local/bin/su-exec && \
    sed -i 's/exec gosu postgres /exec su-exec postgres /' \
      /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-ensure-initdb.sh && \
    ! grep -q gosu /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-ensure-initdb.sh

# El esquema completo: el entrypoint oficial lo carga solo la primera vez,
# con el volumen de datos vacio.
COPY init.sql /docker-entrypoint-initdb.d/init.sql
# Las migraciones (idempotentes), para poner al dia una base creada con una
# version anterior: las aplica el servicio "migraciones" en cada arranque.
COPY migrations/ /migraciones/
COPY aplicar-migraciones.sh /usr/local/bin/aplicar-migraciones

# Sin root: el usuario "postgres" de la imagen oficial, dueno de los datos.
USER postgres

# Por TCP a proposito: mientras corre init.sql, Postgres atiende solo por
# socket local, asi que la base no figura sana hasta terminar.
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=12 \
  CMD pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" || exit 1

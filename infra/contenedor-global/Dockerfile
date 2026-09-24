# LiveMetric - Contenedor global: el proyecto entero dentro de UN contenedor.
#
# Adentro corre su propio motor de Docker (Docker-in-Docker), y sobre el
# el mismo analisis de seguridad (scripts/pipeline-local.sh) y el mismo
# docker-compose.yml que usa scripts/start.sh: los 7 contenedores del stack
# quedan ADENTRO de este, no en el host. En el host solo hace falta Docker:
# nada de Node.js, gpg ni nada mas instalado.
#
# No se construye ni se corre a mano: lo hace scripts/contenedor.sh (o
# scripts\contenedor.bat en Windows), que tambien explica el por que de
# cada opcion de "docker run" (--privileged, el volumen, el puerto, etc.).
#
# Contexto de build: la raiz del repo. Lo que NO entra (el .env real,
# node_modules, estado de Terraform, ...) esta en Dockerfile.dockerignore,
# al lado de este archivo.

FROM docker:dind

# Lo que pipeline-local.sh y scripts/lib necesitan en el "host" (que aca es
# este contenedor): bash para los scripts, Node.js/npm para npm audit, las
# pruebas y los resumenes, gpg para descifrar .env.gpg, y procps para
# "pgrep -P" (cortar con Ctrl+C un paso en curso, ver scripts/lib/ui.sh).
# git, docker compose y buildx ya vienen en la imagen base.
RUN apk add --no-cache bash nodejs npm gnupg procps

# gpg pide la passphrase de .env.gpg por la propia terminal ("loopback"),
# en vez de abrir un pinentry aparte, que dentro de un contenedor no tiene
# donde mostrarse.
RUN mkdir -p -m 700 /root/.gnupg && \
    echo 'pinentry-mode loopback' > /root/.gnupg/gpg.conf

WORKDIR /livemetric
COPY . .
# Desde un clon en Windows los .sh llegan sin permiso de ejecucion (NTFS no
# lo guarda), y start.sh llama a los demas como ./scripts/<nombre>.sh.
RUN find scripts -name '*.sh' -exec chmod +x {} +

# Lo que publica el stack de adentro: el frontend (ver docker-compose.yml).
EXPOSE 3000

# El proceso principal es el motor de Docker de adentro (el ENTRYPOINT de
# docker:dind, sin cambios): mientras viva, viven los microservicios. El
# healthcheck solo confirma que ese motor responde.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD docker info > /dev/null 2>&1 || exit 1

# Solo el socket unix. Sin un CMD, el ENTRYPOINT de docker:dind hace que el
# motor ademas escuche por TCP (2376 con TLS, o 2375 SIN autenticacion si
# se desactiva TLS), y nada de afuera necesita hablarle: se maneja con
# "docker exec". Con "dockerd" explicito, el ENTRYPOINT no agrega esos
# --host (y sigue haciendo lo demas: tini como PID 1, iptables, etc.).
#
# Sin USER a proposito (Semgrep: missing-user): dockerd necesita root para
# crear redes, montar las capas de las imagenes y manejar cgroups, y correr
# ese motor es la razon de ser de este contenedor. Los microservicios de
# adentro si corren sin root, cada uno con su propio USER.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["dockerd", "--host=unix:///var/run/docker.sock"]

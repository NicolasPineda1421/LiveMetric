@echo off
REM LiveMetric - Equivalente para CMD de Windows de scripts/contenedor.sh:
REM otra opcion de despliegue, ademas de start.bat. Todo el proyecto dentro
REM de UN contenedor ("contenedor global") con su propio motor de Docker
REM adentro, donde corre el mismo analisis de seguridad y el mismo
REM docker-compose.yml que usa start.bat: los 7 contenedores del stack
REM quedan ADENTRO del global. En la PC solo hace falta Docker Desktop: este
REM script no instala ni modifica nada de Windows (start.bat no se usa).
REM
REM El detalle de como funciona (--privileged, el volumen de cache, el .env
REM montado en solo lectura, el monitoreo de adentro, etc.) esta al
REM principio de scripts/contenedor.sh. Adentro corre tambien el monitoreo
REM (Prometheus, Grafana, Loki y cAdvisor), publicado en la PC SOLO en
REM 127.0.0.1. Falco no: en Docker Desktop los contenedores corren sobre la
REM VM de WSL2 y no hay garantias de que pueda instrumentar ese kernel.
REM Los textos de este archivo van sin acentos: cmd.exe no lee los .bat como
REM UTF-8.
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\contenedor.bat [iniciar] [--detalle]   construye, analiza y levanta todo adentro
REM   scripts\contenedor.bat estado                  estado de cada contenedor de adentro
REM   scripts\contenedor.bat logs [servicio]         logs en vivo del stack de adentro (tambien: logs grafana, logs loki...)
REM   scripts\contenedor.bat shell                   terminal dentro del contenedor global
REM   scripts\contenedor.bat detener                 apaga el contenedor global y todo lo de adentro
REM   scripts\contenedor.bat borrar                  ademas borra su imagen y su volumen (con la BASE DE DATOS)
REM
REM   set LIVEMETRIC_PUERTO=3100 y despues scripts\contenedor.bat   usa otro puerto de la PC
REM   set LIVEMETRIC_PUERTO_GRAFANA=3011 y LIVEMETRIC_PUERTO_PROMETHEUS=9091   otros puertos para el monitoreo
REM   set LIVEMETRIC_MONITOREO=0 y despues scripts\contenedor.bat   sin el monitoreo

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "NOMBRE=livemetric-global"
set "IMAGEN=livemetric-global"
set "VOLUMEN=livemetric-global-docker"
set "PUERTO=%LIVEMETRIC_PUERTO%"
if not defined PUERTO set "PUERTO=3000"
set "PUERTO_GRAFANA=%LIVEMETRIC_PUERTO_GRAFANA%"
if not defined PUERTO_GRAFANA set "PUERTO_GRAFANA=3010"
set "PUERTO_PROMETHEUS=%LIVEMETRIC_PUERTO_PROMETHEUS%"
if not defined PUERTO_PROMETHEUS set "PUERTO_PROMETHEUS=9090"
set "MONITOREO=%LIVEMETRIC_MONITOREO%"
if not defined MONITOREO set "MONITOREO=1"
set "FASES=5"
if "%MONITOREO%"=="0" set "FASES=4"
REM El compose del monitoreo tal como se usa adentro: con el ajuste de puertos
REM y containerd del contenedor global (infra\contenedor-global\monitoreo.override.yml).
set "MONITOREO_COMPOSE=docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml -f infra/contenedor-global/monitoreo.override.yml"

REM Colores ANSI (cmd.exe de Windows 10+ los interpreta). ESC es el
REM caracter de escape, que en batch no se puede escribir literal.
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "AZUL=%ESC%[34m"
set "VERDE=%ESC%[32m"
set "ROJO=%ESC%[31m"
set "AMARILLO=%ESC%[33m"
set "GRIS=%ESC%[2m"
set "NEGRITA=%ESC%[1m"
set "RESET=%ESC%[0m"
set "RAYA====================================================================="

set "COMANDO=%~1"
set "ARG_DETALLE="
if "%COMANDO%"=="" set "COMANDO=iniciar"
if /i "%COMANDO%"=="--detalle" set "COMANDO=iniciar" & set "ARG_DETALLE=--detalle"
if /i "%COMANDO%"=="-d" set "COMANDO=iniciar" & set "ARG_DETALLE=--detalle"
if /i "%~2"=="--detalle" set "ARG_DETALLE=--detalle"
if /i "%~2"=="-d" set "ARG_DETALLE=--detalle"

if /i "%COMANDO%"=="iniciar" goto :iniciar
if /i "%COMANDO%"=="estado" goto :estado
if /i "%COMANDO%"=="logs" goto :logs
if /i "%COMANDO%"=="shell" goto :shell
if /i "%COMANDO%"=="detener" goto :detener
if /i "%COMANDO%"=="borrar" goto :borrar
echo Opcion desconocida: %COMANDO% ^(ver el comentario al principio de este archivo^) 1>&2
exit /b 2

REM ===========================================================================
:iniciar
REM Lo que corre adentro del contenedor global escribe en UTF-8 (acentos,
REM simbolos): la consola se pasa a UTF-8 mientras dura esto, y en todas
REM las salidas (:fin) se deja como estaba.
for /f "tokens=2 delims=:." %%c in ('chcp') do set "CP_ORIGINAL=%%c"
chcp 65001 >nul

echo.
echo %AZUL%%RAYA%%RESET%
echo %AZUL%%NEGRITA%  LiveMetric - contenedor global, el proyecto entero dentro de Docker%RESET%
echo %AZUL%%RAYA%%RESET%

REM --- 1. Docker en esta PC -------------------------------------------------
call :fase 1 "Docker en esta PC"
call :requiere_docker
if errorlevel 1 goto :fin_error
call :ok "Docker Desktop (el motor responde)"

docker container inspect %NOMBRE% >nul 2>nul
if not errorlevel 1 (
  call :aviso "Ya habia un contenedor global: se reemplaza por uno nuevo con el codigo actual."
  docker rm -f %NOMBRE% >nul
)

netstat -ano | findstr /r /c:":%PUERTO% .*LISTENING" >nul
if not errorlevel 1 (
  call :falla "El puerto %PUERTO% ya esta en uso en esta PC."
  for /f "delims=" %%n in ('docker ps --filter "publish=%PUERTO%" --format "{{.Names}}"') do call :info "Lo usa: %%n"
  call :info "Si es LiveMetric corriendo directo con start.bat, bajalo con: docker compose down"
  call :info "O usa otro puerto: set LIVEMETRIC_PUERTO=3100 y volve a correr este script."
  goto :fin_error
)
call :ok "Puerto %PUERTO% libre"

set "PUBLICAR=-p %PUERTO%:3000"
if "%MONITOREO%"=="0" goto :sin_puertos_monitoreo
for %%p in (%PUERTO_GRAFANA% %PUERTO_PROMETHEUS%) do (
  netstat -ano | findstr /r /c:":%%p .*LISTENING" >nul
  if not errorlevel 1 (
    call :falla "El puerto %%p, del monitoreo, ya esta en uso en esta PC."
    call :info "Si es el monitoreo corriendo directo en la PC, bajalo con:"
    call :info "  docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml down"
    call :info "O usa otros puertos: set LIVEMETRIC_PUERTO_GRAFANA=3011 y set LIVEMETRIC_PUERTO_PROMETHEUS=9091"
    call :info "O sin monitoreo: set LIVEMETRIC_MONITOREO=0"
    goto :fin_error
  )
)
REM Solo en 127.0.0.1: el monitoreo no se alcanza desde otra PC.
set "PUBLICAR=%PUBLICAR% -p 127.0.0.1:%PUERTO_GRAFANA%:3010 -p 127.0.0.1:%PUERTO_PROMETHEUS%:9090"
call :ok "Puertos %PUERTO_GRAFANA% para Grafana y %PUERTO_PROMETHEUS% para Prometheus libres"
:sin_puertos_monitoreo

REM --- 2. Contenedor global -------------------------------------------------
call :fase 2 "Contenedor global"
set "LOG_BUILD=%TEMP%\livemetric-global-build-%RANDOM%.log"
<nul set /p "=%GRIS%   ... construyendo la imagen %IMAGEN%%RESET%"
docker build -f infra\contenedor-global\Dockerfile -t %IMAGEN% . > "%LOG_BUILD%" 2>&1
if errorlevel 1 (
  echo.
  call :falla "No se pudo construir la imagen %IMAGEN%. Ultimas lineas del log:"
  powershell -NoProfile -Command "Get-Content -Tail 15 '%LOG_BUILD%'"
  call :info "Log completo: %LOG_BUILD%"
  goto :fin_error
)
echo.
call :ok "Imagen %IMAGEN% construida con el codigo actual, sin el .env"

REM El .env tiene que quedar en ESTA carpeta y no solo dentro del
REM contenedor: la base vive en el volumen y sobrevive a que se recree el
REM contenedor, y con claves nuevas quedaria con otra contrasena y el padron
REM ilegible. Se genera (o se completa) con la misma imagen: en la PC no hace
REM falta Node.js. Despues se monta adentro en solo lectura.
docker run --rm -v "%cd%:/destino" --entrypoint node %IMAGEN% scripts/lib/generar-env.js /destino/.env
if errorlevel 1 (
  call :falla "No se pudo preparar el .env."
  goto :fin_error
)
docker run -d --name %NOMBRE% --privileged --restart unless-stopped %PUBLICAR% -v %VOLUMEN%:/var/lib/docker -v "%cd%\.env:/livemetric/.env:ro" %IMAGEN% >nul
if errorlevel 1 (
  call :falla "No se pudo arrancar el contenedor global."
  goto :fin_error
)

<nul set /p "=%GRIS%   ... esperando al motor de Docker de adentro%RESET%"
set MOTOR_OK=0
for /l %%i in (1,1,60) do (
  if "!MOTOR_OK!"=="0" (
    docker exec %NOMBRE% docker info >nul 2>nul
    if not errorlevel 1 (
      set MOTOR_OK=1
    ) else (
      timeout /t 1 /nobreak >nul
    )
  )
)
echo.
if "%MOTOR_OK%"=="0" (
  call :falla "El motor de Docker de adentro no arranco. Ultimas lineas de su log:"
  docker logs --tail 15 %NOMBRE%
  goto :fin_error
)
call :ok "Contenedor global en marcha, con su propio motor de Docker"

REM El motor de adentro guarda sus contenedores en el volumen (junto con la
REM cache de imagenes) y, por "restart: unless-stopped", los vuelve a
REM arrancar solo: sin esto, el stack de una corrida anterior, con el codigo
REM de entonces, estaria arriba antes de que el analisis de esta pase.
REM Primero el monitoreo: esta conectado a la red de la aplicacion, que si
REM no, no se puede borrar al bajarla.
set "MONITOREO_ANTERIOR="
for /f %%c in ('docker exec %NOMBRE% %MONITOREO_COMPOSE% --profile falco ps -a -q 2^>nul') do set "MONITOREO_ANTERIOR=1"
if defined MONITOREO_ANTERIOR (
  <nul set /p "=%GRIS%   ... bajando el monitoreo que quedo de una corrida anterior%RESET%"
  docker exec %NOMBRE% %MONITOREO_COMPOSE% --profile falco down >nul 2>nul
  echo.
  call :ok "Monitoreo anterior bajado"
)
set "STACK_ANTERIOR="
for /f %%c in ('docker exec %NOMBRE% docker compose ps -a -q 2^>nul') do set "STACK_ANTERIOR=1"
if defined STACK_ANTERIOR (
  <nul set /p "=%GRIS%   ... bajando el stack que quedo de una corrida anterior%RESET%"
  docker exec %NOMBRE% docker compose down --remove-orphans >nul 2>nul
  echo.
  call :ok "Stack anterior bajado: solo se levanta de nuevo si el analisis pasa"
)

REM --- 3. Analisis de seguridad (el mismo que corre en CI) ------------------
REM LIVEMETRIC_DESDE_START: que pipeline-local.sh no repita su encabezado,
REM igual que cuando lo llama start.sh (esta fase ya lo muestra).
call :fase 3 "Analisis de seguridad, adentro del contenedor global"
call :info "Los mismos controles que GitHub Actions. Puede tardar varios minutos:"
call :info "construye las 6 imagenes reales, y la primera vez ademas descarga todo."
docker exec -it -e LIVEMETRIC_DESDE_START=1 %NOMBRE% ./scripts/pipeline-local.sh %ARG_DETALLE%
if errorlevel 1 (
  echo.
  echo %ROJO%%RAYA%%RESET%
  echo %ROJO%%NEGRITA%  X El analisis encontro problemas: NO se levanta LiveMetric.%RESET%
  echo %ROJO%    Corregi lo marcado en rojo arriba y volve a correr scripts\contenedor.bat%RESET%
  echo %ROJO%    El contenedor global sigue en marcha: scripts\contenedor.bat shell para%RESET%
  echo %ROJO%    revisarlo por dentro, scripts\contenedor.bat detener para apagarlo.%RESET%
  echo %ROJO%%RAYA%%RESET%
  goto :fin_error
)

REM --- 4. Levantar el stack, adentro ------------------------------------------
call :fase 4 "Levantar LiveMetric, adentro del contenedor global"
set "LOG_COMPOSE=%TEMP%\livemetric-global-compose-%RANDOM%.log"
REM Fecha del dia (AAAA-MM-DD): con un valor nuevo, Docker no reutiliza de su
REM cache la capa de "apk upgrade" de un build de otro dia (ver ARG
REM ACTUALIZAR_PAQUETES en los Dockerfile).
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "ACTUALIZAR_PAQUETES=%%d"
<nul set /p "=%GRIS%   ... docker compose up --build: construyendo y arrancando los contenedores%RESET%"
docker exec -e ACTUALIZAR_PAQUETES=%ACTUALIZAR_PAQUETES% %NOMBRE% docker compose up -d --build > "%LOG_COMPOSE%" 2>&1
if errorlevel 1 (
  echo.
  call :falla "docker compose no pudo levantar el stack. Ultimas lineas del log:"
  powershell -NoProfile -Command "Get-Content -Tail 15 '%LOG_COMPOSE%'"
  call :info "Log completo: %LOG_COMPOSE%"
  goto :fin_error
)
echo.
call :ok "Contenedores creados."
echo.
docker exec -it %NOMBRE% node scripts/lib/esperar-contenedores.js
if errorlevel 1 (
  echo.
  echo %ROJO%%RAYA%%RESET%
  echo %ROJO%%NEGRITA%  X LiveMetric no quedo sano: revisa el motivo de cada contenedor arriba.%RESET%
  echo %ROJO%    Logs en vivo: scripts\contenedor.bat logs%RESET%
  echo %ROJO%%RAYA%%RESET%
  goto :fin_error
)

REM Primer administrador: en una base nueva no hay ninguno (el repositorio
REM no trae credenciales), asi que se ofrece crearlo aca mismo. Si ya hay
REM alguno, crearAdmin.js --si-no-hay no hace nada.
REM Si no se pudo crear (por ejemplo, tres contrasenas inseguras), se avisa al
REM final: sin administrador no se puede entrar al panel.
echo.
set "SIN_ADMIN=0"
docker exec -it %NOMBRE% docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay
if errorlevel 1 set "SIN_ADMIN=1"

REM --- 5. Monitoreo, adentro ---------------------------------------------------
set "MONITOREO_OK=0"
if "%MONITOREO%"=="0" goto :sin_monitoreo
call :fase 5 "Monitoreo, adentro del contenedor global"
set "LOG_MONITOREO=%TEMP%\livemetric-global-monitoreo-%RANDOM%.log"
<nul set /p "=%GRIS%   ... levantando Prometheus, Grafana, Loki y cAdvisor%RESET%"
docker exec %NOMBRE% %MONITOREO_COMPOSE% up -d > "%LOG_MONITOREO%" 2>&1
if errorlevel 1 (
  echo.
  call :aviso "El monitoreo no arranco; LiveMetric si esta arriba. Log: %LOG_MONITOREO%"
  goto :sin_monitoreo
)
for /l %%i in (1,1,60) do (
  if "!MONITOREO_OK!"=="0" (
    docker exec %NOMBRE% wget -qO- http://127.0.0.1:3010/api/health >nul 2>nul
    if not errorlevel 1 (
      set MONITOREO_OK=1
    ) else (
      timeout /t 2 /nobreak >nul
    )
  )
)
echo.
if "%MONITOREO_OK%"=="1" (
  call :ok "Monitoreo en marcha"
) else (
  call :aviso "Grafana no respondio a tiempo; LiveMetric si esta arriba. Log: %LOG_MONITOREO%"
)
:sin_monitoreo

REM URL para otras PCs de la red: la IP de ESTA PC (la de la ruta hacia
REM afuera). Se calcula aca porque adentro del contenedor solo se ve la suya.
set "IP_LAN="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Find-NetRoute -RemoteIPAddress 1.1.1.1).IPAddress" 2^>nul') do (
  if not defined IP_LAN set "IP_LAN=%%i"
)

echo.
echo %VERDE%%RAYA%%RESET%
echo %VERDE%%NEGRITA%  OK - LiveMetric esta arriba, dentro del contenedor global%RESET%
echo.
echo %VERDE%    En esta PC:               http://localhost:%PUERTO%%RESET%
if defined IP_LAN (
  echo %VERDE%    Desde otra PC de la red:  http://%IP_LAN%:%PUERTO%%RESET%
) else (
  echo %VERDE%    Desde otra PC de la red:  no se detecto una conexion de red%RESET%
)
if "%MONITOREO_OK%"=="1" (
  echo.
  echo %VERDE%    Monitoreo, solo desde esta PC:%RESET%
  echo %VERDE%      Grafana:     http://localhost:%PUERTO_GRAFANA%   usuario y contrasena: findstr GRAFANA .env%RESET%
  echo %VERDE%      Prometheus:  http://localhost:%PUERTO_PROMETHEUS%%RESET%
  echo %VERDE%      Loki:        en Grafana, Explore y la fuente Loki%RESET%
  echo %VERDE%      Falco:       no disponible con Docker Desktop%RESET%
)
echo.
echo %VERDE%    scripts\contenedor.bat estado    estado de cada microservicio%RESET%
echo %VERDE%    scripts\contenedor.bat logs      logs en vivo, o: logs auth-service%RESET%
echo %VERDE%    scripts\contenedor.bat shell     terminal adentro%RESET%
echo %VERDE%    scripts\contenedor.bat detener   apagar todo%RESET%
echo %VERDE%%RAYA%%RESET%
if defined IP_LAN call :info "Si otra PC no llega, permiti el puerto %PUERTO% TCP en el Firewall de Windows, ver docs\instalacion-y-despliegue.md."
if "%SIN_ADMIN%"=="1" (
  echo.
  echo %AMARILLO%%RAYA%%RESET%
  echo %AMARILLO%%NEGRITA%  ATENCION - No se creo el administrador: sin el no se puede entrar al panel.%RESET%
  echo %AMARILLO%    Crealo con una contrasena segura:%RESET%
  echo %AMARILLO%    docker exec -it %NOMBRE% docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay%RESET%
  echo %AMARILLO%%RAYA%%RESET%
)
call :restaurar_consola
exit /b 0

:fin_error
call :restaurar_consola
exit /b 1

:restaurar_consola
if defined CP_ORIGINAL chcp %CP_ORIGINAL: =% >nul
goto :eof

REM ===========================================================================
:estado
call :requiere_corriendo
if errorlevel 1 exit /b 1
call :ok "Contenedor global en marcha (%NOMBRE%, puerto %PUERTO%)"
echo.
REM Todos los de adentro: la aplicacion y, si esta arriba, el monitoreo.
docker exec %NOMBRE% docker ps -a --format "table {{.Names}}\t{{.Status}}"
for /f %%g in ('docker exec %NOMBRE% docker ps -q --filter "name=livemetric-grafana" 2^>nul') do (
  echo.
  call :info "Grafana: http://localhost:%PUERTO_GRAFANA% - Prometheus: http://localhost:%PUERTO_PROMETHEUS%, solo desde esta PC"
)
exit /b 0

:logs
call :requiere_corriendo
if errorlevel 1 exit /b 1
for %%s in (prometheus grafana loki promtail cadvisor blackbox-exporter falco) do (
  if /i "%~2"=="%%s" (
    docker exec -it %NOMBRE% %MONITOREO_COMPOSE% --profile falco logs -f %2
    exit /b !errorlevel!
  )
)
docker exec -it %NOMBRE% docker compose logs -f %2
exit /b %errorlevel%

:shell
call :requiere_corriendo
if errorlevel 1 exit /b 1
docker exec -it %NOMBRE% bash
exit /b %errorlevel%

:detener
call :requiere_docker
if errorlevel 1 exit /b 1
docker container inspect %NOMBRE% >nul 2>nul
if errorlevel 1 (
  call :ok "El contenedor global no estaba creado: nada que apagar."
  exit /b 0
)
REM Primero el stack de adentro: si no, queda guardado en el volumen y
REM vuelve solo la proxima vez que arranque un contenedor global.
<nul set /p "=%GRIS%   ... apagando el monitoreo y los microservicios de adentro, y el contenedor global%RESET%"
docker exec %NOMBRE% %MONITOREO_COMPOSE% --profile falco down >nul 2>nul
docker exec %NOMBRE% docker compose down --remove-orphans >nul 2>nul
docker rm -f %NOMBRE% >nul
echo.
call :ok "Contenedor global apagado. La base de datos y la cache de imagenes quedan en el volumen %VOLUMEN%."
exit /b 0

:borrar
REM El volumen guarda la base de datos del stack de adentro: pedir confirmacion.
call :aviso "Esto borra tambien la base de datos de esta instalacion (elecciones, padron, actas)."
set "RESPUESTA="
set /p "RESPUESTA=     Seguro? [s/N] "
if /i "%RESPUESTA%"=="s" goto :borrar_si
if /i "%RESPUESTA%"=="si" goto :borrar_si
call :info "No se borro nada."
exit /b 0

:borrar_si
call :detener
if errorlevel 1 exit /b 1
docker volume rm %VOLUMEN% >nul 2>nul && call :ok "Volumen %VOLUMEN% borrado"
docker image rm %IMAGEN% >nul 2>nul && call :ok "Imagen %IMAGEN% borrada"
exit /b 0

REM ===========================================================================
REM Subrutinas
REM ===========================================================================

:requiere_docker
where docker >nul 2>nul
if errorlevel 1 (
  call :falla "Docker no esta instalado. Es lo unico que este modo necesita en la PC:"
  call :info "https://www.docker.com/products/docker-desktop/"
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  call :falla "Docker Desktop esta instalado pero el motor no responde: abrilo y espera a que inicie."
  exit /b 1
)
exit /b 0

:requiere_corriendo
call :requiere_docker
if errorlevel 1 exit /b 1
for /f %%r in ('docker container inspect -f "{{.State.Running}}" %NOMBRE% 2^>nul') do set "CORRIENDO=%%r"
if not "%CORRIENDO%"=="true" (
  call :falla "El contenedor global no esta corriendo. Arrancalo con: scripts\contenedor.bat"
  exit /b 1
)
exit /b 0

REM :fase <n> <titulo> - encabezado de cada etapa grande.
:fase
echo.
echo %AZUL%%NEGRITA%== %~1/%FASES%  %~2 ==============================================%RESET%
goto :eof

REM Lineas de estado, con el mismo codigo de colores que start.bat. Ningun
REM texto usa el signo de exclamacion: con enabledelayedexpansion, cmd.exe
REM lo borra de los echo.
:ok
echo    %VERDE%OK%RESET% %~1
goto :eof

:aviso
echo    %AMARILLO%AVISO %~1%RESET%
goto :eof

:falla
echo    %ROJO%X  %~1%RESET%
goto :eof

:info
echo      %GRIS%%~1%RESET%
goto :eof

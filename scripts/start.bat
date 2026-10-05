@echo off
REM LiveMetric - Equivalente para CMD de Windows de scripts/start.sh (sin
REM WSL2, sin bash): instala los requisitos que falten, prepara el .env,
REM corre el analisis de seguridad completo (scripts/pipeline-local.bat)
REM y, SOLO si todo pasa, levanta el stack con Docker Desktop y muestra
REM el link final.
REM
REM Requisitos (se intentan instalar solos via winget si faltan): Docker
REM Desktop y Node.js. winget viene incluido en Windows 10/11 modernos; si
REM no esta disponible, hay que instalar cada cosa a mano (se indica el
REM link).
REM
REM Con LiveMetric arriba levanta tambien el monitoreo (monitoring\):
REM Prometheus, Grafana, Loki y cAdvisor, publicados SOLO en 127.0.0.1.
REM Falco no: en Docker Desktop los contenedores corren sobre la VM de WSL2
REM y no hay garantias de que pueda instrumentar ese kernel. Tiene los mismos
REM comandos que scripts\contenedor.bat, aca sobre el Docker de la PC.
REM
REM Los textos de este archivo van sin acentos a proposito: cmd.exe no lee
REM los .bat como UTF-8 y los mostraria desfigurados.
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\start.bat [iniciar] [--detalle]   instala lo que falte, analiza y levanta todo
REM                                            --detalle: ademas, la salida completa de cada herramienta
REM   scripts\start.bat estado                  estado de cada contenedor
REM   scripts\start.bat logs [servicio]         logs en vivo (tambien: logs grafana, logs loki...)
REM   scripts\start.bat shell [servicio]        terminal dentro de un microservicio (sin servicio, auth-service)
REM   scripts\start.bat admin [usuario]         cambia la contrasena de una cuenta del panel (sin usuario,
REM                                            pregunta cual; si no hay administrador, crea el primero)
REM   scripts\start.bat detener                 apaga LiveMetric y el monitoreo (los datos quedan)
REM   scripts\start.bat borrar                  ademas borra sus volumenes (con la BASE DE DATOS) y sus imagenes
REM
REM   set LIVEMETRIC_PUERTO=3100 y despues scripts\start.bat   usa otro puerto de la PC
REM   set LIVEMETRIC_PUERTO_GRAFANA=3011 y LIVEMETRIC_PUERTO_PROMETHEUS=9091   otros puertos para el monitoreo
REM   set LIVEMETRIC_MONITOREO=0 y despues scripts\start.bat   sin el monitoreo

setlocal enabledelayedexpansion
cd /d "%~dp0.."

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
REM docker compose toma de aca los puertos que publica (ver docker-compose.yml
REM y monitoring\docker-compose.monitoring.yml).
set "LIVEMETRIC_PUERTO=%PUERTO%"
set "LIVEMETRIC_PUERTO_GRAFANA=%PUERTO_GRAFANA%"
set "LIVEMETRIC_PUERTO_PROMETHEUS=%PUERTO_PROMETHEUS%"
REM El monitoreo es otro proyecto de compose, aparte de la aplicacion: el
REM monitoreo no debe poder tumbar lo que monitorea. --profile falco para
REM que down, ps y logs incluyan a Falco, si alguna vez se levanto a mano.
set "MONITOREO_COMPOSE=docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml"
set "NOMBRE_GLOBAL=livemetric-global"

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

REM El resto de los argumentos, despues del comando: los servicios de logs
REM y el usuario de admin.
set "RESTO="
set "SALTAR=1"
for %%a in (%*) do (
  if defined SALTAR (set "SALTAR=") else set "RESTO=!RESTO! %%a"
)
for %%c in (iniciar logs shell admin borrar) do if /i "%COMANDO%"=="%%c" call :terminal

if /i "%COMANDO%"=="iniciar" goto :iniciar
if /i "%COMANDO%"=="estado" goto :estado
if /i "%COMANDO%"=="logs" goto :logs
if /i "%COMANDO%"=="shell" goto :shell
if /i "%COMANDO%"=="admin" goto :admin
if /i "%COMANDO%"=="detener" goto :detener
if /i "%COMANDO%"=="borrar" goto :borrar
echo Opcion desconocida: %COMANDO% ^(ver el comentario al principio de este archivo^) 1>&2
exit /b 2

REM ===========================================================================
:iniciar
echo.
echo %AZUL%%RAYA%%RESET%
echo %AZUL%%NEGRITA%  LiveMetric - arranque con verificacion de seguridad%RESET%
echo %AZUL%%RAYA%%RESET%

REM --- 1. Verificar/instalar requisitos, y los puertos ------------------------
where winget >nul 2>nul
if errorlevel 1 (
  set HAS_WINGET=0
) else (
  set HAS_WINGET=1
)

call :fase 1 "Requisitos"
set REQUISITOS_OK=1
call :ensure_tool node "OpenJS.NodeJS.LTS" "C:\Program Files\nodejs"
call :ensure_docker
if "%REQUISITOS_OK%"=="0" (
  echo.
  echo %ROJO%%RAYA%%RESET%
  echo %ROJO%%NEGRITA%  X Faltan requisitos que no se pudieron instalar solos.%RESET%
  echo %ROJO%    Revisa los mensajes de arriba, instalalos a mano y volve a correr este script.%RESET%
  echo %ROJO%%RAYA%%RESET%
  exit /b 1
)

call :puerto_disponible %PUERTO% LiveMetric livemetric-frontend
if errorlevel 1 (
  call :info "O usa otro puerto: set LIVEMETRIC_PUERTO=3100 y volve a correr este script."
  exit /b 1
)
if "%MONITOREO%"=="0" goto :puertos_listos
call :puerto_disponible %PUERTO_GRAFANA% Grafana livemetric-grafana
if errorlevel 1 goto :puertos_monitoreo_ocupados
call :puerto_disponible %PUERTO_PROMETHEUS% Prometheus livemetric-prometheus
if errorlevel 1 goto :puertos_monitoreo_ocupados
goto :puertos_listos
:puertos_monitoreo_ocupados
call :info "O usa otros puertos: set LIVEMETRIC_PUERTO_GRAFANA=3011 y set LIVEMETRIC_PUERTO_PROMETHEUS=9091"
call :info "O sin monitoreo: set LIVEMETRIC_MONITOREO=0"
exit /b 1
:puertos_listos

REM --- 2. Preparar el .env -------------------------------------------------
REM Cada instalacion tiene su propia base y sus propias claves: si no hay
REM .env, se genera con secretos aleatorios; si ya hay uno, solo se le
REM agregan las variables nuevas que falten (nunca se pisa un valor).
call :fase 2 "Configuracion (.env)"
node scripts\lib\generar-env.js
if errorlevel 1 (
  call :falla "No se pudo preparar el .env."
  exit /b 1
)

REM --- 3. Analisis de seguridad completo (el mismo que corre en CI) --------
call :fase 3 "Analisis de seguridad"
call :info "Los mismos controles que GitHub Actions. Puede tardar varios minutos:"
call :info "construye las 6 imagenes reales."
set LIVEMETRIC_DESDE_START=1
call scripts\pipeline-local.bat %ARG_DETALLE%
if errorlevel 1 (
  echo.
  echo %ROJO%%RAYA%%RESET%
  echo %ROJO%%NEGRITA%  X El analisis encontro problemas: NO se levanta LiveMetric.%RESET%
  echo %ROJO%    Corregi lo marcado en rojo arriba y volve a correr scripts\start.bat%RESET%
  echo %ROJO%%RAYA%%RESET%
  exit /b 1
)

REM --- 4. Levantar el stack --------------------------------------------------
call :fase 4 "Levantar LiveMetric"
set "COMPOSE_LOG=%TEMP%\livemetric-compose-%RANDOM%.log"
REM Fecha del dia (AAAA-MM-DD): con un valor nuevo, Docker no reutiliza de su
REM cache la capa de "apk upgrade" de un build de otro dia (ver ARG
REM ACTUALIZAR_PAQUETES en los Dockerfile).
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "ACTUALIZAR_PAQUETES=%%d"
if "%ARG_DETALLE%"=="" (
  <nul set /p "=%GRIS%   ... docker compose up --build: construyendo y arrancando los contenedores%RESET%"
  call docker compose up -d --build > "%COMPOSE_LOG%" 2>&1
) else (
  call docker compose up -d --build
)
if errorlevel 1 (
  echo.
  call :falla "docker compose no pudo levantar el stack."
  if "%ARG_DETALLE%"=="" call :info "Log completo: %COMPOSE_LOG%"
  exit /b 1
)
echo.
call :ok "Contenedores creados."

REM Espera (sin limite de tiempo mientras sigan arrancando) a que TODOS
REM queden sanos, mostrando el estado de cada uno en vivo; ver el detalle
REM en scripts\lib\esperar-contenedores.js.
echo.
node scripts\lib\esperar-contenedores.js
if errorlevel 1 (
  echo.
  echo %ROJO%%RAYA%%RESET%
  echo %ROJO%%NEGRITA%  X LiveMetric no quedo sano: revisa el motivo de cada contenedor arriba.%RESET%
  echo %ROJO%    Logs en vivo: scripts\start.bat logs%RESET%
  echo %ROJO%%RAYA%%RESET%
  exit /b 1
)

REM Primer administrador: en una base nueva no hay ninguno (el repositorio
REM no trae credenciales), asi que se ofrece crearlo aca mismo. Si ya hay
REM alguno, crearAdmin.js --si-no-hay no hace nada. Necesita una terminal
REM para pedir la contrasena; sin ella solo se indica como hacerlo.
REM Si no se pudo crear (por ejemplo, tres contrasenas inseguras), se avisa al
REM final: sin administrador no se puede entrar al panel.
echo.
set "SIN_ADMIN=0"
if "%TERMINAL%"=="1" (
  call docker compose exec auth-service node src/scripts/crearAdmin.js --si-no-hay
  if errorlevel 1 set "SIN_ADMIN=1"
) else (
  call :info "Si todavia no hay ningun administrador, crealo con: scripts\start.bat admin"
)

REM --- 5. Monitoreo ------------------------------------------------------------
set "MONITOREO_OK=0"
if "%MONITOREO%"=="0" goto :sin_monitoreo
call :fase 5 "Monitoreo"
set "LOG_MONITOREO=%TEMP%\livemetric-monitoreo-%RANDOM%.log"
<nul set /p "=%GRIS%   ... levantando Prometheus, Grafana, Loki y cAdvisor%RESET%"
%MONITOREO_COMPOSE% up -d > "%LOG_MONITOREO%" 2>&1
if errorlevel 1 (
  echo.
  call :aviso "El monitoreo no arranco; LiveMetric si esta arriba. Log: %LOG_MONITOREO%"
  goto :sin_monitoreo
)
for /l %%i in (1,1,60) do (
  if "!MONITOREO_OK!"=="0" (
    call curl -sf http://127.0.0.1:%PUERTO_GRAFANA%/api/health >nul 2>nul
    if not errorlevel 1 (
      set MONITOREO_OK=1
    ) else (
      call timeout /t 2 /nobreak >nul
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

REM Con el contenedor del frontend sano, esto solo confirma que el puerto
REM tambien responde desde afuera de Docker (mapeo de puertos, firewall).
set FRONTEND_UP=0
for /l %%i in (1,1,5) do (
  if "!FRONTEND_UP!"=="0" (
    call curl -sf http://127.0.0.1:%PUERTO% >nul 2>nul
    if not errorlevel 1 (
      set FRONTEND_UP=1
    ) else (
      call timeout /t 1 /nobreak >nul
    )
  )
)

REM URL para otras PCs de la misma red (el frontend se publica en
REM 0.0.0.0); la IP la detecta scripts\lib\ip-local.js.
set "IP_LAN="
for /f "delims=" %%i in ('node scripts\lib\ip-local.js 2^>nul') do set "IP_LAN=%%i"

echo.
if "%FRONTEND_UP%"=="1" (
  echo %VERDE%%RAYA%%RESET%
  echo %VERDE%%NEGRITA%  OK - LiveMetric esta arriba%RESET%
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
  echo %VERDE%    scripts\start.bat estado    estado de cada microservicio%RESET%
  echo %VERDE%    scripts\start.bat logs      logs en vivo, o: logs auth-service%RESET%
  echo %VERDE%    scripts\start.bat shell     terminal dentro de un microservicio%RESET%
  echo %VERDE%    scripts\start.bat admin     cambiar la contrasena del administrador%RESET%
  echo %VERDE%    scripts\start.bat detener   apagar todo%RESET%
  echo %VERDE%%RAYA%%RESET%
  if defined IP_LAN call :info "Si otra PC no llega, permiti el puerto %PUERTO% TCP en el Firewall de Windows, ver docs\instalacion-y-despliegue.md."
) else (
  echo %AMARILLO%%RAYA%%RESET%
  echo %AMARILLO%%NEGRITA%  ATENCION - Los contenedores estan sanos, pero http://localhost:%PUERTO% no responde.%RESET%
  echo %AMARILLO%    Revisa que nada mas use el puerto %PUERTO% y los logs con: scripts\start.bat logs frontend%RESET%
  echo %AMARILLO%%RAYA%%RESET%
)
if "%SIN_ADMIN%"=="1" (
  echo.
  echo %AMARILLO%%RAYA%%RESET%
  echo %AMARILLO%%NEGRITA%  ATENCION - No se creo el administrador: sin el no se puede entrar al panel.%RESET%
  echo %AMARILLO%    Crealo con una contrasena segura:  scripts\start.bat admin%RESET%
  echo %AMARILLO%%RAYA%%RESET%
)

exit /b 0

REM ===========================================================================
:estado
call :requiere_corriendo
if errorlevel 1 exit /b 1
call :ok "LiveMetric en marcha, puerto %PUERTO%"
echo.
REM Los de la aplicacion y, si esta arriba, los del monitoreo: todos se
REM llaman livemetric-*, menos el contenedor global, que es el otro modo.
docker ps -a --filter "name=livemetric-" --format "table {{.Names}}\t{{.Status}}" | findstr /v /b /c:"%NOMBRE_GLOBAL% "
for /f %%g in ('docker ps -q --filter "name=livemetric-grafana" 2^>nul') do (
  echo.
  call :info "Grafana: http://localhost:%PUERTO_GRAFANA% - Prometheus: http://localhost:%PUERTO_PROMETHEUS%, solo desde esta PC"
)
exit /b 0

:logs
call :requiere_corriendo
if errorlevel 1 exit /b 1
for %%s in (prometheus grafana loki promtail cadvisor blackbox-exporter falco) do (
  if /i "%~2"=="%%s" (
    %MONITOREO_COMPOSE% --profile falco logs -f%RESTO%
    exit /b !errorlevel!
  )
)
docker compose logs -f%RESTO%
exit /b %errorlevel%

REM Terminal dentro de un microservicio (o de uno del monitoreo); sin
REM servicio, auth-service.
:shell
call :requiere_corriendo
if errorlevel 1 exit /b 1
set "SERVICIO=%~2"
if not defined SERVICIO set "SERVICIO=auth-service"
set "EXEC_T="
if "%TERMINAL%"=="0" set "EXEC_T=-T"
for %%s in (prometheus grafana loki promtail cadvisor blackbox-exporter falco) do (
  if /i "%SERVICIO%"=="%%s" (
    %MONITOREO_COMPOSE% --profile falco exec %EXEC_T% %SERVICIO% sh
    exit /b !errorlevel!
  )
)
docker compose exec %EXEC_T% %SERVICIO% sh
exit /b %errorlevel%

REM Cambiar la contrasena de una cuenta (o crear el primer administrador):
REM services\auth\src\scripts\cambiarContrasena.js. Despues de "admin", el
REM usuario (opcional).
:admin
call :requiere_corriendo
if errorlevel 1 exit /b 1
if "%TERMINAL%"=="0" (
  call :falla "Necesita una terminal: pide la contrasena sin mostrarla."
  exit /b 1
)
docker compose exec auth-service node src/scripts/cambiarContrasena.js%RESTO%
exit /b %errorlevel%

:detener
call :requiere_docker
if errorlevel 1 exit /b 1
set "HAY_ALGO="
for /f %%c in ('docker compose ps -a -q 2^>nul') do set "HAY_ALGO=1"
for /f %%c in ('%MONITOREO_COMPOSE% --profile falco ps -a -q 2^>nul') do set "HAY_ALGO=1"
if not defined HAY_ALGO (
  call :ok "LiveMetric no estaba levantado: nada que apagar."
  exit /b 0
)
REM Primero el monitoreo: esta conectado a la red de la aplicacion, que si
REM no, no se puede borrar al bajarla.
<nul set /p "=%GRIS%   ... apagando el monitoreo y los microservicios%RESET%"
%MONITOREO_COMPOSE% --profile falco down >nul 2>nul
docker compose down --remove-orphans >nul 2>nul
echo.
call :ok "LiveMetric apagado. La base de datos y el historial del monitoreo quedan en sus volumenes."
exit /b 0

:borrar
REM Los volumenes guardan la base de datos: pedir confirmacion si hay
REM alguien para darla.
if "%TERMINAL%"=="0" goto :borrar_si
call :aviso "Esto borra tambien la base de datos de esta instalacion (elecciones, padron, actas)"
call :info "y el historial del monitoreo. El .env queda."
set "RESPUESTA="
set /p "RESPUESTA=     Seguro? [s/N] "
if /i "%RESPUESTA%"=="s" goto :borrar_si
if /i "%RESPUESTA%"=="si" goto :borrar_si
call :info "No se borro nada."
exit /b 0

:borrar_si
call :requiere_docker
if errorlevel 1 exit /b 1
REM --rmi local: las imagenes que construyo docker compose, no las
REM descargadas (postgres), que pueden ser de otros proyectos.
<nul set /p "=%GRIS%   ... borrando el monitoreo, los microservicios, sus volumenes y sus imagenes%RESET%"
%MONITOREO_COMPOSE% --profile falco down -v >nul 2>nul
docker compose down -v --rmi local --remove-orphans >nul 2>nul
echo.
call :ok "LiveMetric borrado: contenedores, volumenes con la base de datos e imagenes construidas."
exit /b 0

REM ===========================================================================
REM Subrutinas
REM ===========================================================================

REM Para los subcomandos: Docker ya tiene que estar, no se instala nada.
:requiere_docker
where docker >nul 2>nul
if errorlevel 1 (
  call :falla "Docker no esta instalado: scripts\start.bat lo instala."
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
set "CORRIENDO="
for /f %%c in ('docker compose ps -q 2^>nul') do set "CORRIENDO=1"
if not defined CORRIENDO (
  call :falla "LiveMetric no esta corriendo. Arrancalo con: scripts\start.bat"
  exit /b 1
)
exit /b 0

REM :terminal - TERMINAL=1 si la entrada y la salida son la consola: sin
REM una terminal de verdad (redirigido, CI) "docker compose exec" falla con
REM "the input device is not a TTY", y no hay como pedir una contrasena
REM sin mostrarla. La salida de powershell no se redirige: si no, nunca
REM veria la consola.
:terminal
set "TERMINAL=0"
powershell -NoProfile -Command "if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { exit 1 }" 2>nul
if not errorlevel 1 set "TERMINAL=1"
goto :eof

REM :puerto_disponible <puerto> <para que> <contenedor de LiveMetric que lo publica>
REM Si el puerto lo usa ese mismo contenedor (una corrida anterior de este
REM script), sirve: docker compose lo reemplaza. Si lo usa otra cosa, falla
REM aca (errorlevel 1) y no despues de todo el analisis.
:puerto_disponible
netstat -ano | findstr /r /c:":%~1 .*LISTENING" >nul
if errorlevel 1 (
  call :ok "Puerto %~1 libre, para %~2"
  exit /b 0
)
set "OCUPANTE="
for /f "delims=" %%n in ('docker ps --filter "publish=%~1" --format "{{.Names}}"') do set "OCUPANTE=%%n"
if /i "%OCUPANTE%"=="%~3" (
  call :ok "Puerto %~1, para %~2: lo usa LiveMetric de una corrida anterior, se reemplaza"
  exit /b 0
)
call :falla "El puerto %~1, para %~2, ya esta en uso en esta PC."
if /i "%OCUPANTE%"=="%NOMBRE_GLOBAL%" (
  call :info "Lo usa LiveMetric dentro del contenedor global, scripts\contenedor.bat."
  call :info "Apagalo con: scripts\contenedor.bat detener"
) else if defined OCUPANTE (
  call :info "Lo usa: %OCUPANTE%"
)
exit /b 1

REM :fase <n> <titulo> - encabezado de cada etapa grande.
:fase
echo.
echo %AZUL%%NEGRITA%== %~1/%FASES%  %~2 ==============================================%RESET%
goto :eof

REM Lineas de estado, con el mismo codigo de colores que el resto:
REM verde = listo, amarillo = hace falta atencion, rojo = error, gris = detalle.
REM Ningun texto usa el signo de exclamacion: con enabledelayedexpansion,
REM cmd.exe lo borra de los echo (por eso el aviso dice AVISO y no "!").
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

REM :ensure_tool <comando-a-buscar> <id-de-winget> <carpeta-de-instalacion>
REM Si <comando-a-buscar> ya esta en el PATH, no hace nada. Si no, y winget
REM esta disponible, lo instala en silencio y agrega <carpeta-de-instalacion>
REM al PATH de esta MISMA sesion (los instaladores solo actualizan el PATH
REM para sesiones nuevas, no la que ya esta corriendo). Si sigue sin
REM encontrarse despues de eso, marca REQUISITOS_OK=0.
:ensure_tool
set TOOL_CMD=%~1
set TOOL_WINGET_ID=%~2
set TOOL_EXTRA_PATH=%~3

where %TOOL_CMD% >nul 2>nul
if not errorlevel 1 (
  call :ok "%TOOL_CMD%"
  goto :eof
)

if "%HAS_WINGET%"=="0" (
  call :falla "%TOOL_CMD% no esta instalado, y winget no esta disponible en"
  call :info "esta PC para instalarlo solo. Instalalo a mano y volve a"
  call :info "correr este script."
  set REQUISITOS_OK=0
  goto :eof
)

call :aviso "%TOOL_CMD% no esta instalado. Instalando con winget (%TOOL_WINGET_ID%)..."
call winget install --id %TOOL_WINGET_ID% -e --silent --accept-package-agreements --accept-source-agreements
if not "%TOOL_EXTRA_PATH%"=="" (
  set "PATH=%PATH%;%TOOL_EXTRA_PATH%"
)

where %TOOL_CMD% >nul 2>nul
if errorlevel 1 (
  call :falla "%TOOL_CMD% se instalo pero todavia no se encuentra en el PATH"
  call :info "de esta sesion. Cerra esta terminal, abri una nueva, y volve"
  call :info "a correr este script."
  set REQUISITOS_OK=0
) else (
  call :ok "%TOOL_CMD% (instalado recien)"
)
goto :eof

REM :ensure_docker
REM Docker Desktop es distinto de los demas: incluso con el binario "docker"
REM ya en el PATH, el motor (el servicio que atiende docker compose/build)
REM puede no estar corriendo todavia (recien instalado, o la app no esta
REM abierta) - eso NO se puede terminar de resolver solo, hace falta que la
REM persona abra Docker Desktop una vez y complete el setup inicial.
:ensure_docker
where docker >nul 2>nul
if errorlevel 1 (
  if "%HAS_WINGET%"=="0" (
    call :falla "Docker no esta instalado, y winget no esta disponible en"
    call :info "esta PC para instalarlo solo. Instala Docker Desktop a mano"
    call :info "(https://www.docker.com/products/docker-desktop/) y volve"
    call :info "a correr este script."
    set REQUISITOS_OK=0
    goto :eof
  )
  call :aviso "Docker no esta instalado. Instalando Docker Desktop con winget..."
  call winget install --id Docker.DockerDesktop -e --silent --accept-package-agreements --accept-source-agreements
  call :aviso "Docker Desktop se instalo. Abrilo desde el menu Inicio,"
  call :info "completa la configuracion inicial (puede pedir reiniciar"
  call :info "Windows), espera a que termine de iniciar, y volve a correr"
  call :info "este script."
  set REQUISITOS_OK=0
  goto :eof
)

call docker info >nul 2>nul
if errorlevel 1 (
  call :falla "Docker esta instalado pero el motor no responde. Abri Docker"
  call :info "Desktop desde el menu Inicio y espera a que termine de"
  call :info "iniciar (el icono de la barra de tareas deja de animarse),"
  call :info "despues volve a correr este script."
  set REQUISITOS_OK=0
  goto :eof
)

call :ok "Docker Desktop (el motor responde)"
goto :eof

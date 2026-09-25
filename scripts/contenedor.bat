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
REM montado en solo lectura, etc.) esta al principio de scripts/contenedor.sh.
REM Los textos de este archivo van sin acentos: cmd.exe no lee los .bat como
REM UTF-8.
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\contenedor.bat [iniciar] [--detalle]   construye, analiza y levanta todo adentro
REM   scripts\contenedor.bat estado                  estado de cada contenedor de adentro
REM   scripts\contenedor.bat logs [servicio]         logs en vivo del stack de adentro
REM   scripts\contenedor.bat shell                   terminal dentro del contenedor global
REM   scripts\contenedor.bat detener                 apaga el contenedor global y todo lo de adentro
REM   scripts\contenedor.bat borrar                  ademas borra su imagen y el volumen de cache
REM
REM   set LIVEMETRIC_PUERTO=3100 y despues scripts\contenedor.bat   usa otro puerto de la PC

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "NOMBRE=livemetric-global"
set "IMAGEN=livemetric-global"
set "VOLUMEN=livemetric-global-docker"
set "PUERTO=%LIVEMETRIC_PUERTO%"
if not defined PUERTO set "PUERTO=3000"

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

REM El .env de esta carpeta se monta en solo lectura (nunca queda dentro de
REM la imagen); si no existe, se descifra adentro desde .env.gpg.
set "ARGS_ENV="
if exist .env set ARGS_ENV=-v "%cd%\.env:/livemetric/.env:ro"
docker run -d --name %NOMBRE% --privileged --restart unless-stopped -p %PUERTO%:3000 -v %VOLUMEN%:/var/lib/docker %ARGS_ENV% %IMAGEN% >nul
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
set "STACK_ANTERIOR="
for /f %%c in ('docker exec %NOMBRE% docker compose ps -a -q 2^>nul') do set "STACK_ANTERIOR=1"
if defined STACK_ANTERIOR (
  <nul set /p "=%GRIS%   ... bajando el stack que quedo de una corrida anterior%RESET%"
  docker exec %NOMBRE% docker compose down --remove-orphans >nul 2>nul
  echo.
  call :ok "Stack anterior bajado: solo se levanta de nuevo si el analisis pasa"
)

if exist .env (
  call :ok ".env de esta carpeta, montado adentro en solo lectura"
  goto :env_listo
)
if not exist .env.gpg (
  call :falla "No hay .env ni .env.gpg en esta carpeta."
  call :info "Copia .env.example a .env y completa los valores (ver README, Inicio rapido),"
  call :info "o pedi el .env.gpg + la passphrase a quien te comparta el proyecto."
  goto :fin_error
)
call :info "No hay .env, pero si .env.gpg: descifrandolo adentro (te va a pedir la passphrase)..."
docker exec -it %NOMBRE% gpg --quiet --output .env --decrypt .env.gpg
if errorlevel 1 (
  call :falla "No se pudo descifrar .env.gpg (passphrase incorrecta, o se cancelo)."
  call :info "Volve a correr este script para intentarlo de nuevo."
  goto :fin_error
)
call :ok ".env descifrado adentro del contenedor global, no queda en esta carpeta"
:env_listo

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
<nul set /p "=%GRIS%   ... docker compose up --build: construyendo y arrancando los contenedores%RESET%"
docker exec %NOMBRE% docker compose up -d --build > "%LOG_COMPOSE%" 2>&1
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
echo.
echo %VERDE%    scripts\contenedor.bat estado    estado de cada microservicio%RESET%
echo %VERDE%    scripts\contenedor.bat logs      logs en vivo, o: logs auth-service%RESET%
echo %VERDE%    scripts\contenedor.bat shell     terminal adentro%RESET%
echo %VERDE%    scripts\contenedor.bat detener   apagar todo%RESET%
echo %VERDE%%RAYA%%RESET%
if defined IP_LAN call :info "Si otra PC no llega, permiti el puerto %PUERTO% TCP en el Firewall de Windows, ver docs\instalacion-y-despliegue.md."
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
docker exec %NOMBRE% docker compose ps --format "table {{.Name}}\t{{.Status}}"
exit /b 0

:logs
call :requiere_corriendo
if errorlevel 1 exit /b 1
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
<nul set /p "=%GRIS%   ... apagando los microservicios de adentro y el contenedor global%RESET%"
docker exec %NOMBRE% docker compose down --remove-orphans >nul 2>nul
docker rm -f %NOMBRE% >nul
echo.
call :ok "Contenedor global apagado. La cache de imagenes queda en el volumen %VOLUMEN%."
exit /b 0

:borrar
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
echo %AZUL%%NEGRITA%== %~1/4  %~2 ==============================================%RESET%
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

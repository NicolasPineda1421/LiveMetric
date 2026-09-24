@echo off
REM LiveMetric - Equivalente para CMD de Windows de scripts/start.sh (sin
REM WSL2, sin bash): instala los requisitos que falten, prepara el .env,
REM corre el analisis de seguridad completo (scripts/pipeline-local.bat)
REM y, SOLO si todo pasa, levanta el stack con Docker Desktop y muestra
REM el link final.
REM
REM Requisitos (se intentan instalar solos via winget si faltan): gpg
REM (Gpg4win, solo hace falta si todavia no existe tu .env), Docker
REM Desktop, Node.js. winget viene incluido en Windows 10/11 modernos; si
REM no esta disponible, hay que instalar cada cosa a mano (se indica el
REM link).
REM
REM Los textos de este archivo van sin acentos a proposito: cmd.exe no lee
REM los .bat como UTF-8 y los mostraria desfigurados.
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\start.bat             resumen interpretado de cada paso
REM   scripts\start.bat --detalle   ademas, la salida completa de cada herramienta

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set ARG_DETALLE=
if /i "%~1"=="--detalle" set ARG_DETALLE=--detalle
if /i "%~1"=="-d" set ARG_DETALLE=--detalle

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

echo.
echo %AZUL%%RAYA%%RESET%
echo %AZUL%%NEGRITA%  LiveMetric - arranque con verificacion de seguridad%RESET%
echo %AZUL%%RAYA%%RESET%

REM --- 0. Verificar/instalar requisitos -------------------------------------
where winget >nul 2>nul
if errorlevel 1 (
  set HAS_WINGET=0
) else (
  set HAS_WINGET=1
)

call :fase 1 "Requisitos"
set REQUISITOS_OK=1
call :ensure_tool gpg "GnuPG.Gpg4win" "C:\Program Files (x86)\GnuPG\bin"
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

REM --- 1. Preparar el .env -------------------------------------------------
call :fase 2 "Configuracion (.env)"
if exist .env (
  call :ok ".env ya existe, se usa tal cual."
  goto :env_listo
)
if not exist .env.gpg (
  call :falla "No hay .env ni .env.gpg en esta carpeta."
  call :info "Copia .env.example a .env y completa los valores (ver README, Inicio rapido),"
  call :info "o pedi el .env.gpg + la passphrase a quien te comparta el proyecto."
  exit /b 1
)
call :info "No hay .env, pero si .env.gpg: descifrandolo (te va a pedir la passphrase)..."
call gpg --quiet --output .env --decrypt .env.gpg
if errorlevel 1 (
  call :falla "No se pudo descifrar .env.gpg (passphrase incorrecta, o se cancelo)."
  call :info "Volve a correr este script para intentarlo de nuevo."
  exit /b 1
)
call :ok ".env descifrado desde .env.gpg"
:env_listo

REM --- 2. Analisis de seguridad completo (el mismo que corre en CI) --------
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

REM --- 3. Levantar el stack --------------------------------------------------
call :fase 4 "Levantar LiveMetric"
set "COMPOSE_LOG=%TEMP%\livemetric-compose-%RANDOM%.log"
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
  echo %ROJO%    Logs en vivo: docker compose logs -f%RESET%
  echo %ROJO%%RAYA%%RESET%
  exit /b 1
)

REM Con el contenedor del frontend sano, esto solo confirma que el puerto
REM 3000 tambien responde desde afuera de Docker (mapeo de puertos, firewall).
set FRONTEND_UP=0
for /l %%i in (1,1,5) do (
  if "!FRONTEND_UP!"=="0" (
    call curl -sf http://127.0.0.1:3000 >nul 2>nul
    if not errorlevel 1 (
      set FRONTEND_UP=1
    ) else (
      call timeout /t 1 /nobreak >nul
    )
  )
)

REM URL para otras PCs de la misma red (el frontend se publica en
REM 0.0.0.0:3000); la IP la detecta scripts\lib\ip-local.js.
set "IP_LAN="
for /f "delims=" %%i in ('node scripts\lib\ip-local.js 2^>nul') do set "IP_LAN=%%i"

echo.
if "%FRONTEND_UP%"=="1" (
  echo %VERDE%%RAYA%%RESET%
  echo %VERDE%%NEGRITA%  OK - LiveMetric esta arriba%RESET%
  echo.
  echo %VERDE%    En esta PC:               http://localhost:3000%RESET%
  if defined IP_LAN (
    echo %VERDE%    Desde otra PC de la red:  http://%IP_LAN%:3000%RESET%
    echo %GRIS%    Si otra PC no llega, permiti el puerto 3000 TCP en el Firewall de Windows, ver docs\instalacion-y-despliegue.md.%RESET%
  ) else (
    echo %VERDE%    Desde otra PC de la red:  no se detecto una conexion de red%RESET%
  )
  echo %VERDE%    Logs en vivo:             docker compose logs -f%RESET%
  echo %VERDE%%RAYA%%RESET%
) else (
  echo %AMARILLO%%RAYA%%RESET%
  echo %AMARILLO%%NEGRITA%  ATENCION - Los contenedores estan sanos, pero http://localhost:3000 no responde.%RESET%
  echo %AMARILLO%    Revisa que nada mas use el puerto 3000 y los logs con: docker compose logs -f frontend%RESET%
  echo %AMARILLO%%RAYA%%RESET%
)

exit /b 0

REM ===========================================================================
REM Subrutinas
REM ===========================================================================

REM :fase <n> <titulo> - encabezado de cada etapa grande.
:fase
echo.
echo %AZUL%%NEGRITA%== %~1/4  %~2 ==============================================%RESET%
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

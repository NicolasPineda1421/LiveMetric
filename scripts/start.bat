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
REM La salida esta organizada en 4 pasos numerados con colores (verde = ok,
REM rojo = error, amarillo = aviso) y termina con un panel que muestra el
REM estado de cada contenedor y los links donde quedo cada servicio.
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\start.bat             (analisis resumido)
REM   scripts\start.bat --verbose   (ademas, la salida completa de cada herramienta)
REM   set NO_COLOR=1                (antes, para desactivar colores)

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "PIPELINE_ARGS="
if /i "%~1"=="--verbose" set "PIPELINE_ARGS=--verbose"
if /i "%~1"=="-v" set "PIPELINE_ARGS=--verbose"

call :init_colors
set "RULE===================================================================="
call :now START_TIME

echo %C_BLUE%%RULE%%C_NC%
echo %C_BOLD%  LiveMetric%C_NC% - arranque con verificacion de seguridad (Windows/CMD)
echo %C_GRAY%  1^) Requisitos  2^) Configuracion  3^) Analisis de seguridad  4^) Despliegue%C_NC%
echo %C_BLUE%%RULE%%C_NC%

REM --- 1. Verificar/instalar requisitos -------------------------------------
call :step 1 "Requisitos (gpg, Node.js, Docker Desktop)"
where winget >nul 2>nul
if errorlevel 1 (
  set HAS_WINGET=0
) else (
  set HAS_WINGET=1
)

set REQUISITOS_OK=1
call :ensure_tool gpg "GnuPG.Gpg4win" "C:\Program Files (x86)\GnuPG\bin"
call :ensure_tool node "OpenJS.NodeJS.LTS" "C:\Program Files\nodejs"
call :ensure_docker
if "%REQUISITOS_OK%"=="0" (
  echo.
  echo %C_BG_RED%  [X] FALTAN REQUISITOS  %C_NC%  No se pudieron instalar solos.
  echo      %C_GRAY%Revisa los mensajes en rojo de arriba, instalalos a mano y volve a correr este script.%C_NC%
  exit /b 1
)

REM --- 2. Preparar el .env -------------------------------------------------
call :step 2 "Configuracion (.env)"
if exist .env (
  call :ok ".env ya existe, se usa tal cual."
) else (
  if exist .env.gpg (
    call :info "No hay .env, pero si .env.gpg. Descifrando (te pedira la passphrase)..."
    call gpg --output .env --decrypt .env.gpg
    if errorlevel 1 (
      call :fail "No se pudo descifrar .env.gpg (passphrase incorrecta)."
      exit /b 1
    )
    call :ok ".env descifrado a partir de .env.gpg."
  ) else (
    call :fail "No hay .env ni .env.gpg en %cd%."
    call :hint "Copia .env.example a .env y completa los valores (ver README, seccion 3),"
    call :hint "o pedi el .env.gpg + la passphrase a quien te comparta el proyecto."
    exit /b 1
  )
)

REM --- 3. Analisis de seguridad completo (el mismo que corre en CI) --------
call :step 3 "Analisis de seguridad (el mismo que corre en CI)"
call :hint "Gitleaks, Semgrep, npm audit, Trivy y pruebas unitarias. Puede tardar varios"
call :hint "minutos: construye las 6 imagenes reales. Si algo falla, NO se levanta el stack."
echo.
call scripts\pipeline-local.bat %PIPELINE_ARGS%
if errorlevel 1 (
  echo.
  echo %C_RED%%RULE%%C_NC%
  echo %C_BG_RED%  [X] DESPLIEGUE CANCELADO  %C_NC%  El analisis encontro problemas.
  call :hint "No se levanto ningun contenedor. Corregi lo indicado en QUE HACER (arriba)"
  call :hint "y volve a correr scripts\start.bat"
  echo %C_RED%%RULE%%C_NC%
  exit /b 1
)

REM --- 4. Levantar el stack --------------------------------------------------
call :step 4 "Despliegue (docker compose up --build)"
set "BUILD_LOG=%TEMP%\livemetric-compose-%RANDOM%.log"
call :info "Construyendo y levantando los contenedores, puede tardar unos minutos..."
call :hint "Detalle en %BUILD_LOG%"
call docker compose up -d --build > "%BUILD_LOG%" 2>&1
if errorlevel 1 (
  call :fail "docker compose up fallo. Ultimas lineas del log:"
  for /f "delims=" %%L in ('node scripts\lib\report.js tail "%BUILD_LOG%" 15 2^>nul') do echo      %C_GRAY%^|%C_NC% %%L
  exit /b 1
)
call :ok "Contenedores creados."

call :info "Esperando a que el frontend responda (hasta 60s)..."
set FRONTEND_UP=0
for /l %%i in (1,1,30) do (
  if "!FRONTEND_UP!"=="0" (
    call curl -sf http://127.0.0.1:3000 >nul 2>nul
    if not errorlevel 1 (
      set FRONTEND_UP=1
    ) else (
      call timeout /t 2 /nobreak >nul
    )
  )
)

echo.
echo %C_BLUE%%RULE%%C_NC%
echo %C_BOLD%  ESTADO DE LOS SERVICIOS%C_NC%
echo %C_BLUE%%RULE%%C_NC%
echo.
echo    %C_BOLD%     Servicio   Estado           URL                           Notas%C_NC%
set ALL_UP=1
call :service_row frontend  livemetric-frontend  "http://localhost:3000"        "panel + votacion (abrir en el navegador)"
call :service_row auth      livemetric-auth      "http://localhost:3001/health" "API de login (solo este equipo)"
call :service_row voting    livemetric-voting    "http://localhost:3002/health" "API de votacion (solo este equipo)"
call :service_row analytics livemetric-analytics "http://localhost:3003/health" "API de resultados (solo este equipo)"
call :service_row scrutiny  livemetric-scrutiny  "http://localhost:3004/health" "API de escrutinio (solo este equipo)"
call :service_row scheduler livemetric-scheduler ""                             "worker interno, sin puerto"
call :service_row postgres  livemetric-postgres  ""                             "red interna, sin puerto"

REM IP de esta PC en la red local: el frontend se publica en 0.0.0.0:3000,
REM asi que otros equipos de la misma red pueden entrar por ahi (ver README,
REM "Para que otros equipos de la red lo vean", por el firewall).
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do if not defined LAN_IP set "LAN_IP=%%a"
if defined LAN_IP set "LAN_IP=%LAN_IP: =%"

call :now END_TIME
set /a TOTAL_SECS=END_TIME-START_TIME
if %TOTAL_SECS% lss 0 set /a TOTAL_SECS+=86400
call :fmt_time %TOTAL_SECS% TOTAL_FMT

echo.
echo %C_BLUE%%RULE%%C_NC%
if "%FRONTEND_UP%%ALL_UP%"=="11" (
  echo %C_BG_GREEN%  [OK] LIVEMETRIC ESTA ARRIBA  %C_NC%  ^(listo en %TOTAL_FMT%^)
) else if "%FRONTEND_UP%"=="1" (
  echo %C_BG_YELLOW%  [!] LIVEMETRIC ARRIBA CON AVISOS  %C_NC%  Algun servicio no esta sano ^(ver tabla^).
) else (
  echo %C_BG_YELLOW%  [!] EL FRONTEND NO RESPONDIO A TIEMPO  %C_NC%  Puede estar terminando de iniciar.
)
echo.
echo    %C_BOLD%Abrir:%C_NC%              %C_GREEN%%C_BOLD%http://localhost:3000%C_NC%
if defined LAN_IP echo    %C_BOLD%Desde la red local:%C_NC% %C_GREEN%http://%LAN_IP%:3000%C_NC%
echo.
echo    %C_BOLD%Comandos utiles:%C_NC%
echo      docker compose logs -f             %C_GRAY%ver los logs en vivo%C_NC%
echo      docker compose logs -f ^<servicio^>  %C_GRAY%logs de un solo servicio (ej: auth)%C_NC%
echo      docker ps                          %C_GRAY%estado de los contenedores%C_NC%
echo      docker compose down                %C_GRAY%apagar el stack%C_NC%
echo %C_BLUE%%RULE%%C_NC%

exit /b 0

REM ===========================================================================
REM Subrutinas
REM ===========================================================================

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
  call :ok "%TOOL_CMD% ya esta instalado."
  goto :eof
)

if "%HAS_WINGET%"=="0" (
  call :fail "%TOOL_CMD% no esta instalado, y winget no esta disponible en"
  call :hint "esta PC para instalarlo solo. Instalalo a mano y volve a"
  call :hint "correr este script."
  set REQUISITOS_OK=0
  goto :eof
)

call :info "%TOOL_CMD% no esta instalado. Instalando con winget (%TOOL_WINGET_ID%)..."
call winget install --id %TOOL_WINGET_ID% -e --silent --accept-package-agreements --accept-source-agreements
if not "%TOOL_EXTRA_PATH%"=="" (
  set "PATH=%PATH%;%TOOL_EXTRA_PATH%"
)

where %TOOL_CMD% >nul 2>nul
if errorlevel 1 (
  call :fail "%TOOL_CMD% se instalo pero todavia no se encuentra en el PATH"
  call :hint "de esta sesion. Cerra esta terminal, abri una nueva, y volve"
  call :hint "a correr este script."
  set REQUISITOS_OK=0
) else (
  call :ok "%TOOL_CMD% instalado correctamente."
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
    call :fail "Docker no esta instalado, y winget no esta disponible en"
    call :hint "esta PC para instalarlo solo. Instala Docker Desktop a mano"
    call :hint "(https://www.docker.com/products/docker-desktop/) y volve"
    call :hint "a correr este script."
    set REQUISITOS_OK=0
    goto :eof
  )
  call :info "Docker no esta instalado. Instalando Docker Desktop con winget..."
  call winget install --id Docker.DockerDesktop -e --silent --accept-package-agreements --accept-source-agreements
  call :warn "Docker Desktop se instalo. Abrilo desde el menu Inicio,"
  call :hint "completa la configuracion inicial (puede pedir reiniciar"
  call :hint "Windows), espera a que termine de iniciar, y volve a correr"
  call :hint "este script."
  set REQUISITOS_OK=0
  goto :eof
)

call docker info >nul 2>nul
if errorlevel 1 (
  call :fail "Docker esta instalado pero el motor no responde. Abri Docker"
  call :hint "Desktop desde el menu Inicio y espera a que termine de"
  call :hint "iniciar (el icono de la barra de tareas deja de animarse),"
  call :hint "despues volve a correr este script."
  set REQUISITOS_OK=0
  goto :eof
)

call :ok "Docker Desktop esta instalado y el motor responde."
goto :eof

REM :service_row <nombre> <contenedor> <url o ""> <nota>
REM Muestra el estado real del contenedor (y, si tiene puerto, si responde).
:service_row
set "_STATE=no existe"
set "_HEALTH="
for /f "delims=" %%s in ('docker inspect -f "{{.State.Status}}" %~2 2^>nul') do set "_STATE=%%s"
for /f "delims=" %%h in ('docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{end}}" %~2 2^>nul') do set "_HEALTH=%%h"
set "_ICON=%C_GREEN%[OK]"
set "_LABEL=en linea"
if defined _HEALTH set "_LABEL=!_HEALTH!"
if not "!_STATE!"=="running" (
  set "_ICON=%C_RED%[X] "
  set "_LABEL=!_STATE!"
  set ALL_UP=0
) else if "!_HEALTH!"=="unhealthy" (
  set "_ICON=%C_RED%[X] "
  set ALL_UP=0
) else if not "%~3"=="" (
  call curl -sf "%~3" >nul 2>nul
  if errorlevel 1 (
    set "_ICON=%C_YELLOW%[!] "
    set "_LABEL=no responde aun"
    set ALL_UP=0
  )
)
set "_N=%~1            "
set "_L=!_LABEL!                "
set "_U=%~3"
if not defined _U set "_U=-"
set "_U=!_U!                             "
echo    !_ICON! !_N:~0,10!%C_NC% !_L:~0,16! !_U:~0,29! %C_GRAY%%~4%C_NC%
goto :eof

REM Mensajes con el mismo formato en todo el script.
:ok
echo    %C_GREEN%[OK]%C_NC% %~1
goto :eof
:fail
echo    %C_RED%[X]  %~1%C_NC%
goto :eof
:warn
echo    %C_YELLOW%[!]  %~1%C_NC%
goto :eof
:info
echo    %C_BLUE%-^>%C_NC%   %~1
goto :eof
:hint
echo         %C_GRAY%%~1%C_NC%
goto :eof

REM :step <numero> <titulo>
:step
echo.
echo %C_BLUE%PASO %~1/4 - %~2%C_NC%
echo %C_GRAY%--------------------------------------------------------------------%C_NC%
goto :eof

REM :init_colors - Colores ANSI (Windows 10+). Se desactivan con NO_COLOR.
:init_colors
set "ESC="
if not defined NO_COLOR for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
if not defined ESC (
  set "C_BLUE=" & set "C_GREEN=" & set "C_RED=" & set "C_YELLOW=" & set "C_GRAY="
  set "C_BOLD=" & set "C_NC=" & set "C_BG_GREEN=" & set "C_BG_RED=" & set "C_BG_YELLOW="
  goto :eof
)
set "C_BLUE=%ESC%[1;34m"
set "C_GREEN=%ESC%[0;32m"
set "C_RED=%ESC%[0;31m"
set "C_YELLOW=%ESC%[0;33m"
set "C_GRAY=%ESC%[0;90m"
set "C_BOLD=%ESC%[1m"
set "C_NC=%ESC%[0m"
set "C_BG_GREEN=%ESC%[1;97;42m"
set "C_BG_RED=%ESC%[1;97;41m"
set "C_BG_YELLOW=%ESC%[1;30;43m"
goto :eof

REM :now <variable> - segundos desde medianoche (independiente del idioma).
:now
set "_t=%time: =0%"
set /a "%~1=(1%_t:~0,2%-100)*3600+(1%_t:~3,2%-100)*60+(1%_t:~6,2%-100)"
goto :eof

REM :fmt_time <segundos> <variable> - "1m05s" o "42s".
:fmt_time
set /a "_m=%~1/60, _s=%~1%%60"
set "_s2=0%_s%"
if %_m% gtr 0 (set "%~2=%_m%m%_s2:~-2%s") else (set "%~2=%_s%s")
goto :eof

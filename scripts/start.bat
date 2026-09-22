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
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\start.bat

setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ================================================================
echo  LiveMetric - arranque con verificacion de seguridad (Windows/CMD^)
echo ================================================================
echo.

REM --- 0. Verificar/instalar requisitos -------------------------------------
where winget >nul 2>nul
if errorlevel 1 (
  set HAS_WINGET=0
) else (
  set HAS_WINGET=1
)

echo -- Requisitos --------------------------------------------------------
set REQUISITOS_OK=1
call :ensure_tool gpg "GnuPG.Gpg4win" "C:\Program Files (x86)\GnuPG\bin"
call :ensure_tool node "OpenJS.NodeJS.LTS" "C:\Program Files\nodejs"
call :ensure_docker
if "%REQUISITOS_OK%"=="0" (
  echo.
  echo [X] Faltan requisitos que no se pudieron instalar solos. Revisa los
  echo     mensajes de arriba, instalalos a mano, y volve a correr este script.
  exit /b 1
)
echo.

REM --- 1. Preparar el .env -------------------------------------------------
if exist .env (
  echo [OK] .env ya existe, se usa tal cual.
) else (
  if exist .env.gpg (
    echo No hay .env, pero si .env.gpg. Descifrando ^(te pedira la passphrase^)...
    call gpg --output .env --decrypt .env.gpg
    if errorlevel 1 (
      echo Error: no se pudo descifrar .env.gpg ^(passphrase incorrecta^). 1>&2
      exit /b 1
    )
  ) else (
    echo Error: no hay .env ni .env.gpg en %cd%. 1>&2
    echo Copia .env.example a .env y completa los valores ^(ver README, seccion 3^), 1>&2
    echo o pedi el .env.gpg + la passphrase a quien te comparta el proyecto. 1>&2
    exit /b 1
  )
)
echo.

REM --- 2. Analisis de seguridad completo (el mismo que corre en CI) --------
echo ================================================================
echo  Analisis de seguridad (Gitleaks, Semgrep, SCA, Trivy, pruebas^)
echo  Esto puede tardar varios minutos - construye las 6 imagenes reales.
echo ================================================================
echo.
call scripts\pipeline-local.bat
if errorlevel 1 (
  echo.
  echo ================================================================
  echo [X] El analisis encontro problemas. NO se levantan los contenedores.
  echo     Revisa el detalle de arriba antes de volver a intentarlo.
  echo ================================================================
  exit /b 1
)
echo.

REM --- 3. Levantar el stack --------------------------------------------------
echo ================================================================
echo  Todo en verde. Levantando el stack (docker compose up --build^)...
echo ================================================================
call docker compose up -d --build

echo.
echo Esperando a que el frontend responda...
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
echo ================================================================
echo  Contenedores (docker ps^)
echo ================================================================
call docker ps --filter "name=livemetric-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo.
if "%FRONTEND_UP%"=="1" (
  echo ================================================================
  echo [OK] LiveMetric esta arriba.
  echo.
  echo    Frontend:  http://localhost:3000
  echo.
  echo    Logs en vivo:  docker compose logs -f
  echo ================================================================
) else (
  echo [!] El stack se levanto pero el frontend todavia no respondio a
  echo     tiempo. Revisa el estado con: docker ps
  echo     y los logs con:               docker compose logs -f
)

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
  echo    [OK] %TOOL_CMD% ya esta instalado.
  goto :eof
)

if "%HAS_WINGET%"=="0" (
  echo    [X] %TOOL_CMD% no esta instalado, y winget no esta disponible en
  echo        esta PC para instalarlo solo. Instalalo a mano y volve a
  echo        correr este script.
  set REQUISITOS_OK=0
  goto :eof
)

echo    %TOOL_CMD% no esta instalado. Instalando con winget ^(%TOOL_WINGET_ID%^)...
call winget install --id %TOOL_WINGET_ID% -e --silent --accept-package-agreements --accept-source-agreements
if not "%TOOL_EXTRA_PATH%"=="" (
  set "PATH=%PATH%;%TOOL_EXTRA_PATH%"
)

where %TOOL_CMD% >nul 2>nul
if errorlevel 1 (
  echo    [X] %TOOL_CMD% se instalo pero todavia no se encuentra en el PATH
  echo        de esta sesion. Cerra esta terminal, abri una nueva, y volve
  echo        a correr este script.
  set REQUISITOS_OK=0
) else (
  echo    [OK] %TOOL_CMD% instalado correctamente.
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
    echo    [X] Docker no esta instalado, y winget no esta disponible en
    echo        esta PC para instalarlo solo. Instala Docker Desktop a mano
    echo        ^(https://www.docker.com/products/docker-desktop/^) y volve
    echo        a correr este script.
    set REQUISITOS_OK=0
    goto :eof
  )
  echo    Docker no esta instalado. Instalando Docker Desktop con winget...
  call winget install --id Docker.DockerDesktop -e --silent --accept-package-agreements --accept-source-agreements
  echo    [!] Docker Desktop se instalo. Abrilo desde el menu Inicio,
  echo        completa la configuracion inicial ^(puede pedir reiniciar
  echo        Windows^), esperá a que termine de iniciar, y volve a correr
  echo        este script.
  set REQUISITOS_OK=0
  goto :eof
)

call docker info >nul 2>nul
if errorlevel 1 (
  echo    [X] Docker esta instalado pero el motor no responde. Abri Docker
  echo        Desktop desde el menu Inicio y esperá a que termine de
  echo        iniciar ^(el icono de la barra de tareas deja de animarse^),
  echo        despues volve a correr este script.
  set REQUISITOS_OK=0
  goto :eof
)

echo    [OK] Docker Desktop esta instalado y el motor responde.
goto :eof

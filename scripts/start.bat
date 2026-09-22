@echo off
REM LiveMetric - Equivalente para CMD de Windows de scripts/start.sh (sin
REM WSL2, sin bash): prepara el .env, corre el analisis de seguridad
REM completo (scripts/pipeline-local.bat) y, SOLO si todo pasa, levanta
REM el stack con Docker Desktop y muestra el link final.
REM
REM Requisitos: Docker Desktop instalado y corriendo, y (si todavia no
REM existe tu .env) gpg en el PATH (ej. Gpg4win: https://gpg4win.org/) mas
REM .env.gpg, o .env.example completado a mano (ver README, seccion 3).
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\start.bat

setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ================================================================
echo  LiveMetric - arranque con verificacion de seguridad (Windows/CMD^)
echo ================================================================
echo.

REM --- 1. Preparar el .env -------------------------------------------------
if exist .env (
  echo [OK] .env ya existe, se usa tal cual.
) else (
  if exist .env.gpg (
    echo No hay .env, pero si .env.gpg. Descifrando ^(te pedira la passphrase^)...
    gpg --output .env --decrypt .env.gpg
    if errorlevel 1 (
      echo Error: no se pudo descifrar .env.gpg ^(passphrase incorrecta, o gpg no esta en el PATH^). 1>&2
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

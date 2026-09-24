@echo off
REM LiveMetric - Equivalente para CMD de Windows de scripts/pipeline-local.sh
REM (sin WSL2, sin bash): corre los mismos controles de seguridad con
REM Docker Desktop. Igual que la version bash, cada paso termina en una
REM linea ya interpretada (cuantos secretos, CVE, hallazgos o pruebas
REM fallidas, y en que servicio) y al final muestra un cuadro con todos los
REM controles por servicio. La interpretacion la hace
REM scripts\lib\pipeline-resumen.js, compartido por las dos versiones.
REM
REM La salida completa de cada herramienta queda en un log por paso. Con
REM --detalle ademas se muestra en pantalla, al terminar cada paso (cmd.exe
REM no puede mostrarla en vivo y guardarla a la vez, como hace "tee").
REM
REM Requisitos: Docker Desktop instalado y corriendo, Node.js/npm en el
REM PATH de Windows (para "npm audit", las pruebas de Jest y el resumen).
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\pipeline-local.bat             resumen interpretado de cada paso
REM   scripts\pipeline-local.bat --detalle   ademas, la salida completa de cada herramienta

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set DETALLE=0
if /i "%~1"=="--detalle" set DETALLE=1
if /i "%~1"=="-d" set DETALLE=1
set PIPELINE_MOSTRAR_LOG=%DETALLE%

REM Colores ANSI (cmd.exe de Windows 10+ los interpreta). ESC es el
REM caracter de escape, que en batch no se puede escribir literal.
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "AZUL=%ESC%[34m"
set "ROJO=%ESC%[31m"
set "GRIS=%ESC%[2m"
set "NEGRITA=%ESC%[1m"
set "RESET=%ESC%[0m"

for %%R in (docker node npm) do (
  where %%R >nul 2>nul
  if errorlevel 1 (
    echo %ROJO%   X Este script necesita %%R instalado y en el PATH ^(ver README^).%RESET%
    exit /b 1
  )
)

set SERVICES=auth voting analytics scrutiny scheduler frontend
set BACKEND_SERVICES=auth voting analytics scrutiny scheduler
set "LOG_DIR=%TEMP%\livemetric-pipeline-local-%RANDOM%%RANDOM%"
mkdir "%LOG_DIR%"
set "RESULTADOS=%LOG_DIR%\resultados.jsonl"
set "RESUMEN=node scripts\lib\pipeline-resumen.js"
%RESUMEN% inicio "%RESULTADOS%"

REM start.bat ya muestra su propio encabezado para esta etapa.
if not defined LIVEMETRIC_DESDE_START (
  echo.
  echo %AZUL%====================================================================%RESET%
  echo %AZUL%%NEGRITA%  Pipeline DevSecOps local - mismos controles que GitHub Actions%RESET%
  echo %AZUL%====================================================================%RESET%
)
echo %GRIS%     Salida completa de cada paso: %LOG_DIR%%RESET%
if "%DETALLE%"=="0" echo %GRIS%     Para verla en pantalla: scripts\pipeline-local.bat --detalle%RESET%

REM --- 1. Gitleaks ------------------------------------------------------
call :paso 1
call :en_curso "Gitleaks revisando el historial"
docker run --rm -v "%cd%:/repo" zricethezav/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml --redact --verbose --no-banner > "%LOG_DIR%\gitleaks.log" 2>&1
call :resumir gitleaks - !errorlevel! "%LOG_DIR%\gitleaks.log"

REM --- 2. Semgrep (SAST) --------------------------------------------------
REM Igual que en CI: Semgrep no gatea por cantidad de hallazgos (no se le
REM pasa --error), asi que sus hallazgos se muestran "para revisar" y no
REM bloquean; lo que se valida es que el escaneo corra y genere el SARIF,
REM igual que "Verificar SARIF generado" en el workflow real.
call :paso 2
if exist semgrep-local.sarif del /q semgrep-local.sarif
call :en_curso "Semgrep analizando el codigo"
docker run --rm -v "%cd%:/src" -w /src semgrep/semgrep semgrep scan --config=p/owasp-top-ten --config=p/expressjs --config=p/nodejsscan --config=p/jwt --sarif --output=/src/semgrep-local.sarif . > "%LOG_DIR%\semgrep.log" 2>&1
set RC=!errorlevel!
REM El SARIF se escribe dentro del repo (es lo unico que el contenedor ve);
REM se pasa a la carpeta de logs para no dejarlo suelto en el repo.
if exist semgrep-local.sarif move /y semgrep-local.sarif "%LOG_DIR%\semgrep.sarif" >nul
call :resumir semgrep - !RC! "%LOG_DIR%\semgrep.log" "%LOG_DIR%\semgrep.sarif"

REM --- 3-4. npm audit + Trivy fs (SCA) por servicio -----------------------
call :paso 3
for %%S in (%SERVICES%) do (
  call :en_curso "%%S - npm audit"
  pushd services\%%S
  call npm install --package-lock-only --silent --ignore-scripts > "%LOG_DIR%\npm-install-%%S.log" 2>&1
  call npm audit --omit=dev --audit-level=high > "%LOG_DIR%\npm-audit-%%S.log" 2>&1
  set RC=!errorlevel!
  popd
  call :resumir npm-audit %%S !RC! "%LOG_DIR%\npm-audit-%%S.log"

  call :en_curso "%%S - Trivy (deps)"
  docker run --rm -v "%cd%:/repo" -w /repo aquasec/trivy:0.70.0 fs services/%%S --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress > "%LOG_DIR%\trivy-fs-%%S.log" 2>&1
  call :resumir trivy-fs %%S !errorlevel! "%LOG_DIR%\trivy-fs-%%S.log"
)

REM --- 5. docker build + Trivy image (Container Scan) ---------------------
call :paso 4
for %%S in (%SERVICES%) do (
  call :en_curso "%%S - construyendo la imagen"
  docker build -t livemetric-%%S-localcheck services\%%S > "%LOG_DIR%\docker-build-%%S.log" 2>&1
  set RC=!errorlevel!
  call :resumir build %%S !RC! "%LOG_DIR%\docker-build-%%S.log"
  if !RC!==0 (
    call :en_curso "%%S - Trivy (imagen)"
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "%cd%:/repo" aquasec/trivy:0.70.0 image livemetric-%%S-localcheck --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress > "%LOG_DIR%\trivy-image-%%S.log" 2>&1
    call :resumir trivy-image %%S !errorlevel! "%LOG_DIR%\trivy-image-%%S.log"
  )
  docker rmi livemetric-%%S-localcheck >nul 2>nul
)

REM --- 6. Pruebas unitarias -------------------------------------------------
call :paso 5
if exist .env (
  for %%S in (%BACKEND_SERVICES%) do (
    call :en_curso "%%S - pruebas"
    pushd services\%%S
    call npm ci --silent --ignore-scripts > "%LOG_DIR%\npm-install-test-%%S.log" 2>&1
    call npm test > "%LOG_DIR%\test-%%S.log" 2>&1
    set RC=!errorlevel!
    popd
    call :resumir pruebas %%S !RC! "%LOG_DIR%\test-%%S.log"
  )
) else (
  %RESUMEN% omitido "%RESULTADOS%" pruebas - "falta el .env en la raiz del repo"
)

REM Cuadro final: decide ademas el codigo de salida (1 si algo que bloquea fallo).
%RESUMEN% final "%RESULTADOS%" "%LOG_DIR%"
exit /b %errorlevel%

REM ===========================================================================
REM Subrutinas
REM ===========================================================================

REM :paso <n> - encabezado del paso n (los textos estan en pipeline-resumen.js).
:paso
%RESUMEN% paso %1
goto :eof

REM :en_curso <texto> - deja escrito "... <texto>" SIN salto de linea, para
REM que se vea que paso esta corriendo; la linea de resultado que imprime
REM pipeline-resumen.js despues lo pisa. "set /p" es la unica forma de
REM escribir sin salto de linea en batch (y se come los espacios iniciales:
REM por eso el texto arranca con el codigo de color). Sin bloques con
REM parentesis a proposito: el texto puede traerlos, ej. "Trivy (deps)".
:en_curso
if "%DETALLE%"=="0" goto :en_curso_sin_salto
echo %GRIS%   ^> %~1%RESET%
goto :eof
:en_curso_sin_salto
<nul set /p "=%GRIS%   ... %~1%RESET%"
goto :eof

REM :resumir <control> <servicio|-> <codigo-de-salida> <log> [sarif]
REM Interpreta el resultado de un paso e imprime su linea; tambien lo anota
REM para el cuadro final.
:resumir
%RESUMEN% resultado "%RESULTADOS%" %*
goto :eof

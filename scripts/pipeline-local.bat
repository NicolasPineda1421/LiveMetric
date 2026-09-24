@echo off
REM LiveMetric - Equivalente para CMD de Windows de scripts/pipeline-local.sh
REM (sin WSL2, sin bash): corre los mismos controles de seguridad con
REM Docker Desktop.
REM
REM Salida pensada para leerse de un vistazo: cada control muestra UNA linea
REM con su resultado ya interpretado (por ejemplo "2 CRITICAL, 1 HIGH" o
REM "11/12 pruebas OK") y, si falla, los hallazgos concretos. Al final hay
REM un resumen por control, una matriz por servicio y, para cada falla, que
REM hacer. La salida completa de cada herramienta queda en un log por paso
REM (con --verbose ademas se muestra en pantalla al terminar cada paso). El
REM parseo de los logs lo hace scripts\lib\report.js, igual que en bash.
REM
REM Requisitos: Docker Desktop instalado y corriendo, Node.js/npm en el
REM PATH de Windows (para "npm audit", las pruebas de Jest y el resumen).
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\pipeline-local.bat             (salida resumida)
REM   scripts\pipeline-local.bat --verbose   (ademas, la salida completa)
REM   set NO_COLOR=1                         (antes, para desactivar colores)

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set VERBOSE=0
if /i "%~1"=="--verbose" set VERBOSE=1
if /i "%~1"=="-v" set VERBOSE=1
if "%LIVEMETRIC_VERBOSE%"=="1" set VERBOSE=1

call :init_colors

where docker >nul 2>nul
if errorlevel 1 (
  echo %C_RED%[X] Este script necesita Docker Desktop instalado y corriendo.%C_NC%
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo %C_RED%[X] Este script necesita Node.js/npm en el PATH ^(npm audit, pruebas y el resumen^).%C_NC%
  exit /b 1
)

set SERVICES=auth voting analytics scrutiny scheduler frontend
set BACKEND_SERVICES=auth voting analytics scrutiny scheduler
set "LOG_DIR=%TEMP%\livemetric-pipeline-local-%RANDOM%%RANDOM%"
mkdir "%LOG_DIR%"
set "REPORT_JS=%cd%\scripts\lib\report.js"
set TOTAL_STEPS=6
set FAIL_COUNT=0
set "RULE=--------------------------------------------------------------------"
call :now PIPELINE_START

echo %C_BLUE%%RULE%%C_NC%
echo %C_BOLD% Pipeline DevSecOps local%C_NC%  %C_GRAY%(6 servicios, %TOTAL_STEPS% controles)%C_NC%
echo %C_GRAY%    Logs completos: %LOG_DIR%%C_NC%
if "%VERBOSE%"=="0" echo %C_GRAY%    Tip: --verbose muestra ademas la salida completa de cada herramienta.%C_NC%
echo %C_BLUE%%RULE%%C_NC%

REM --- 1. Gitleaks ------------------------------------------------------
call :step 1 "Secretos en el codigo (Gitleaks)" "Busca contrasenas, tokens o claves escritas por error en el repositorio."
set "LOG=%LOG_DIR%\gitleaks.log"
call :begin "Gitleaks"
call docker run --rm -v "%cd%:/repo" zricethezav/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml --redact --verbose --no-banner > "%LOG%" 2>&1
set RC=%errorlevel%
call :finish "%LOG%"
if "%RC%"=="0" (set R_GITLEAKS=OK) else (set R_GITLEAKS=X)
call :summary gitleaks "%LOG%"
set "D_GITLEAKS=!DETAIL!"
call :row %R_GITLEAKS% repo Gitleaks
if "%R_GITLEAKS%"=="X" (
  call :details gitleaks "%LOG%"
  set "HINT=Saca el secreto del codigo y rotalo (ya quedo expuesto en el historial). Si es un falso positivo, agregalo a .gitleaks.toml."
  call :add_fail "Secretos en el codigo (Gitleaks)" "%LOG%" gitleaks
)

REM --- 2. Semgrep (SAST) --------------------------------------------------
REM Igual que en CI: Semgrep no gatea por cantidad de hallazgos (no se le
REM pasa --error); lo que se valida es que el escaneo corra y genere el
REM SARIF, igual que "Verificar SARIF generado" en el workflow real. Los
REM hallazgos se muestran igual, como informacion para revisar.
call :step 2 "Analisis estatico del codigo (Semgrep SAST)" "Reglas OWASP Top 10 / Express / JWT. Los hallazgos son informativos: no bloquean."
set "LOG=%LOG_DIR%\semgrep.log"
set "SARIF=%LOG_DIR%\semgrep.sarif"
if exist semgrep-local.sarif del /q semgrep-local.sarif
call :begin "Semgrep"
call docker run --rm -v "%cd%:/src" -w /src semgrep/semgrep semgrep scan --config=p/owasp-top-ten --config=p/expressjs --config=p/nodejsscan --config=p/jwt --sarif --output=/src/semgrep-local.sarif . > "%LOG%" 2>&1
call :finish "%LOG%"
set R_SEMGREP=X
if exist semgrep-local.sarif (
  set R_SEMGREP=OK
  move /y semgrep-local.sarif "%SARIF%" >nul
)
call :summary semgrep "%SARIF%"
set "D_SEMGREP=!DETAIL!"
call :row %R_SEMGREP% repo Semgrep
if "%R_SEMGREP%"=="OK" (
  call :details semgrep "%SARIF%"
) else (
  set "HINT=El escaneo no llego a generar el reporte. Revisa el log: suele ser un problema de red al bajar las reglas o del montaje del repo en Docker."
  call :add_fail "Analisis estatico (Semgrep)" "%LOG%"
)

REM --- 3. npm audit (SCA) por servicio ---------------------------------
call :step 3 "Dependencias vulnerables (npm audit)" "Revisa las librerias de produccion de cada servicio contra la base de CVEs de npm."
set R_NPM=OK
set N_NPM=0
for %%S in (%SERVICES%) do call :npm_audit %%S

REM --- 4. Trivy fs (SCA) por servicio ----------------------------------
call :step 4 "Dependencias vulnerables (Trivy fs)" "Segunda opinion sobre package.json/package-lock.json: solo CVEs HIGH/CRITICAL con arreglo."
set R_TRIVYFS=OK
set N_TRIVYFS=0
for %%S in (%SERVICES%) do call :trivy_fs %%S

REM --- 5. docker build + Trivy image (Container Scan) ---------------------
call :step 5 "Imagenes de contenedor (docker build + Trivy image)" "Construye las imagenes reales y escanea el sistema base y las librerias que quedan adentro."
set R_CONTAINER=OK
set N_CONTAINER=0
for %%S in (%SERVICES%) do call :container %%S

REM --- 6. Pruebas unitarias -------------------------------------------------
call :step 6 "Pruebas unitarias (Jest + Supertest)" "Corre la suite de cada microservicio backend."
set N_TESTS=0
if exist .env (
  set R_TESTS=OK
  for %%S in (%BACKEND_SERVICES%) do call :unit_tests %%S
) else (
  set R_TESTS=-
  set "DETAIL=OMITIDAS: no hay .env en la raiz del repo"
  set "ELAPSED=0s"
  set "UP="
  call :row - - Jest
)

echo.
echo       %C_GRAY%Fuera de alcance local (se validan solo en GitHub Actions): Checkov,%C_NC%
echo       %C_GRAY%despliegue con Terraform y DAST con OWASP ZAP.%C_NC%

REM --- Resumen final -----------------------------------------------------
call :now PIPELINE_END
set /a TOTAL_SECS=PIPELINE_END-PIPELINE_START
if %TOTAL_SECS% lss 0 set /a TOTAL_SECS+=86400
call :fmt_time %TOTAL_SECS% TOTAL_FMT

echo.
echo %C_BLUE%%RULE%%C_NC%
echo %C_BOLD% RESUMEN DEL ANALISIS%C_NC%  %C_GRAY%(duracion total: %TOTAL_FMT%)%C_NC%
echo %C_BLUE%%RULE%%C_NC%
echo.
set "DETAIL=!D_GITLEAKS!"
call :sline %R_GITLEAKS% "Secretos en el codigo (Gitleaks)"
set "DETAIL=!D_SEMGREP!"
call :sline %R_SEMGREP% "Analisis estatico (Semgrep)"
call :by_service %N_NPM% 6
call :sline %R_NPM% "Dependencias (npm audit)"
call :by_service %N_TRIVYFS% 6
call :sline %R_TRIVYFS% "Dependencias (Trivy fs)"
call :by_service %N_CONTAINER% 6
call :sline %R_CONTAINER% "Imagenes (build + Trivy image)"
if "%R_TESTS%"=="-" (
  set "DETAIL=no hay .env en la raiz del repo"
) else (
  call :by_service %N_TESTS% 5
)
call :sline %R_TESTS% "Pruebas unitarias (Jest)"

echo.
echo %C_BOLD%   Servicio     npm audit   Trivy fs    build    Trivy img   pruebas  %C_NC%
echo    %C_GRAY%-------------------------------------------------------------------%C_NC%
for %%S in (%SERVICES%) do call :matrix_row %%S
echo    %C_GRAY%Leyenda:%C_NC% %C_GREEN%OK%C_NC% aprobado   %C_RED%X%C_NC% falla   %C_GRAY%-%C_NC% no aplica / no se corrio

if %FAIL_COUNT% gtr 0 (
  echo.
  echo %C_BOLD%%C_RED% QUE HACER ^(%FAIL_COUNT% problema/s^)%C_NC%
  for /l %%i in (1,1,%FAIL_COUNT%) do call :show_fail %%i
)

echo.
set ALL_OK=1
if not "%R_GITLEAKS%"=="OK" set ALL_OK=0
if not "%R_SEMGREP%"=="OK" set ALL_OK=0
if not "%R_NPM%"=="OK" set ALL_OK=0
if not "%R_TRIVYFS%"=="OK" set ALL_OK=0
if not "%R_CONTAINER%"=="OK" set ALL_OK=0
if "%R_TESTS%"=="X" set ALL_OK=0

if "%ALL_OK%"=="1" (
  echo %C_BG_GREEN%  [OK] TODO EN VERDE  %C_NC%  Todos los controles aprobaron localmente. Es seguro hacer push.
  if "%R_TESTS%"=="-" echo    %C_YELLOW%^(Las pruebas unitarias se omitieron por falta de .env.^)%C_NC%
  echo    %C_GRAY%Logs completos: %LOG_DIR%%C_NC%
  exit /b 0
) else (
  echo %C_BG_RED%  [X] HAY CONTROLES EN ROJO  %C_NC%  Revisa la seccion "QUE HACER" de arriba antes de hacer push.
  echo    %C_GRAY%Logs completos: %LOG_DIR%%C_NC%
  exit /b 1
)

REM ===========================================================================
REM Controles por servicio (uno por subrutina: evita los problemas de
REM expansion de variables dentro de bloques "for ( ... )" de cmd.exe)
REM ===========================================================================

:npm_audit
set "SVC=%~1"
set "LOG=%LOG_DIR%\npm-audit-%SVC%.log"
call :begin "npm audit %SVC%"
pushd services\%SVC%
call npm install --package-lock-only --silent --ignore-scripts > "%LOG_DIR%\npm-install-%SVC%.log" 2>&1
call npm audit --omit=dev --audit-level=high > "%LOG%" 2>&1
set RC=%errorlevel%
popd
call :finish "%LOG%"
call :summary npm-audit "%LOG%"
if "%RC%"=="0" (set "CELL_npm_%SVC%=OK") else (set "CELL_npm_%SVC%=X" & set R_NPM=X & set /a N_NPM+=1)
call :row !CELL_npm_%SVC%! %SVC% "npm audit"
if "!CELL_npm_%SVC%!"=="X" (
  call :details npm-audit "%LOG%"
  set "HINT=Hay dependencias con CVEs HIGH/CRITICAL. Proba: cd services\%SVC% && npm audit fix (y volve a correr las pruebas)."
  call :add_fail "npm audit - %SVC%" "%LOG%" npm-audit
)
goto :eof

:trivy_fs
set "SVC=%~1"
set "LOG=%LOG_DIR%\trivy-fs-%SVC%.log"
call :begin "Trivy fs %SVC%"
call docker run --rm -v "%cd%:/repo" -w /repo aquasec/trivy:0.70.0 fs services/%SVC% --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress > "%LOG%" 2>&1
set RC=%errorlevel%
call :finish "%LOG%"
call :summary trivy "%LOG%"
if "%RC%"=="0" (set "CELL_trivyfs_%SVC%=OK") else (set "CELL_trivyfs_%SVC%=X" & set R_TRIVYFS=X & set /a N_TRIVYFS+=1)
call :row !CELL_trivyfs_%SVC%! %SVC% "Trivy fs"
if "!CELL_trivyfs_%SVC%!"=="X" (
  call :details trivy "%LOG%"
  set "HINT=Actualiza en services\%SVC%\package.json las librerias listadas a la version corregida. Si el riesgo esta aceptado, documentalo en .trivyignore."
  call :add_fail "Trivy fs - %SVC%" "%LOG%" trivy
)
goto :eof

:container
set "SVC=%~1"
set "LOG=%LOG_DIR%\docker-build-%SVC%.log"
call :begin "docker build %SVC%"
call docker build -t livemetric-%SVC%-localcheck services\%SVC% > "%LOG%" 2>&1
set RC=%errorlevel%
call :finish "%LOG%"
call :summary build "%LOG%"
if not "%RC%"=="0" (
  set "CELL_build_%SVC%=X"
  set "CELL_image_%SVC%=-"
  set R_CONTAINER=X
  set /a N_CONTAINER+=1
  call :row X %SVC% build
  call :details build "%LOG%"
  set "DETAIL=no se escaneo (fallo el build)"
  set "ELAPSED=0s"
  call :row - %SVC% "Trivy image"
  set "HINT=La imagen no compila. Revisa el paso del Dockerfile que falla (al final del log)."
  call :add_fail "docker build - %SVC%" "%LOG%"
  goto :container_cleanup
)
set "CELL_build_%SVC%=OK"
call :row OK %SVC% build

set "LOG=%LOG_DIR%\trivy-image-%SVC%.log"
call :begin "Trivy image %SVC%"
call docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "%cd%:/repo" aquasec/trivy:0.70.0 image livemetric-%SVC%-localcheck --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress > "%LOG%" 2>&1
set RC=%errorlevel%
call :finish "%LOG%"
call :summary trivy "%LOG%"
if "%RC%"=="0" (set "CELL_image_%SVC%=OK") else (set "CELL_image_%SVC%=X" & set R_CONTAINER=X & set /a N_CONTAINER+=1)
call :row !CELL_image_%SVC%! %SVC% "Trivy image"
if "!CELL_image_%SVC%!"=="X" (
  call :details trivy "%LOG%"
  set "HINT=Si el CVE es del sistema base, actualiza la imagen FROM de services\%SVC%\Dockerfile; si es de una libreria, actualizala en package.json."
  call :add_fail "Trivy image - %SVC%" "%LOG%" trivy
)
:container_cleanup
call docker rmi livemetric-%SVC%-localcheck >nul 2>nul
goto :eof

:unit_tests
set "SVC=%~1"
set "LOG=%LOG_DIR%\test-%SVC%.log"
call :begin "pruebas %SVC%"
pushd services\%SVC%
call npm ci --silent --ignore-scripts > "%LOG_DIR%\npm-install-test-%SVC%.log" 2>&1
call npm test > "%LOG%" 2>&1
set RC=%errorlevel%
popd
call :finish "%LOG%"
call :summary jest "%LOG%"
if "%RC%"=="0" (set "CELL_tests_%SVC%=OK") else (set "CELL_tests_%SVC%=X" & set R_TESTS=X & set /a N_TESTS+=1)
call :row !CELL_tests_%SVC%! %SVC% Jest
if "!CELL_tests_%SVC%!"=="X" (
  call :details jest "%LOG%"
  set "HINT=Reproducilo con: cd services\%SVC% && npm test"
  call :add_fail "Pruebas unitarias - %SVC%" "%LOG%" jest
)
goto :eof

REM ===========================================================================
REM Subrutinas de presentacion
REM ===========================================================================

REM :init_colors - Colores ANSI (Windows 10+). Se desactivan con NO_COLOR.
:init_colors
set "ESC="
if not defined NO_COLOR for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
if not defined ESC (
  set "C_BLUE=" & set "C_GREEN=" & set "C_RED=" & set "C_YELLOW=" & set "C_CYAN="
  set "C_GRAY=" & set "C_BOLD=" & set "C_NC=" & set "C_BG_GREEN=" & set "C_BG_RED="
  set "C_UP="
  goto :eof
)
set "C_BLUE=%ESC%[1;34m"
set "C_GREEN=%ESC%[0;32m"
set "C_RED=%ESC%[0;31m"
set "C_YELLOW=%ESC%[0;33m"
set "C_CYAN=%ESC%[0;36m"
set "C_GRAY=%ESC%[0;90m"
set "C_BOLD=%ESC%[1m"
set "C_NC=%ESC%[0m"
set "C_BG_GREEN=%ESC%[1;97;42m"
set "C_BG_RED=%ESC%[1;97;41m"
REM Sube una linea y la borra: reemplaza el "(corriendo)" por el resultado.
set "C_UP=%ESC%[1A%ESC%[2K"
goto :eof

REM :step <numero> <titulo> <que revisa>
:step
echo.
echo %C_BLUE%[%~1/%TOTAL_STEPS%] %~2%C_NC%
echo       %C_GRAY%%~3%C_NC%
goto :eof

REM :begin <etiqueta> - avisa que arranca un control y toma el tiempo.
:begin
call :now STEP_START
echo       %C_CYAN%...%C_NC% %~1 %C_GRAY%(corriendo)%C_NC%
goto :eof

REM :finish <log> - calcula cuanto tardo y, con --verbose, muestra el log.
:finish
call :now STEP_END
set /a SECS=STEP_END-STEP_START
if %SECS% lss 0 set /a SECS+=86400
call :fmt_time %SECS% ELAPSED
set "UP=%C_UP%"
if "%VERBOSE%"=="1" (
  echo       %C_GRAY%+-- salida completa%C_NC%
  type "%~1"
  echo       %C_GRAY%+--%C_NC%
  set "UP="
)
goto :eof

REM :row <OK|X|-> <donde> <herramienta> - usa DETAIL, ELAPSED y UP.
:row
set "_W=%~2            "
set "_T=%~3              "
if "%~1"=="OK" (set "_I=%C_GREEN%[OK]%C_NC%" & set "_C=%C_GREEN%")
if "%~1"=="X"  (set "_I=%C_RED%[X] %C_NC%" & set "_C=%C_RED%")
if "%~1"=="-"  (set "_I=%C_YELLOW%[-] %C_NC%" & set "_C=%C_YELLOW%")
echo !UP!      !_I! !_W:~0,10! !_T:~0,12! !_C!!DETAIL!%C_NC% %C_GRAY%(!ELAPSED!)%C_NC%
set "UP="
goto :eof

REM :summary <tipo> <archivo> - deja en DETAIL el resumen de report.js.
:summary
set "DETAIL=(sin resumen, ver log)"
for /f "delims=" %%D in ('node "%REPORT_JS%" summary %~1 "%~2" 2^>nul') do set "DETAIL=%%D"
goto :eof

REM :details <tipo> <archivo> - lista los hallazgos concretos.
:details
for /f "delims=" %%L in ('node "%REPORT_JS%" details %~1 "%~2" 5 2^>nul') do echo           %C_GRAY%-%C_NC% %%L
goto :eof

REM :add_fail <titulo> <log> [tipo] - registra una falla (y el HINT actual).
:add_fail
set /a FAIL_COUNT+=1
set "FAIL_%FAIL_COUNT%_TITLE=%~1"
set "FAIL_%FAIL_COUNT%_LOG=%~2"
set "FAIL_%FAIL_COUNT%_KIND=%~3"
set "FAIL_%FAIL_COUNT%_HINT=!HINT!"
goto :eof

REM :show_fail <n> - una entrada de la seccion "QUE HACER".
:show_fail
set "_N=%~1"
set "_FT=!FAIL_%_N%_TITLE!"
set "_FL=!FAIL_%_N%_LOG!"
set "_FK=!FAIL_%_N%_KIND!"
set "_FH=!FAIL_%_N%_HINT!"
echo.
echo    %C_BOLD%%C_RED%%_N%^) !_FT!%C_NC%
set "_FOUND="
if defined _FK for /f "delims=" %%L in ('node "%REPORT_JS%" details %_FK% "%_FL%" 5 2^>nul') do (
  set "_FOUND=1"
  echo       %C_GRAY%-%C_NC% %%L
)
if not defined _FOUND (
  echo       %C_GRAY%+-- ultimas lineas del log%C_NC%
  for /f "delims=" %%L in ('node "%REPORT_JS%" tail "%_FL%" 8 2^>nul') do echo       %C_GRAY%^|%C_NC% %%L
  echo       %C_GRAY%+--%C_NC%
)
echo       %C_YELLOW%-^> Que hacer:%C_NC% !_FH!
echo       %C_GRAY%   Log completo: !_FL!%C_NC%
goto :eof

REM :sline <OK|X|-> <control> - una linea del resumen (usa DETAIL).
:sline
set "_S=%~2                                      "
if "%~1"=="OK" set "_I=%C_GREEN%[OK] APROBADO%C_NC%"
if "%~1"=="X"  set "_I=%C_RED%[X]  FALLA   %C_NC%"
if "%~1"=="-"  set "_I=%C_YELLOW%[-]  OMITIDO %C_NC%"
echo    !_I!  !_S:~0,34! %C_GRAY%!DETAIL!%C_NC%
goto :eof

REM :by_service <fallidos> <total> - deja el texto en DETAIL.
:by_service
if "%~1"=="0" (set "DETAIL=%~2/%~2 servicios OK") else (set "DETAIL=%~1 de %~2 servicios con problemas")
goto :eof

REM :matrix_row <servicio>
:matrix_row
set "_W=%~1            "
set "_LINE=   !_W:~0,12!"
for %%K in (npm trivyfs build image tests) do call :matrix_cell "!CELL_%%K_%~1!"
echo !_LINE!
goto :eof

:matrix_cell
if "%~1"=="OK" (set "_LINE=!_LINE!    %C_GREEN%OK%C_NC%     " & goto :eof)
if "%~1"=="X"  (set "_LINE=!_LINE!    %C_RED%X %C_NC%     " & goto :eof)
set "_LINE=!_LINE!    %C_GRAY%- %C_NC%     "
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

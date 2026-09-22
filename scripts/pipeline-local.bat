@echo off
REM LiveMetric - Equivalente para CMD de Windows de scripts/pipeline-local.sh
REM (sin WSL2, sin bash): corre los mismos controles de seguridad con
REM Docker Desktop, mostrando la salida real de cada herramienta.
REM
REM Requisitos: Docker Desktop instalado y corriendo, Node.js/npm en el
REM PATH de Windows (para "npm audit" y las pruebas de Jest).
REM
REM Uso (desde la raiz del repo, en un cmd.exe normal):
REM   scripts\pipeline-local.bat

setlocal enabledelayedexpansion
cd /d "%~dp0.."

where docker >nul 2>nul
if errorlevel 1 (
  echo Error: este script necesita Docker Desktop instalado y corriendo.
  exit /b 1
)

set SERVICES=auth voting analytics scrutiny scheduler frontend
set BACKEND_SERVICES=auth voting analytics scrutiny scheduler
set ALL_OK=1

echo.
echo === Pipeline DevSecOps local (Windows / CMD) ===

REM --- 1. Gitleaks ------------------------------------------------------
echo.
echo -- Secret Scanning (Gitleaks) --------------------------------------
call docker run --rm -v "%cd%:/repo" zricethezav/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml --redact --verbose --no-banner
if errorlevel 1 (
  echo    [X] Secret Scanning ^(Gitleaks^)
  set ALL_OK=0
) else (
  echo    [OK] Secret Scanning ^(Gitleaks^)
)

REM --- 2. Semgrep (SAST) --------------------------------------------------
REM Igual que en CI: Semgrep no gatea por cantidad de hallazgos (no se le
REM pasa --error); lo que se valida es que el escaneo corra y genere el
REM SARIF, igual que "Verificar SARIF generado" en el workflow real.
echo.
echo -- SAST (Semgrep: OWASP Top 10 / Express / JWT^) -----------------------
if exist semgrep-local.sarif del /q semgrep-local.sarif
call docker run --rm -v "%cd%:/src" -w /src semgrep/semgrep semgrep scan --config=p/owasp-top-ten --config=p/expressjs --config=p/nodejsscan --config=p/jwt --sarif --output=/src/semgrep-local.sarif .
if not exist semgrep-local.sarif (
  echo    [X] SAST ^(Semgrep^)
  set ALL_OK=0
) else (
  echo    [OK] SAST ^(Semgrep, ver los hallazgos arriba^)
  del /q semgrep-local.sarif
)

REM --- 3-4. npm audit + Trivy fs (SCA) por servicio -----------------------
echo.
echo -- SCA (npm audit + Trivy fs^) por servicio -----------------------------
for %%S in (%SERVICES%) do (
  pushd services\%%S
  call npm install --package-lock-only --silent --ignore-scripts >nul 2>nul
  popd

  echo.
  echo -- npm audit - %%S
  pushd services\%%S
  call npm audit --omit=dev --audit-level=high
  if errorlevel 1 (
    echo    [X] npm audit - %%S
    set ALL_OK=0
  ) else (
    echo    [OK] npm audit - %%S
  )
  popd

  echo.
  echo -- Trivy fs (SCA^) - %%S
  call docker run --rm -v "%cd%:/repo" -w /repo aquasec/trivy:0.70.0 fs services/%%S --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress
  if errorlevel 1 (
    echo    [X] Trivy fs - %%S
    set ALL_OK=0
  ) else (
    echo    [OK] Trivy fs - %%S
  )
)

REM --- 5. docker build + Trivy image (Container Scan) ---------------------
echo.
echo -- docker build + Trivy image (Container Scan^) -------------------------
for %%S in (%SERVICES%) do (
  echo.
  echo -- docker build - %%S
  call docker build -t livemetric-%%S-localcheck services\%%S
  if errorlevel 1 (
    echo    [X] docker build - %%S
    set ALL_OK=0
  ) else (
    echo    [OK] docker build - %%S

    echo.
    echo -- Trivy image (Container Scan^) - %%S
    call docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "%cd%:/repo" aquasec/trivy:0.70.0 image livemetric-%%S-localcheck --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed --scanners vuln --ignorefile /repo/.trivyignore --skip-version-check --no-progress
    if errorlevel 1 (
      echo    [X] Trivy image - %%S
      set ALL_OK=0
    ) else (
      echo    [OK] Trivy image - %%S
    )
  )
  call docker rmi livemetric-%%S-localcheck >nul 2>nul
)

REM --- 6. Pruebas unitarias -------------------------------------------------
echo.
if exist .env (
  echo -- Pruebas unitarias (Jest + Supertest^) --------------------------------
  for %%S in (%BACKEND_SERVICES%) do (
    pushd services\%%S
    call npm ci --silent --ignore-scripts >nul 2>nul
    popd

    echo.
    echo -- pruebas - %%S
    pushd services\%%S
    call npm test
    if errorlevel 1 (
      echo    [X] pruebas - %%S
      set ALL_OK=0
    ) else (
      echo    [OK] pruebas - %%S
    )
    popd
  )
) else (
  echo -- Pruebas unitarias: OMITIDAS ^(no hay .env en la raiz del repo^) ------
)

echo.
echo === Fuera de alcance local ===
echo    Checkov, el despliegue con Terraform y el DAST con OWASP ZAP
echo    requieren levantar el stack completo o corren distinto en CI;
echo    se validan solo en GitHub Actions.

echo.
if "%ALL_OK%"=="1" (
  echo [OK] Todo en verde localmente. Es seguro hacer push.
  exit /b 0
) else (
  echo [X] Hay controles en rojo. Revisa el detalle de arriba antes de hacer push.
  exit /b 1
)

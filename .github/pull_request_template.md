## Descripción

<!-- ¿Qué cambia este PR y por qué? -->

## Tipo de cambio

- [ ] `feature/` — nueva funcionalidad
- [ ] `fix/` — corrección de bug
- [ ] `hotfix/` — corrección urgente sobre `main`
- [ ] `chore/` — infraestructura, pipeline, dependencias, documentación

## Checklist antes de solicitar revisión

- [ ] La rama sigue la convención `tipo/descripcion-corta` (ver `docs/manual-desarrollo.md`, sección 6)
- [ ] Se ejecutó `docker compose up --build` localmente y el stack levanta sin errores
- [ ] `./scripts/pipeline-local.sh` termina en verde (Gitleaks, Semgrep, ESLint, npm audit, Trivy, pruebas)
- [ ] No se agregaron secretos, tokens ni contraseñas en el código (verificado localmente, ej. `gitleaks detect`)
- [ ] Si se tocó `services/*/package.json`, se corrió `npm audit` localmente
- [ ] Si se tocaron queries a PostgreSQL, siguen usando parámetros (`$1, $2, ...`), nunca concatenación de strings
- [ ] Si se tocó `infra/terraform/`, se corrió `terraform fmt` y `terraform validate`

## Impacto en seguridad

<!-- ¿Este cambio toca autenticación, votación, red Docker, o secretos?
     Si es así, describe brevemente el análisis de riesgo. -->

---
Antes de integrar este PR a `main`, el check **`Security Gate (resumen)`** del workflow `devsecops.yml` tiene que estar en verde.

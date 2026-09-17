## Descripción

<!-- ¿Qué cambia este PR y por qué? -->

## Tipo de cambio

- [ ] `feature/` — nueva funcionalidad
- [ ] `fix/` — corrección de bug
- [ ] `hotfix/` — corrección urgente sobre `main`
- [ ] `chore/` — infraestructura, pipeline, dependencias, documentación

## Checklist antes de solicitar revisión

- [ ] La rama sigue la convención `tipo/descripcion-corta` (ver `README.md` → Estrategia de ramas)
- [ ] Se ejecutó `docker compose up --build` localmente y el stack levanta sin errores
- [ ] No se agregaron secretos, tokens ni contraseñas en el código (verificado localmente, ej. `gitleaks detect`)
- [ ] Si se tocó `services/*/package.json`, se corrió `npm audit` localmente
- [ ] Si se tocaron queries a PostgreSQL, siguen usando parámetros (`$1, $2, ...`), nunca concatenación de strings
- [ ] Si se tocó `infra/terraform/`, se corrió `terraform fmt` y `terraform validate`

## Impacto en seguridad

<!-- ¿Este cambio toca autenticación, votación, red Docker, o secretos?
     Si es así, describe brevemente el análisis de riesgo. -->

---
Este PR **no podrá mezclarse a `main`** hasta que el check requerido **`Security Gate (resumen)`** del workflow `devsecops.yml` pase en verde y al menos un `CODEOWNER` apruebe los cambios.

# Pipeline DevSecOps

El pipeline (`.github/workflows/devsecops.yml`) sigue el enfoque **shift-left**: los controles de seguridad corren en cada `push` y `pull_request` a `main`, antes de que el código llegue a producción. El estado de la última corrida se ve en la insignia del README o con `./scripts/pipeline-status.sh`.

Todas las actions de terceros están **fijadas a un SHA de commit** (con la versión como comentario), no a un tag que su dueño podría mover.

## Fases

**Fase 1 — Planificación.** Modelado de amenazas en [`docs/threat-model/`](threat-model/): `livemetric.threatdragon.json` (se abre en [OWASP Threat Dragon](https://www.threatdragon.com/)) con DFD de nivel 0 y 1, y [`STRIDE-analysis.md`](threat-model/STRIDE-analysis.md) con la misma información en una tabla. Cada amenaza está anclada a un flujo o proceso real del sistema.

**Fase 2 — Codificación.**

| Job | Herramienta | Qué detiene |
|---|---|---|
| `secrets-scan` | **Gitleaks** | Commits con secretos, tokens o credenciales. Corre primero: si falla, no corre nada más. También corre **antes de cada commit** vía `scripts/git-hooks/pre-commit` (se instala una vez con `./scripts/install-hooks.sh`). |
| `dependency-audit` | **npm audit** | Vulnerabilidades conocidas (CVE) en las dependencias de los 6 servicios; falla ante severidad `high` o mayor. |
| `sast-scan` | **Semgrep** (OWASP Top 10, Express, nodejsscan, JWT) | Inyección SQL, debilidades en la verificación de JWT, configuraciones inseguras. Sus hallazgos se revisan pero no bloquean; los resultados van a GitHub Security. |
| `sca-scan` | **Trivy** (modo `fs`) | Lo mismo que npm audit sobre cada `package.json`, con la herramienta que pide el enunciado; umbral `CRITICAL`/`HIGH`. |

**Fase 3 — Integración / build.**

| Job | Herramienta | Qué detiene |
|---|---|---|
| `container-scan` | **Trivy** (modo imagen) | Construye las 6 imágenes reales y busca CVE `CRITICAL`/`HIGH` en el sistema base y las librerías. Las excepciones, siempre justificadas, van en `.trivyignore` (hoy no hay ninguna). |

**Fase 4 — Pruebas.**

| Job | Herramienta | Qué cubre |
|---|---|---|
| `unit-tests` | **Jest + Supertest** | Pruebas contra la app de Express en memoria de cada servicio, usando la Supabase real (decisión del proyecto: no hay base de staging). Todo dato de prueba lleva el prefijo `CITEST-` y se borra al final. Mide la **cobertura** de cada servicio. Localmente: `cd services/<nombre> && npm test`. |
| `coverage-badge` | GitHub Pages | Solo en `main`: junta la cobertura de los 5 servicios y la publica en GitHub Pages (`coverage.json` para la insignia del README y una página con el detalle). |
| `staging-deploy-and-dast` | **OWASP ZAP** (baseline) | Levanta el stack completo y lo ataca en `http://localhost:3000` como caja negra. El reporte queda como artefacto (`zap-baseline-report`); por ahora es un gate de **reporte**, no bloqueante. |

**Fase 5 — Despliegue.**

| Job | Herramienta | Qué cubre |
|---|---|---|
| `iac-scan` | **Checkov** | Malas prácticas en `infra/terraform/main.tf`: redes no aisladas, contenedores privilegiados, falta de límites, secretos en `.tf`. |
| `iac-deploy` | **Terraform** | Despliegue real: `terraform apply` levanta el stack (con su propio PostgreSQL local, nunca Supabase), un smoke test confirma que los 4 microservicios responden y `terraform destroy` limpia todo. |

| Job final | |
|---|---|
| `security-gate` | Resume el estado de todos los controles y falla si alguno falló. Es el *required check* recomendado para proteger `main`. |

Los hallazgos de Semgrep, Trivy y Checkov se suben en formato **SARIF** a **Security → Code scanning** de GitHub.

> **Terraform y Supabase:** `iac-deploy` usa un PostgreSQL local efímero, así que no puede tocar datos reales. Las pruebas y el DAST sí usan la Supabase real (con `docker compose`), por decisión del equipo: cada corrida escribe y borra datos de prueba con el prefijo `CITEST-`.
>
> **`scrutiny_ledger` es append-only:** las pruebas de Scrutiny que certifican una elección dejan esa acta para siempre en la base (borrarla sería romper la misma garantía de integridad que el sistema existe para dar). Como además borran sus votos, en **Reportes → Integridad del acta** esas elecciones aparecen "Alterada": el detector funciona como debe.

## Correr el mismo análisis en la PC

`./scripts/pipeline-local.sh` (o `scripts\pipeline-local.bat`) corre localmente los mismos controles, con los mismos comandos, para detectar problemas **antes** de hacer push. `start.sh` lo usa como paso previo a levantar el stack.

- Cada control termina en una línea ya interpretada: ✔ pasó, ⚠ para revisar (no bloquea), ✘ falló (bloquea). Debajo de un ✘ aparecen las líneas del log que explican por qué.
- Al final, un cuadro con todos los controles por servicio y la duración.
- La salida completa de cada herramienta queda en un log por paso; con `--detalle` además se ve en pantalla.
- Fuera de alcance local (solo en GitHub Actions): Checkov, el despliegue con Terraform y el DAST.

## Cómo comprobar que los controles bloquean de verdad

Cada prueba en un cambio aparte, revirtiéndolo después:

1. **Gitleaks** — Agregar una línea como `const JWT_SECRET = "sk_live_abcdef1234567890"` y hacer commit: `secrets-scan` debe fallar y bloquear el resto.
2. **npm audit** — Degradar una dependencia de `services/voting/package.json` a una versión con CVE conocidos y regenerar el lockfile: `dependency-audit` debe fallar.
3. **Semgrep** — Reemplazar una query parametrizada por concatenación, p. ej. `` `SELECT * FROM votes WHERE election_id = ${electionId}` ``: debe aparecer como hallazgo de inyección SQL.
4. **Trivy** — Cambiar la imagen base de un `Dockerfile` por una antigua con CVE conocidos (p. ej. `node:18.0.0`): `container-scan` debe fallar.
5. **Checkov** — Quitar `internal = true` de la red `db_net` en `infra/terraform/main.tf`: `iac-scan` debe fallar.

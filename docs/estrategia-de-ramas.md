# Estrategia de ramas (GitHub Flow)

LiveMetric usa **GitHub Flow**: una sola rama larga (`main`), que debe estar **siempre desplegable**, y ramas de corta duración para cada cambio.

```
main ●───────●───────────────●───────────────●──▶  (siempre desplegable, protegida)
      \       \               \               \
       ● feature/jwt-rate-limit ● fix/vote-race-condition ● chore/bump-trivy-action
       (PR → checks → review → squash merge → borrar rama)
```

## Convención de nombres

| Prefijo | Uso |
|---|---|
| `feature/<descripcion-corta>` | Nueva funcionalidad (ej. `feature/dashboard-live-updates`) |
| `fix/<descripcion-corta>` | Corrección de bug (ej. `fix/vote-race-condition`) |
| `hotfix/<descripcion-corta>` | Corrección urgente directo sobre `main` (ej. `hotfix/jwt-secret-rotation`) |
| `chore/<descripcion-corta>` | Infraestructura, pipeline, dependencias, docs (ej. `chore/bump-trivy-action`) |

## Flujo de trabajo

1. Crear la rama desde `main` actualizado: `git checkout -b feature/mi-cambio main`.
2. Desarrollar y hacer commits pequeños y descriptivos.
3. Abrir un **Pull Request hacia `main`** (se rellena automáticamente con `.github/pull_request_template.md`).
4. El pipeline `devsecops.yml` corre automáticamente sobre el PR; el job `security-gate` debe quedar en verde.
5. Al menos un **CODEOWNER** (ver `.github/CODEOWNERS`) debe aprobar los cambios en el área correspondiente (infraestructura, auth, etc.).
6. Merge por **squash** (historial lineal) y borrado automático de la rama.

## Protección de la rama `main`

GitHub no permite declarar branch protection como un archivo dentro del repo, así que esto se automatiza con `scripts/setup-branch-protection.sh` (usa GitHub CLI) en vez de configurarlo manualmente "a mano" en cada repo:

```bash
gh auth login
./scripts/setup-branch-protection.sh <tu-usuario-u-org>/LiveMetric
```

Esto aplica sobre `main`:
- Prohibido el push directo (todo cambio entra por Pull Request).
- Check requerido: **`Security Gate (resumen)`** debe pasar en verde (agrega Gitleaks + npm audit + SAST + Trivy + Checkov).
- Al menos 1 aprobación, con revisión obligatoria de CODEOWNERS.
- Historial lineal, sin `force-push` ni borrado de la rama `main`.

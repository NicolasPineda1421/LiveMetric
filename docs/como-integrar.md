# Cómo integrar estos archivos en LiveMetric

## 1. Dónde va cada archivo

```
LiveMetric/
├── .github/workflows/
│   └── release.yml                          ← NUEVO (no toca devsecops.yml)
└── docs/
    └── arquitectura/                        ← carpeta NUEVA
        ├── componentes.puml
        ├── despliegue.puml
        ├── secuencia-autenticacion.puml
        └── casos-de-uso.puml
```

Sugerencia de rama: `chore/uml-y-publicacion-dockerhub`.

---

## 2. Renderizar los diagramas

Los `.puml` son el **código fuente versionable** (que es lo que pide el enunciado), pero
para el informe PDF y para que se vean en GitHub hacen falta las imágenes.

### Opción rápida — contenedor, sin instalar nada

```bash
docker run --rm -v "$PWD":/work -w /work plantuml/plantuml \
  -tsvg docs/arquitectura/*.puml
```

Para el informe conviene además PNG en alta resolución:

```bash
docker run --rm -v "$PWD":/work -w /work plantuml/plantuml \
  -tpng -DPLANTUML_LIMIT_SIZE=16384 docs/arquitectura/*.puml
```

### Opción editor

Extensión *PlantUML* en VS Code (`Alt+D` para previsualizar) o
[plantuml.com/plantuml](https://plantuml.com/plantuml) pegando el contenido.

### Embeber en la documentación

En `docs/arquitectura.md`, después de la sección "Componentes":

```markdown
## Diagramas UML

### Diagrama de componentes
![Diagrama de componentes](arquitectura/componentes.svg)

### Diagrama de despliegue
![Diagrama de despliegue](arquitectura/despliegue.svg)

### Diagrama de secuencia — autenticación dual
![Secuencia de autenticación](arquitectura/secuencia-autenticacion.svg)

### Diagrama de casos de uso
![Casos de uso](arquitectura/casos-de-uso.svg)

> El código fuente de cada diagrama está en `docs/arquitectura/*.puml` y se
> versiona junto con el código de la aplicación.
```

Versionen tanto los `.puml` como los `.svg` generados: el evaluador no va a
renderizar nada, tiene que ver las imágenes directo en GitHub.

---

## 3. Configurar Docker Hub (una sola vez)

### 3.1 En Docker Hub

1. Creen la cuenta u organización del equipo (el enunciado pide "una cuenta del equipo").
   Si crean organización, el namespace es el nombre de la organización.
2. **Account Settings → Personal access tokens → Generate new token**
   - Descripción: `github-actions-livemetric`
   - Permisos: **Read & Write**
   - Copien el token: solo se muestra una vez.
3. Creen los 6 repositorios (o déjenlos que se creen solos en el primer push, si el
   namespace lo permite):
   `livemetric-auth`, `livemetric-voting`, `livemetric-analytics`,
   `livemetric-scrutiny`, `livemetric-scheduler`, `livemetric-frontend`.

> No usen la contraseña de la cuenta en el workflow. Un token se revoca sin tocar la
> cuenta, y es justo el tipo de decisión que conviene poder explicar en la sustentación.

### 3.2 En GitHub

**Settings → Secrets and variables → Actions**

| Tipo | Nombre | Valor |
|---|---|---|
| Secret | `DOCKERHUB_USERNAME` | usuario con el que se hace login |
| Secret | `DOCKERHUB_TOKEN` | el access token del paso anterior |
| Variable | `DOCKERHUB_NAMESPACE` | usuario u organización dueña de las imágenes |

`DOCKERHUB_NAMESPACE` va como **variable**, no como secret, a propósito: no es
información sensible y así aparece legible en los logs y en el resumen del release,
que es exactamente la evidencia que necesitan para el informe.

---

## 4. Publicar la versión 1.0.0

```bash
git checkout main && git pull
git tag -a v1.0.0 -m "Primera version publicada de LiveMetric"
git push origin v1.0.0
```

El workflow arranca solo. Para cada uno de los 6 servicios hace: construir → **escanear
con Trivy** → si pasa, login y publicar. Una imagen con CVEs CRITICAL/HIGH nunca llega a
Docker Hub, porque el login ocurre después del escaneo.

También pueden dispararlo a mano desde **Actions → LiveMetric Release → Run workflow**
indicando la versión (útil si necesitan republicar durante la sustentación sin crear un
tag nuevo).

Tags que quedan publicados por imagen: `1.0.0`, `1.0` y `latest`.

### Verificación

```bash
docker pull <NAMESPACE>/livemetric-auth:1.0.0
docker image inspect <NAMESPACE>/livemetric-auth:1.0.0 \
  --format '{{json .Config.Labels}}' | python3 -m json.tool
```

Los labels OCI deben mostrar el commit exacto que produjo la imagen. Eso es trazabilidad
de la cadena de suministro y vale la pena mencionarlo en el informe.

---

## 5. Actualizar el README

Agreguen en la sección de tecnologías o en una nueva sección "Imágenes publicadas":

```markdown
## Imágenes publicadas

Las imágenes se publican en Docker Hub bajo el namespace del equipo, versionadas con
semver, únicamente después de superar el escaneo de vulnerabilidades:

| Microservicio | Imagen |
|---|---|
| Auth | `<NAMESPACE>/livemetric-auth` |
| Voting | `<NAMESPACE>/livemetric-voting` |
| Analytics | `<NAMESPACE>/livemetric-analytics` |
| Scrutiny | `<NAMESPACE>/livemetric-scrutiny` |
| Scheduler | `<NAMESPACE>/livemetric-scheduler` |
| Frontend | `<NAMESPACE>/livemetric-frontend` |
```

---

## 6. Dos detalles a revisar

**Las actions nuevas están pineadas por SHA** (`docker/login-action`, `metadata-action`,
`build-push-action`, `setup-buildx-action`), igual que el resto de su pipeline. Los SHA
corresponden a las últimas versiones estables de cada major. Verifiquen la primera
ejecución: si alguna falla por versión, el comentario `# vX.Y.Z` al lado de cada SHA les
dice exactamente qué versión es.

**El diagrama de despliegue refleja el estado actual del compose** (proxy socat hacia
Supabase). Al final del archivo hay un bloque comentado con la variante 100% local, que
es la que construye su Terraform. Cuando decidan unificar los dos caminos, ese es el
archivo a actualizar — y conviene hacerlo antes de generar los SVG definitivos para el
informe.

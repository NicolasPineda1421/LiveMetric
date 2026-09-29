# Manual de seguridad

Para quien opera o audita la seguridad de LiveMetric: el modelo de amenazas, qué controla cada herramienta del pipeline y con qué configuración, cómo leer sus reportes y qué hacer con un hallazgo. Los controles dentro de la aplicación (cifrado, firma de actas, auditoría) están en [Decisiones y riesgos](decisiones-y-riesgos.md); el detalle de cada job, en [Pipeline DevSecOps](pipeline-devsecops.md).

## 1. Modelo de amenazas

El modelo formal está en [`threat-model/livemetric.threatdragon.json`](threat-model/livemetric.threatdragon.json), que se abre en [OWASP Threat Dragon](https://www.threatdragon.com/) con sus diagramas de flujo de datos de nivel 0 y 1. [`threat-model/STRIDE-analysis.md`](threat-model/STRIDE-analysis.md) tiene los mismos diagramas y las **15 amenazas** en una tabla, cada una anclada a un flujo o proceso real del sistema, con su categoría STRIDE, su estado y el control que la mitiga.

**Qué se protege:** el padrón (identidad de los votantes), los votos (su secreto y su unicidad), las actas certificadas (que no se alteren) y las credenciales de la instalación (el `.env`).

**Fronteras de confianza:**

| Frontera | Qué la cruza | Control principal |
|---|---|---|
| Red local → frontend | El navegador de administradores, auditores y votantes | Único puerto abierto (3000); JWT con rol en cada petición; rate limiting en los logins |
| Frontend → servicios | nginx reenvía `/auth`, `/voting`, `/analytics`, `/scrutiny` | `Host` fijo; los servicios solo se publican en `127.0.0.1` |
| Servicios → base de datos | Solo los 5 backends | Red interna `db-net` sin salida a Internet; el frontend no está conectado |
| Scheduler → Scrutiny | La orden de certificar | Token interno comparado en tiempo constante |

**Las amenazas más graves y su control:**

| Amenaza | STRIDE | Control |
|---|---|---|
| Suplantar a un votante conociendo su cédula | Spoofing | Cédula + PIN de 6 dígitos; 8 intentos fallidos cada 15 minutos por IP |
| Votar dos veces | Elevation of Privilege | `UNIQUE(election_id, voter_id_hash)` en la base |
| Alterar un acta certificada, aunque sea recalculando todos los hashes | Tampering | Tabla append-only + cadena de hashes + firma digital Ed25519 de cada acta |
| Fuga de la base de datos | Information Disclosure | Cédula, puesto y mesa cifrados con AES-256-GCM |
| Llegar a la base desde el frontend comprometido | Elevation of Privilege | Red `db-net` interna |
| Un secreto subido al repositorio | Information Disclosure | Gitleaks antes de cada commit y en el pipeline; `.env` generado por instalación |

Cuando se agrega una funcionalidad con un flujo de datos nuevo (un endpoint, un servicio, una integración), se agrega a los DFD y se revisa contra las seis categorías STRIDE, en el JSON de Threat Dragon y en la tabla.

## 2. Herramientas y su configuración

Todas son de código abierto y corren en el pipeline de GitHub Actions (`.github/workflows/devsecops.yml`). Salvo Checkov, Terraform y ZAP, también corren en la PC con `./scripts/pipeline-local.sh`.

| Herramienta | Qué revisa | Configuración en el proyecto | ¿Bloquea? |
|---|---|---|---|
| **Gitleaks** | Secretos en el código y en **todo el historial** de git | `.gitleaks.toml`: reglas por defecto + una propia para `JWT_SECRET`; excluye las plantillas (`.env.example`, `variables.tfvars.example`). `.gitleaksignore`: huellas de falsos positivos ya revisados. Corre también como hook antes de cada commit (`scripts/git-hooks/pre-commit`, solo sobre lo preparado) | **Sí**, y si falla no corre nada más |
| **Semgrep** | Código: inyección, JWT, Express, configuraciones inseguras | Reglas `p/owasp-top-ten`, `p/expressjs`, `p/nodejsscan` y `p/jwt`. Excepción: `nosemgrep: <regla>` con su motivo al lado | No: reporta a GitHub Security |
| **ESLint** + `eslint-plugin-security` | Código de los 6 servicios: `eval`, `child_process`, ReDoS, path traversal, prototype pollution, comparaciones sin tiempo constante; en el frontend, además, XSS y tabnabbing | `scripts/lib/eslint-reglas-seguridad.js`, todas las reglas como error. Excepción: `eslint-disable-next-line <regla> -- <motivo>` | **Sí** |
| **npm audit** | CVE en las dependencias de producción | `--omit=dev --audit-level=high` | **Sí**, desde severidad alta |
| **Trivy** (`fs`) | CVE en `package.json`/`package-lock.json` | `CRITICAL,HIGH`, `--ignore-unfixed`; excepciones en `.trivyignore` | **Sí** |
| **Trivy** (imagen) | CVE en las 6 imágenes construidas (sistema base y librerías) | Igual que el anterior. También en `release.yml`: una imagen con CVE críticas o altas no se publica en Docker Hub | **Sí** |
| **Checkov** | Terraform (`infra/terraform`): redes, privilegios, límites, secretos | `soft_fail: false`. Excepción: `#checkov:skip=<ID>:<motivo>` en el recurso | **Sí** |
| **OWASP ZAP** (baseline) | La aplicación desplegada, como caja negra, en `http://localhost:3000` | Escaneo pasivo, con las reglas alfa (`-a`) | No: el reporte queda como artefacto |
| **Jest** | Pruebas unitarias y de integración (incluye un ataque simulado contra las actas) | Base desechable y secretos aleatorios por corrida | **Sí** |

El lineamiento del curso menciona **Bandit**, que analiza código Python. LiveMetric está escrito en Node.js: el análisis estático equivalente lo hacen ESLint (con las reglas de seguridad) y Semgrep.

El *Security Gate*, último job del pipeline, resume el resultado real de cada control y falla si alguno falló.

## 3. Dónde ver los resultados

| Resultado | Dónde |
|---|---|
| Semgrep, ESLint, Trivy (dependencias e imágenes), Checkov | GitHub → **Security → Code scanning**, en formato SARIF. Se filtra por herramienta o por categoría (`eslint-auth`, `trivy-sca-voting`, `checkov-terraform`, …) |
| Gitleaks, npm audit, pruebas | El log de su job en GitHub → **Actions** → la corrida → el job |
| OWASP ZAP | El artefacto `zap-baseline-report` de cada corrida (`report_html.html`) |
| Cobertura de pruebas | Artefactos `coverage-<servicio>` y la insignia del README |
| Todo, en la PC | `./scripts/pipeline-local.sh` muestra cada resultado ya interpretado y un cuadro final; los logs completos quedan en la carpeta que indica al empezar (`/tmp/livemetric-pipeline-local.*`) |

Los hallazgos que tienen una excepción justificada en el código (`eslint-disable … -- motivo`, `nosemgrep`) no se suben a GitHub Security: GitHub no respeta la marca de "suprimido" de herramientas externas y los mostraría como alertas abiertas. Su justificación queda en el código, junto a la línea.

## 4. Cómo interpretar cada reporte

### Gitleaks

Cada hallazgo trae `RuleID` (qué tipo de secreto parece), `File` y `Line`, `Commit` (dónde entró) y `Fingerprint` (`commit:archivo:regla:línea`). El valor sale enmascarado (`--redact`).

- **Si es un secreto real**, borrarlo del código no alcanza: sigue en el historial, y el repositorio es público. Hay que **rotarlo** (sección 6) y después quitarlo del código.
- **Si es un falso positivo** (un valor de ejemplo), se agrega su fingerprint a `.gitleaksignore`, con un comentario que diga por qué no es un secreto.

### Semgrep

Cada resultado trae la regla, la severidad (`ERROR`, `WARNING`, `INFO`), el mensaje y la ubicación.

- Los `ERROR` y `WARNING` se revisan uno por uno.
- Los `INFO` suelen ser confirmaciones: hoy hay 33, y casi todos son de `p/nodejsscan` constatando protecciones que ya están (helmet, rate limiting).
- Un falso positivo se silencia con `nosemgrep: <id-de-la-regla>` en esa línea y el motivo al lado. Hoy hay uno: `missing-user` en el Dockerfile del contenedor global, porque su motor de Docker necesita root.

### ESLint

Cada hallazgo es `archivo:línea  regla  mensaje`, y el pipeline falla con cualquiera.

- **Si el código de verdad arma una clave, una ruta o una expresión regular con datos del usuario**, se corrige: validación, lista blanca o `Object.hasOwn` (ver `ownValue()` en el frontend).
- **Si no hay riesgo**, se justifica en la línea: `// eslint-disable-next-line <regla> -- <por qué no es un riesgo>`. Casi siempre es un índice numérico de un arreglo, o una clave que sale de una lista fija del propio código.
- Una excepción que ya no hace falta también es un error: no quedan justificaciones sueltas.

### npm audit

Por cada paquete vulnerable muestra la severidad, la vía por la que entra (dependencia directa o de otra) y si hay corrección (`fix available`).

- Lo habitual es actualizar la dependencia directa que la trae.
- `npm audit fix` sirve si no hay cambios de versión mayor; si los hay, conviene revisar primero qué cambia.

### Trivy

La tabla trae la librería o el paquete del sistema, el CVE, la severidad, la versión instalada y la versión que lo corrige (`Fixed Version`). Con `--ignore-unfixed`, solo aparecen los que ya tienen corrección.

- **En una imagen**, casi siempre se resuelve actualizando la imagen base (`node:20-alpine`, `nginx:1.27-alpine`, `postgres:16-alpine`) y reconstruyendo.
- **En dependencias**, se actualiza el paquete.
- **Si un CVE no aplica** (por ejemplo, la función vulnerable no se usa), va a `.trivyignore` con el motivo y la fecha en que se volverá a revisar. Hoy no hay ninguna excepción.

### Checkov

Cada hallazgo es un control (`CKV_DOCKER_…`, `CKV_TF_…`) sobre un recurso de `main.tf`, con un enlace a la guía que explica el riesgo y la corrección. Se corrige en el recurso; si no aplica, `#checkov:skip=<ID>:<motivo>` dentro de ese recurso.

### OWASP ZAP

El reporte HTML agrupa las alertas por riesgo (High, Medium, Low, Informational). De cada una muestra la descripción, las URL afectadas (instancias), la solución sugerida y sus referencias CWE y WASC. Lo que se revisa primero es High y Medium.

La última corrida (septiembre de 2026) dio **0 altas, 1 media, 7 bajas y 9 informativas**:

| Riesgo | Alerta | Lectura |
|---|---|---|
| Medio | *Content Security Policy (CSP) Header Not Set* | nginx no envía una política CSP. Es la defensa en profundidad contra XSS del frontend. Abierto |
| Bajo | *X-Content-Type-Options Header Missing* (1 instancia) | `/config.js` pierde las cabeceras de seguridad: en nginx, un `add_header` dentro de un `location` anula los del servidor. Abierto |
| Bajo | COEP, COOP, CORP y *Permissions-Policy* ausentes; nginx revela su versión (`Server`) | Endurecimiento del navegador y del servidor. Abierto |
| Bajo | *Timestamp Disclosure* | Constantes numéricas del JavaScript compilado (de las librerías) que ZAP interpreta como marcas de tiempo, por ejemplo `1604231423`. Falso positivo |
| Informativo | *Modern Web Application*, *Sec-Fetch-\**, *Storable Content*, … | Descripciones de la aplicación, no fallas |

Las alertas abiertas están registradas en [Decisiones y riesgos](decisiones-y-riesgos.md), con su plan.

## 5. Gestión de vulnerabilidades

Todo hallazgo, venga de la herramienta que venga, sigue el mismo camino:

1. **Detección.** Automática, en cada push y en la PC antes de hacerlo.
2. **Triage.** ¿Es real? ¿Se puede explotar en LiveMetric, con su configuración y su red? ¿Cuál es el impacto sobre lo que se protege (padrón, votos, actas, credenciales)? La severidad de la herramienta es el punto de partida, no la respuesta.
3. **Decisión:**
   - **Corregir**: siempre que se pueda.
   - **Mitigar**: si no se puede corregir todavía, con un control compensatorio documentado.
   - **Aceptar**: solo con una justificación escrita, en el lugar donde la herramienta la busca: `.trivyignore`, `.gitleaksignore`, `nosemgrep`, `eslint-disable … -- motivo` o `#checkov:skip`. Nunca para "hacer pasar el pipeline".
4. **Plazo, según la severidad:**

   | Severidad | Qué hace el pipeline | Plazo |
   |---|---|---|
   | Crítica o alta (dependencias e imágenes), cualquier hallazgo de ESLint, Checkov o Gitleaks | Bloquea | Antes de integrar: el cambio no pasa |
   | Media (Semgrep, ZAP) | Reporta | En el mismo ciclo de trabajo; antes de publicar la siguiente versión |
   | Baja e informativa | Reporta | Se revisan al publicar una versión |

5. **Verificación.** El pipeline en verde es la prueba de que la corrección funciona. Si el hallazgo lo permite, se agrega una prueba que lo reproduzca (como la del ataque a las actas en `services/scrutiny`).
6. **Registro.** Todo lo que no se corrigió de inmediato (aceptado, mitigado o abierto) va a la tabla de [Decisiones y riesgos](decisiones-y-riesgos.md): hallazgo, severidad, estado y justificación. Los corregidos quedan tachados en esa misma tabla, como historia.

**Dependencias:** además del bloqueo automático, conviene actualizar las dependencias y las imágenes base antes de cada versión, aunque no haya CVE: así las correcciones de seguridad llegan en cambios chicos y no en uno grande y urgente.

## 6. Secretos

Cada instalación genera su propio `.env` con secretos aleatorios (`scripts/lib/generar-env.js`, con permisos 600): no hay secretos compartidos entre personas ni en el repositorio, y el pipeline genera los suyos en cada corrida. Si un secreto se expone, se rota. Cada uno tiene sus consecuencias:

| Secreto | Cómo rotarlo | Qué pasa |
|---|---|---|
| `JWT_SECRET` | Valor nuevo en el `.env` y `docker compose up -d` | Todas las sesiones abiertas se cierran; hay que volver a ingresar |
| `INTERNAL_SERVICE_TOKEN` | Igual | Nada visible: scheduler y scrutiny toman el nuevo al reiniciarse |
| `POSTGRES_PASSWORD` | `ALTER USER livemetric PASSWORD '…'` en la consola SQL, después el `.env` y `docker compose up -d` | Nada, si se hace en ese orden. Solo con el `.env`, la base rechaza la contraseña nueva |
| `GRAFANA_ADMIN_PASSWORD` | `docker exec -it livemetric-grafana grafana cli admin reset-admin-password '<nueva>'` y el mismo valor en el `.env` | Grafana solo toma la variable de entorno al crearse: después, cambiarla en el `.env` no cambia la contraseña |
| `VOTER_ID_SALT` | **Solo entre elecciones** | Cambia el código con que se identifica a cada votante: durante una elección abierta, alguien que ya votó podría volver a hacerlo |
| `VOTERS_ENCRYPTION_KEY` | Requiere descifrar el padrón con la clave vieja y cifrarlo con la nueva; ese script todavía no existe | Cambiarla sin ese paso deja el padrón ilegible |
| `ACTA_SIGNING_KEY` / `ACTA_PUBLIC_KEY` | Par nuevo con `generar-env.js` (borrando las dos del `.env`) | Las actas nuevas se firman con la clave nueva, pero las anteriores pasan a verse como firmadas "con otra clave" (alteradas), porque el sistema no guarda claves anteriores |

Si el secreto llegó a un commit, rotarlo es obligatorio aunque después se borre: el repositorio es público y el historial se conserva.

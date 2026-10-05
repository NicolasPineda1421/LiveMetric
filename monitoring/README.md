# Observabilidad — Prometheus, Grafana, Loki y Falco

Stack de monitoreo de LiveMetric, correspondiente a la **Fase 6** del ciclo DevSecOps.

## De dónde salen las métricas

Conviene ser explícito en esto, porque es la decisión de diseño más importante del stack
y la primera que un evaluador va a preguntar:

**Los microservicios de LiveMetric no exponen un endpoint `/metrics`.** No tienen
instrumentación con `prom-client`. En lugar de afirmar lo contrario o de dejar tableros
vacíos, este stack obtiene observabilidad real por dos vías que no requieren tocar el
código de la aplicación:

| Fuente | Qué aporta |
|---|---|
| **cAdvisor** | CPU, memoria, red y reinicios por contenedor |
| **Blackbox exporter** | Disponibilidad y latencia de cada microservicio, sondeando los `/health` que ya exponen |
| **Promtail → Loki** | Logs de todos los contenedores, etiquetados por servicio |
| **node-exporter** | Métricas del host. **Viene desactivado** (comentado en el compose): en Docker Desktop sobre Windows mediría la VM de WSL2 y no el equipo. En un host Linux se activa descomentándolo |
| **Falco** | Detección de comportamiento anómalo en tiempo de ejecución |

La sonda sobre `/health` es lo que convierte esto en observabilidad de la **aplicación** y
no solo de la infraestructura: responde a la pregunta que de verdad importa en un sistema
electoral — *¿el servicio de votación está respondiendo ahora mismo?* — sin necesidad de
instrumentar nada.

## Componentes

| Servicio | Puerto | Función |
|---|---|---|
| Grafana | 3010 | Visualización |
| Prometheus | 9090 | Recolección y almacenamiento de métricas |
| cAdvisor | — | Métricas por contenedor |
| node-exporter | — | Métricas del host (desactivado por defecto, ver arriba) |
| Blackbox exporter | — | Sondas HTTP |
| Loki | — | Agregación de logs |
| Promtail | — | Recolección de logs |
| Falco | — | Detección en runtime |

Ambos puertos se publican **solo en `127.0.0.1`**, igual que los microservicios: el
monitoreo no debe ser alcanzable desde la red.

## Puesta en marcha

### 1. Contraseña de Grafana

Está en el `.env` de la raíz del repositorio (`GRAFANA_ADMIN_USER` y
`GRAFANA_ADMIN_PASSWORD`), que los scripts de arranque generan con una contraseña
aleatoria. En un `.env` de antes, `node scripts/lib/generar-env.js` agrega esas dos
variables sin tocar las demás.

El compose **falla a propósito** si `GRAFANA_ADMIN_PASSWORD` no está definida. Es
preferible a arrancar con la contraseña por defecto de Grafana, que es pública y
conocida — precisamente el tipo de credencial sembrada que ya eliminaron del servicio de
autenticación.

### 2. Levantar

**Con `start.sh`, `start.bat` o el contenedor global** (`./scripts/contenedor.sh`) no hay
que hacer nada: el monitoreo se levanta junto a la aplicación, en los puertos 3010 y 9090
(solo en `127.0.0.1`; otros con `LIVEMETRIC_PUERTO_GRAFANA` y
`LIVEMETRIC_PUERTO_PROMETHEUS`) y, en Linux con eBPF, con Falco (`LIVEMETRIC_FALCO=0` lo
deja afuera; `LIVEMETRIC_MONITOREO=0`, todo el monitoreo). `./scripts/start.sh logs grafana`
o `logs falco` muestran sus logs, y `./scripts/start.sh detener` lo apaga junto con la
aplicación. Lo que sigue es para la aplicación levantada con `docker compose` directo.

```bash
# Primero la aplicación, que es quien crea la red app-net
docker compose up -d

# Después el monitoreo
docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml up -d

# O con Falco (solo en Linux, ver más abajo)
docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml --profile falco up -d
```

`--env-file .env` hace falta: con `-f` apuntando a `monitoring/`, Compose buscaría el
`.env` en esa carpeta y no en la raíz.

El orden importa: el stack de monitoreo se conecta a la red `livemetric_app-net` como red
externa. Si la aplicación no está levantada, esa red no existe y el arranque falla.

### 3. Entrar

- **Grafana:** http://localhost:3010 — el tablero *LiveMetric — Estado del sistema
  electoral* aparece ya cargado en la carpeta LiveMetric.
- **Prometheus:** http://localhost:9090 — pestaña *Status → Targets* para verificar que
  todas las sondas están en verde.

### Detener

```bash
docker compose --env-file .env -f monitoring/docker-compose.monitoring.yml down
```

Con `-v` si además quieren borrar las métricas y logs históricos. Con los scripts:
`./scripts/start.sh detener` (o `borrar`, que además borra el historial y la base).

## El tablero

![Tablero de Grafana: disponibilidad, recursos, registros y alertas de Falco](../docs/img/grafana-tablero.png)

Cuatro secciones:

**Disponibilidad del servicio.** Cuántos de los cinco endpoints responden, el estado de
cada uno en el tiempo, la latencia por servicio y un indicador dedicado al **worker de
programación**.

Ese último panel merece explicación: el scheduler es el único responsable de abrir,
cerrar y certificar elecciones. Si se detiene, el proceso electoral se congela sin que
nadie lo note — no hay error visible en la interfaz, simplemente las elecciones dejan de
cerrarse. Es el punto único de fallo del sistema, y por eso tiene su propio panel y su
propia alerta.

**Recursos por contenedor.** CPU y memoria de los servicios de la aplicación y la base.
Vienen de cAdvisor, que necesita la versión 0.5x o posterior con Docker 29: ese Docker
guarda las imágenes en containerd, y cAdvisor 0.49 no lo sabe leer, así que no reconocía
ningún contenedor y los paneles quedaban vacíos.

**Registros.** Tres paneles de Loki:
- Intentos de autenticación fallidos. Un repunte súbito puede indicar fuerza bruta contra el padrón. auth escribe cada evento de auditoría en su log como una línea JSON, con los mismos datos de la tabla y sin cédulas ni contraseñas.
- Errores de la aplicación, por palabra completa (`error`, `exception`, `fatal`).
- Actividad del proceso electoral, filtrando scheduler y scrutiny. Permite verificar que la apertura, el cierre y la certificación ocurren en los tiempos previstos.

**Seguridad en tiempo de ejecución.** Cuántas alertas de Falco hubo en la última hora (en
funcionamiento normal, 0) y la lista, con la prioridad, la regla y el contenedor. Solo los
contenedores de LiveMetric: Falco también ve el sistema anfitrión, pero eso queda en su
log.

## Alertas

Definidas en `prometheus/alerts.yml`, bajo un criterio: alertar solo sobre condiciones que
exigen acción humana. Una alerta que nadie atiende entrena al equipo a ignorar el tablero.

| Alerta | Severidad | Condición |
|---|---|---|
| `ServicioCaido` | crítica | Un `/health` lleva más de 1 minuto sin responder |
| `SchedulerCaido` | crítica | El worker lleva más de 2 minutos inactivo |
| `LatenciaAlta` | advertencia | Más de 2 s de respuesta durante 3 minutos |
| `ContenedorReiniciandose` | advertencia | Reinicio inesperado en los últimos 15 minutos |
| `MemoriaAlta` | advertencia | Más del 90 % del límite durante 5 minutos (solo contenedores con límite, como los de Swarm) |

Las alertas se evalúan y se ven en Prometheus (*Alerts*). No hay envío de notificaciones
configurado: eso requiere Alertmanager y un canal de destino, y está fuera del alcance.

## Falco — detección en tiempo de ejecución

Falco es la última capa de defensa: detecta comportamiento anómalo **dentro** de los
contenedores mientras corren, que es justo lo que los escaneos estáticos del pipeline no
pueden ver, porque ocurre después del despliegue.

Las reglas de `falco/falco_rules.local.yaml` aprovechan una propiedad del diseño de
LiveMetric: como los contenedores corren con `read_only: true`, usuario no-root y
`no-new-privileges`, cualquier escritura fuera de `/tmp`, cualquier shell interactiva y
cualquier intento de cambio de identidad son, por definición, anómalos. Eso permite
reglas estrictas con muy pocos falsos positivos.

| Regla | Prioridad |
|---|---|
| Shell abierta en contenedor | WARNING |
| Escritura fuera de `/tmp` | ERROR |
| Conexión saliente inesperada | NOTICE |
| Intento de escalada de privilegios | CRITICAL |

Solo aplican a los 6 contenedores de la aplicación (y la base, en las de shell y
escalada), no a los del monitoreo, que también se llaman `livemetric-*` y escriben en sus
volúmenes todo el tiempo. Detalles que evitan falsos positivos:

- La regla de shell exige una terminal (`proc.tty != 0`): los healthchecks de Docker corren
  `sh -c ...` cada 30 segundos, sin terminal, y no son anómalos.
- La de escrituras ignora a `runc`, que es el propio Docker preparando cada healthcheck.
- La de conexiones mira el extremo servidor (`fd.sip`, `fd.sport`) y deja pasar el
  loopback de IPv6, que el scheduler usa en cada ciclo.
- Falco corre con `rule_matching=all`: por defecto solo emite la primera regla que
  coincide con cada evento, y sus reglas genéricas se cargan antes y dejarían mudas a las
  de LiveMetric.

### Cómo levantarlo

Es opcional, con el perfil `falco` (ver "Levantar"), porque instrumenta el kernel del host:
necesita Linux con un kernel 5.8 o posterior con BTF (`/sys/kernel/btf/vmlinux`), y usa el
motor eBPF moderno, sin compilar ni cargar ningún módulo. En Docker Desktop (Windows,
WSL2) los contenedores corren sobre el kernel de una VM y no hay garantías. Las alertas
salen en JSON y Promtail las lleva a Loki, de donde las toma el tablero.

**Si la PC se suspende, reinicia Falco** (`docker restart livemetric-falco`): al volver de
una suspensión dejó de ver las conexiones de red (las reglas de procesos seguían
funcionando), y reiniciarlo lo resolvió.

### Verlo funcionando (útil para el video)

| Ataque | Comando | Alerta |
|---|---|---|
| Shell interactiva en un servicio | `docker exec -it livemetric-auth sh` | *Shell abierta en contenedor LiveMetric* (WARNING) |
| Intento de cambiar de usuario | `docker exec livemetric-voting su -c id` | *Intento de escalada de privilegios* (CRITICAL) |
| Conexión a Internet desde un servicio | `docker exec livemetric-auth node -e "require('net').connect(80,'1.1.1.1')"` | *Conexión saliente inesperada* (NOTICE), con el destino |
| Escritura fuera de `/tmp` | `docker exec livemetric-frontend sh -c 'echo x > /usr/share/nginx/html/x'` | Ninguna: el sistema de archivos de solo lectura la impide antes. La regla es la alarma para el día en que alguien quite el `read_only` |

Las alertas aparecen en segundos en el tablero de Grafana y en `docker logs livemetric-falco`.

## Privilegios elevados: una advertencia honesta

**cAdvisor y Falco corren en modo privilegiado** y montan rutas del host. Es inherente a
su función: no se puede instrumentar el kernel ni leer las métricas de todos los
contenedores desde un contenedor sin privilegios.

Esto significa que el stack de monitoreo tiene **más privilegios que la aplicación que
vigila**, y debe declararse en lugar de disimularse. En un despliegue real, el monitoreo
correría en un plano separado con su propio control de acceso. Conviene mencionarlo en la
sustentación antes de que lo pregunten: reconocer el trade-off demuestra que se entendió
lo que se desplegó.

En el contenedor global hay una concesión más: con Falco activado, ese contenedor corre
con `--pid=host`, porque Falco necesita el `/proc` de la PC para atribuir cada evento al
proceso y al contenedor correctos (con el del contenedor global atribuía a los servicios
escrituras que hacía la PC). Se desactiva con `LIVEMETRIC_FALCO=0`.

Por la misma razón el stack se levanta con un compose **aparte**: el monitoreo no debe
poder tumbar lo que monitorea. Si Grafana consume memoria de más o Loki llena el disco, la
votación sigue funcionando.

## Verificado

En un host Linux (Ubuntu, kernel 7.0, Docker 29), con la aplicación y el monitoreo con
Falco levantados:

- Prometheus: los 7 objetivos en verde (5 sondas de salud, cAdvisor y el propio Prometheus).
- Las 5 alertas evalúan sin errores. Probadas de verdad:
  - `ServicioCaido` pasa a *firing* a los 90 segundos de detener voting.
  - `SchedulerCaido` pasa a *pending* al detener el scheduler.
  - El panel del worker pasa de ACTIVO a DETENIDO.
- Loki recibe los logs de todos los contenedores con sus etiquetas, y los paneles de
  registros muestran datos reales.
- Falco: ninguna alerta en varios minutos de tráfico normal (logins, API, ciclos del
  scheduler, sondas), y los tres ataques de la tabla detectados.

## Trabajo futuro

**Instrumentar los servicios con `prom-client`.** Es el paso que falta para tener métricas
de negocio en vez de solo métricas de infraestructura: votos por minuto, logins fallidos
por origen, duración de la certificación, tamaño de la cadena de actas. Requiere agregar
la dependencia a cada servicio y exponer `/metrics`, y con eso los paneles de blackbox se
podrían complementar con datos del dominio.

**Alertmanager** para enrutar las alertas a un canal real.

**Retención de logs.** Loki está configurado con 7 días. Para un sistema electoral con
requisitos de auditoría, ese período tendría que alinearse con la normativa aplicable.

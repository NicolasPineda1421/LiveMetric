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
| **node-exporter** | Métricas del host |
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
| node-exporter | — | Métricas del host |
| Blackbox exporter | — | Sondas HTTP |
| Loki | — | Agregación de logs |
| Promtail | — | Recolección de logs |
| Falco | — | Detección en runtime |

Ambos puertos se publican **solo en `127.0.0.1`**, igual que los microservicios: el
monitoreo no debe ser alcanzable desde la red.

## Puesta en marcha

### 1. Contraseña de Grafana

Agreguen al `.env` de la raíz del repositorio:

```bash
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=«una contraseña fuerte»
```

El compose **falla a propósito** si `GRAFANA_ADMIN_PASSWORD` no está definida. Es
preferible a arrancar con la contraseña por defecto de Grafana, que es pública y
conocida — precisamente el tipo de credencial sembrada que ya eliminaron del servicio de
autenticación.

### 2. Levantar

```bash
# Primero la aplicación, que es quien crea la red app-net
docker compose up -d

# Después el monitoreo
docker compose -f monitoring/docker-compose.monitoring.yml up -d
```

El orden importa: el stack de monitoreo se conecta a la red `livemetric_app-net` como red
externa. Si la aplicación no está levantada, esa red no existe y el arranque falla.

### 3. Entrar

- **Grafana:** http://localhost:3010 — el tablero *LiveMetric — Estado del sistema
  electoral* aparece ya cargado en la carpeta LiveMetric.
- **Prometheus:** http://localhost:9090 — pestaña *Status → Targets* para verificar que
  todas las sondas están en verde.

### Detener

```bash
docker compose -f monitoring/docker-compose.monitoring.yml down
```

Con `-v` si además quieren borrar las métricas y logs históricos.

## El tablero

Tres secciones:

**Disponibilidad del servicio.** Cuántos de los cinco endpoints responden, el estado de
cada uno en el tiempo, la latencia por servicio y un indicador dedicado al **worker de
programación**.

Ese último panel merece explicación: el scheduler es el único responsable de abrir,
cerrar y certificar elecciones. Si se detiene, el proceso electoral se congela sin que
nadie lo note — no hay error visible en la interfaz, simplemente las elecciones dejan de
cerrarse. Es el punto único de fallo del sistema, y por eso tiene su propio panel y su
propia alerta.

**Recursos por contenedor.** CPU y memoria de los seis servicios.

**Registros.** Tres paneles de Loki: intentos de autenticación fallidos (un repunte súbito
puede indicar fuerza bruta contra el padrón), errores de aplicación, y actividad del
proceso electoral filtrando scheduler y scrutiny, que permite verificar que la apertura,
el cierre y la certificación ocurren en los tiempos previstos.

## Alertas

Definidas en `prometheus/alerts.yml`, bajo un criterio: alertar solo sobre condiciones que
exigen acción humana. Una alerta que nadie atiende entrena al equipo a ignorar el tablero.

| Alerta | Severidad | Condición |
|---|---|---|
| `ServicioCaido` | crítica | Un `/health` lleva más de 1 minuto sin responder |
| `SchedulerCaido` | crítica | El worker lleva más de 2 minutos inactivo |
| `LatenciaAlta` | advertencia | Más de 2 s de respuesta durante 3 minutos |
| `ContenedorReiniciandose` | advertencia | Reinicio inesperado en los últimos 15 minutos |
| `MemoriaAlta` | advertencia | Más del 90 % del límite durante 5 minutos |

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

Para verlo funcionando — útil para el video:

```bash
docker exec -it livemetric-auth sh
docker logs livemetric-falco | tail -20
```

La shell dispara la alerta de inmediato.

## Privilegios elevados: una advertencia honesta

**cAdvisor y Falco corren en modo privilegiado** y montan rutas del host. Es inherente a
su función: no se puede instrumentar el kernel ni leer las métricas de todos los
contenedores desde un contenedor sin privilegios.

Esto significa que el stack de monitoreo tiene **más privilegios que la aplicación que
vigila**, y debe declararse en lugar de disimularse. En un despliegue real, el monitoreo
correría en un plano separado con su propio control de acceso. Conviene mencionarlo en la
sustentación antes de que lo pregunten: reconocer el trade-off demuestra que se entendió
lo que se desplegó.

Por la misma razón el stack se levanta con un compose **aparte**: el monitoreo no debe
poder tumbar lo que monitorea. Si Grafana consume memoria de más o Loki llena el disco, la
votación sigue funcionando.

## Trabajo futuro

**Instrumentar los servicios con `prom-client`.** Es el paso que falta para tener métricas
de negocio en vez de solo métricas de infraestructura: votos por minuto, logins fallidos
por origen, duración de la certificación, tamaño de la cadena de actas. Requiere agregar
la dependencia a cada servicio y exponer `/metrics`, y con eso los paneles de blackbox se
podrían complementar con datos del dominio.

**Alertmanager** para enrutar las alertas a un canal real.

**Retención de logs.** Loki está configurado con 7 días. Para un sistema electoral con
requisitos de auditoría, ese período tendría que alinearse con la normativa aplicable.

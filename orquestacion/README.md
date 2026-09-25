# Orquestación — Docker Swarm

Despliegue de LiveMetric en un entorno de producción simulado, correspondiente a la
**Fase 5** del ciclo DevSecOps.

## Por qué Swarm y no Kubernetes

Swarm resuelve exactamente lo que la fase pide — orquestación real con réplicas,
balanceo, actualizaciones sin interrupción y reinicio automático — sin introducir un
plano de control aparte. Para un sistema de seis servicios sin autoescalado, K3s
añadiría complejidad operativa que el proyecto no necesita y que habría que documentar
y asegurar por separado.

La decisión relevante no es cuál orquestador se usa, sino **qué se despliega**: este
stack no construye nada. Consume las imágenes versionadas que el workflow `release.yml`
publicó en Docker Hub **después** de pasar el escaneo de Trivy. El artefacto desplegado
es el mismo que fue auditado, no una recompilación local que podría diferir.

## Diferencias frente a `docker-compose.yml`

| Aspecto | Compose (desarrollo) | Swarm (producción simulada) |
|---|---|---|
| Origen de las imágenes | `build:` desde el código local | Docker Hub, versión fija |
| Réplicas | 1 por servicio | 2 en los servicios sin estado |
| Actualización | Reinicio completo | Rolling update con rollback automático |
| Red | bridge | overlay **cifrada** entre nodos |
| Límites de recursos | Ninguno | CPU y memoria acotadas por servicio |
| Rotación de logs | Ninguna | 3 archivos de 10 MB por servicio |

## Por qué dos servicios no se replican

`scrutiny-service` y `scheduler-worker` corren con **una sola réplica, a propósito**.

El scheduler ejecuta tareas programadas: dos réplicas con el mismo cron dispararían dos
veces el cierre y la certificación de la misma elección. El scrutiny encadena hashes:
dos instancias certificando en paralelo podrían generar dos eslabones compitiendo por la
misma posición de la cadena.

En ambos casos se sacrifica disponibilidad a cambio de corrección. En un sistema
electoral esa es la decisión correcta, y conviene poder explicarla: es el tipo de
trade-off que distingue una orquestación pensada de una copiada.

## Despliegue

```bash
# 1. Inicializar Swarm (una sola vez por host)
docker swarm init

# 2. Desplegar la versión publicada
cd orquestacion
chmod +x deploy.sh
./deploy.sh v1.0.0
```

El script valida, antes de desplegar, que Swarm esté activo, que el `.env` exista con
todas las variables obligatorias y que las seis imágenes de esa versión estén realmente
publicadas en el registro. Fallar en la validación es mucho más barato que desplegar y
quedarse con réplicas reiniciándose en bucle.

Al terminar, la aplicación queda en `http://localhost:3000`.

## Operación

```bash
docker stack services livemetric          # estado de los servicios
docker stack ps livemetric                # réplicas y en qué nodo corre cada una
docker service logs -f livemetric_auth-service
docker service scale livemetric_voting-service=4   # escalar bajo demanda
docker stack rm livemetric                # retirar el stack
```

### Actualizar a una versión nueva

```bash
./deploy.sh v1.1.0
```

Swarm reemplaza las réplicas de a una, esperando 10 segundos entre cada una y verificando
que la nueva esté sana antes de continuar. Si una réplica falla al arrancar, hace
**rollback automático** a la versión anterior. El servicio no se cae durante la
actualización.

Para verificarlo en vivo durante la sustentación:

```bash
watch -n 1 docker stack services livemetric
```

## Limitaciones conocidas

**Los puertos se publican en todas las interfaces.** El `docker-compose.yml` publica los
microservicios solo en `127.0.0.1`. Swarm no permite restringir el puerto a una interfaz
en modo `ingress`, así que en este stack quedan accesibles desde la red. En un despliegue
real esto se resuelve poniendo los cuatro microservicios detrás de un reverse proxy y
publicando únicamente el 443 — que es además la forma correcta de cerrar la ausencia de
API Gateway documentada en [decisiones y riesgos](../docs/decisiones-y-riesgos.md).

**Los secretos viajan como variables de entorno.** Swarm ofrece `docker secret`, que los
monta como archivos en `/run/secrets/` en lugar de exponerlos en la definición del
servicio. Aprovecharlo requiere un cambio menor en los servicios: leer
`/run/secrets/<nombre>` cuando el archivo exista y caer a la variable de entorno cuando
no. Es el siguiente paso natural de endurecimiento y está pendiente.

**Un solo nodo.** El stack está probado en un Swarm de nodo único. En varios nodos haría
falta añadir restricciones de ubicación (`placement.constraints`) para fijar el scheduler
a un nodo concreto.

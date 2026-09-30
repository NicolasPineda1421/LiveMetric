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
| Red | bridge: `app-net` y `db-net` (interna) | overlay **cifrada** entre nodos: las mismas dos redes |
| Base de datos | Contenedor `postgres`, volumen `db-data` | Igual, con su propio volumen; una réplica fijada al nodo manager y `init.sql` como `config` de Swarm versionada |
| Límites de recursos | Ninguno | CPU y memoria acotadas por servicio |
| Rotación de logs | Ninguna | 3 archivos de 10 MB por servicio |
| Puertos publicados | 3000 (frontend) en la red; 3001 a 3004 solo en `127.0.0.1`, para probar el API | Solo el 3000: el API se alcanza a través de nginx |
| Endurecimiento | Sin root, solo lectura, `no-new-privileges` | Sin root, solo lectura y **sin ninguna capability** (`cap_drop: ALL`), porque Swarm no soporta `no-new-privileges` |

## Por qué dos servicios no se replican

`scrutiny-service` y `scheduler-worker` corren con **una sola réplica, a propósito**.

El scheduler ejecuta tareas programadas: dos réplicas con el mismo cron dispararían dos
veces el cierre y la certificación de la misma elección. El scrutiny encadena hashes:
dos instancias certificando en paralelo podrían generar dos eslabones compitiendo por la
misma posición de la cadena.

En ambos casos se sacrifica disponibilidad a cambio de corrección. En un sistema
electoral esa es la decisión correcta, y conviene poder explicarla: es el tipo de
trade-off que distingue una orquestación pensada de una copiada.

`postgres` tampoco se replica: dos instancias de PostgreSQL no comparten datos por
el solo hecho de montar el mismo volumen (eso exige replicación propia de la base).
Además, un volumen de Docker es local a un nodo, así que la base queda fijada al
nodo manager (`placement.constraints`) para que sus datos no se queden atrás si
Swarm la reprograma.

## Despliegue

```bash
# 1. Inicializar Swarm (una sola vez por host)
docker swarm init
# Si falla con "could not choose an IP address to advertise" (la PC tiene
# varias direcciones, por ejemplo IPv6 en el Wi-Fi), indicar la IP local:
#   docker swarm init --advertise-addr 192.168.x.x

# 2. Desplegar la versión publicada
cd orquestacion
chmod +x deploy.sh
./deploy.sh v1.3.2
```

Desde **v1.3.2**: el frontend de las imágenes anteriores no arranca en este stack. Escribía fuera de `/tmp`, que Swarm no puede preparar en un sistema de archivos de solo lectura, y resolvía los servicios del API una sola vez al arrancar: en el primer despliegue se crea antes que ellos y se caía. Desde esta versión los resuelve en cada petición, así que arranca en cualquier orden y sigue a cada servicio aunque cambie de IP. Las anteriores a v1.3.0, además, no firman las actas (Scrutiny) ni verifican
esa firma (Analytics), así que el indicador de veracidad no puede mostrar ninguna acta
como verificada. Las anteriores a v1.2.0, además, se conectaban a Supabase y no traen lo
que este stack espera de la base local (el cifrado del padrón al arrancar y
`crearAdmin.js --si-no-hay`).

El script valida, antes de desplegar, que Swarm esté activo, que el `.env` exista con
todas las variables obligatorias y que las seis imágenes de esa versión estén realmente
publicadas en el registro. Fallar en la validación es mucho más barato que desplegar y
quedarse con réplicas reiniciándose en bucle.

Usa el mismo `.env` de la raíz del repo que `docker compose`; si todavía no existe, se
genera con `node scripts/lib/generar-env.js`. La base del stack es **otra**, con su
propio volumen (`livemetric_db-data`): empieza vacía aunque ya haya una instalación con
`docker compose` en la misma PC. Por eso, la primera vez hay que crear su primer
administrador (el script lo recuerda al terminar):

```bash
docker exec -it $(docker ps -q -f name=livemetric_auth-service | head -n 1) \
  node src/scripts/crearAdmin.js --si-no-hay
```

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
./deploy.sh v1.4.0     # la versión nueva, una vez publicada por release.yml
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

**Sin HTTPS.** El único puerto publicado es el 3000, en HTTP. En un despliegue real iría
un certificado TLS en nginx (o un balanceador delante) y se publicaría el 443.

**Lo que Swarm no soporta del compose.** `docker stack deploy` ignora dos opciones que en
el compose endurecen los contenedores, y el stack las reemplaza:

- `security_opt` (`no-new-privileges`): en su lugar, los servicios corren sin ninguna
  capability de Linux (`cap_drop: ALL`). Ninguno las necesita: todos corren sin root.
- La clave `tmpfs`: los `tmpfs` van con la sintaxis larga de `volumes`, **sin opciones**.
  `docker stack deploy` descarta el modo y deja el `tmpfs` inaccesible, y Swarm no
  permite elegir su dueño. Por eso nginx escribe todo lo suyo (buffers, pid y
  `config.js`) en `/tmp`, que es de todos (modo 1777).

**Los secretos viajan como variables de entorno.** Swarm ofrece `docker secret`, que los
monta como archivos en `/run/secrets/` en lugar de exponerlos en la definición del
servicio. Aprovecharlo requiere un cambio menor en los servicios: leer
`/run/secrets/<nombre>` cuando el archivo exista y caer a la variable de entorno cuando
no. Es el siguiente paso natural de endurecimiento y está pendiente.

**Un solo nodo.** El stack está probado en un Swarm de nodo único, de punta a punta:
los 7 servicios convergen, el login funciona a través del balanceo entre réplicas, el
padrón queda cifrado y el scheduler certifica y firma las actas, que Escrutinio y
Analytics dan por verificadas. La base ya queda fijada al nodo manager; en varios nodos
habría que hacer lo mismo con el scheduler.

**No convive con `docker compose` en la misma PC.** Los dos usan los mismos nombres de
red (`livemetric_app-net`, `livemetric_db-net`) y el mismo puerto 3000: antes de desplegar
el stack hay que bajar el compose (`docker compose down`), y al revés.

**La base no tiene respaldo automático ni alta disponibilidad.** Si el nodo manager se
pierde, se pierde la base. El respaldo es manual (`pg_dump`, ver
[decisiones y riesgos](../docs/decisiones-y-riesgos.md)); una base replicada queda fuera
del alcance del proyecto.

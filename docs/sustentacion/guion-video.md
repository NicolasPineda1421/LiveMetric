# Guion del video de demostración

El enunciado pide un video de 10 a 15 minutos que muestre el ciclo completo. Este guion dura unos 14 minutos, en ocho bloques. Cada bloque dice qué mostrar en pantalla, qué decir (en viñetas: son ideas, no un texto para leer) y los comandos exactos.

Conviene grabar cada bloque por separado y unirlos después: si algo sale mal, se repite solo ese bloque. Tres momentos tardan en tiempo real y se pueden cortar en la edición: el cierre de la elección (hasta un minuto), la alerta de servicio caído (90 segundos) y el pipeline local (unos 5 minutos).

## Preparación

Antes de grabar:

1. **Instalación de demostración** levantada con `./scripts/start.sh`, con su administrador creado. Sin datos que importen: el bloque 5 altera un acta para siempre.
2. **Monitoreo con Falco:** ya lo levanta `start.sh` en Linux (al final dice "Falco: alertas en el tablero de Grafana"). Con el contenedor global también viene incluido, pero los comandos de los bloques 5 y 7 hay que correrlos adentro, con `./scripts/contenedor.sh shell`: por eso, para grabar, conviene `start.sh`.
3. **Datos de la historia de usuario:** padrón con tres votantes (anotar los PIN, con un vencimiento que llegue al día de la grabación), sus autenticadores ya registrados en un celular, y una plantilla genérica con tres opciones (ver [la historia de usuario](historia-de-usuario.md), "Preparación").
4. **Hook de Gitleaks** instalado: `./scripts/install-hooks.sh`.
5. **Pestañas abiertas en el navegador:**
   - la aplicación como administrador, y una ventana de incógnito para el votante;
   - Grafana (`http://localhost:3010`);
   - el repositorio en GitHub: pestañas **Actions** y **Security**;
   - Docker Hub (`hub.docker.com/u/nicolaspineda1421`);
   - Threat Dragon (`https://www.threatdragon.com`, o la versión de escritorio) con el modelo ya importado.
6. **Terminal** en la raíz del repositorio, con letra grande.

## Bloque 1 — Presentación (0:00 – 1:00)

**Pantalla:** la portada del informe o el README con sus insignias.

- Qué es LiveMetric: elecciones con voto único por identidad y un acta certificada que nadie puede alterar sin que se note.
- Por qué un sistema electoral: la seguridad no es un agregado, es el requisito. Cada control protege algo concreto.
- Qué se va a ver: arquitectura, modelo de amenazas, pipeline, la aplicación funcionando y resistiendo un ataque, publicación, despliegue y monitoreo.
- Integrantes y licencia (MIT).

## Bloque 2 — Arquitectura (1:00 – 2:30)

**Pantalla:** el diagrama de despliegue (Figura 3 del informe) y después la terminal.

```bash
docker compose ps
```

- Seis servicios: frontend, cuatro microservicios Node.js y un worker, más PostgreSQL. Los siete, sanos.
- Un solo puerto abierto a la red, el 3000: nginx reenvía cada ruta del API a su servicio.
- La base está en una red interna, sin salida a Internet, y el frontend no llega a ella.
- Contenedores sin root, de solo lectura y sin poder ganar privilegios.

## Bloque 3 — Modelo de amenazas (2:30 – 4:00)

**Pantalla:** Threat Dragon con el DFD de nivel 1 abierto; clic en el flujo rojo y en el almacén del acta para mostrar sus amenazas.

- STRIDE por elemento: cada proceso, almacén y flujo revisado contra las seis categorías.
- 22 amenazas, cada una anclada a un elemento real del código y con su control.
- El flujo rojo es el repudio del voto: una amenaza **aceptada** a propósito, para preservar el secreto del voto.
- La amenaza 15 (alguien con acceso a la base rehace la cadena de hashes de un acta) es la que se va a atacar en vivo en el bloque 5.

## Bloque 4 — El pipeline (4:00 – 6:30)

**Pantalla:** la terminal, después GitHub.

**1. El primer control, antes del commit.** Un secreto que no llega ni al commit:

```bash
printf 'const JWT_SECRET = "sk_live_%s";\n' "$(openssl rand -hex 12)" > prueba.js
git add prueba.js && git commit -m "prueba"      # Gitleaks lo bloquea
git reset prueba.js && rm prueba.js
```

**2. En GitHub, pestaña Actions:** la última corrida.

- Los 37 jobs y cómo dependen entre sí: Gitleaks primero; si falla, no corre nada más.
- El resumen del **Security Gate**.
- Los artefactos: el reporte de ZAP y la cobertura.

**3. Pestaña Security → Code scanning:** los resultados de Semgrep, ESLint, Trivy y Checkov, en un solo lugar.

**4. Opcional, en la terminal:** `./scripts/pipeline-local.sh`, cortado en la edición para mostrar solo el cuadro final.

- Lo que bloquea: secretos, CVE altas o críticas en dependencias e imágenes, cualquier hallazgo de ESLint y Checkov, y las pruebas.
- Checkov revisa el Terraform con políticas propias: no traía controles para el provider de Docker y el job pasaba sin revisar nada. Lección: un control hay que verlo fallar.

## Bloque 5 — La historia de usuario (6:30 – 10:00)

**Pantalla:** la aplicación, siguiendo los pasos 1 a 6 de [la historia de usuario](historia-de-usuario.md#pasos), en versión corta:

1. **Administrador:** programa la elección. El worker la abre en el siguiente minuto.
2. **Votante:** ingresa con cédula, PIN y el código de su app autenticadora (el segundo factor: con el PIN solo no entra), y vota. Al volver, la papeleta ya no está, y su historial no dice por quién votó.
3. **Administrador:** detiene la elección. Aparece **✓ Acta verificada**; muestra el PDF.
4. **Atacante,** en la terminal:

   ```bash
   docker compose exec -T analytics-service node - <id> < scripts/demo/alterar-acta.js
   ```

   Leer los cinco pasos que imprime. Lo importante: la base rechaza el cambio directo, pero con permisos de dueño de la tabla el atacante apaga el trigger, da vuelta el ganador y **rehace toda la cadena de hashes**.
5. **Administrador:** vuelve a consultar. **✘ Acta alterada**: la firma no corresponde y el reconteo no coincide. En **Escrutinio**, el veredicto es el mismo.

- La cadena de hashes sola no lo habría detectado. La firma, que solo puede producir Scrutiny con su clave privada, sí; y Analytics la verifica por su cuenta, con la pública.

## Bloque 6 — Publicación y despliegue (10:00 – 11:30)

**Pantalla:** GitHub Actions (workflow *Release*), Docker Hub y el repositorio.

- Una versión se publica creando un tag `vX.Y.Z`. Mostrar la corrida de `release.yml` para la v1.3.7: cada imagen se construye, **Trivy la escanea antes de publicarla** y, si pasa, sube con `1.3.7`, `v1.3.7`, `1.3` y `latest`.
- En Docker Hub, las seis imágenes con sus etiquetas.
- Infraestructura como código: el job de Terraform levanta el sistema completo, comprueba que responde y lo destruye en cada corrida. Mostrar `infra/terraform/main.tf`, una de las políticas de `politicas-checkov/` y el paso del *smoke test* en Actions.
- Docker Swarm: `cd orquestacion && ./deploy.sh v1.3.7` despliega las imágenes publicadas, con réplicas y *rolling updates*. Basta con mencionarlo: Swarm y compose no pueden correr a la vez en la misma PC.

## Bloque 7 — Monitoreo y detección en tiempo de ejecución (11:30 – 13:30)

**Pantalla:** Grafana, tablero *LiveMetric — Estado del sistema electoral*, y la terminal al lado.

1. Recorrer el tablero: cuántos de los cinco endpoints de salud responden, el indicador del worker y los ingresos fallidos en tiempo real.
2. Ataques que Falco detecta en segundos:

   ```bash
   docker exec -it livemetric-auth sh        # Shell abierta en contenedor (WARNING); salir con exit
   docker exec livemetric-voting su -c id    # Intento de escalada de privilegios (CRITICAL)
   ```

3. Mostrar las alertas en la sección de Falco del tablero.
4. **Opcional:** `docker stop livemetric-voting`. A los 90 segundos, `ServicioCaido` pasa a *firing* en Prometheus (cortar la espera en la edición). Volver a levantarlo con `docker start livemetric-voting`.

- Falco ve lo que los escaneos estáticos no pueden: lo que pasa dentro de los contenedores después del despliegue.
- Advertencia honesta: cAdvisor y Falco corren con privilegios, porque es inherente a su función.

## Bloque 8 — Cierre (13:30 – 14:30)

**Pantalla:** la tabla de resultados del informe (sección 5.1).

- **Resultados de la última corrida:**
  - 0 secretos;
  - 0 CVE críticas o altas en dependencias e imágenes;
  - ZAP con 0 alertas altas y 0 medias;
  - 401 pruebas, con 80,3 % de cobertura.
- **Limitaciones:** sin HTTPS; ZAP informa pero no bloquea; los servicios comparten usuario de base de datos.
- **Lecciones:**
  - el modelo de amenazas tiene que guiar el código;
  - un control hay que verlo fallar;
  - un riesgo aceptado se declara, no se esconde.

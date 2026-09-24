# Guía de validación funcional

Pruebas manuales para comprobar que cada funcionalidad hace lo que promete, además de la seguridad. Para comprobar que los controles del pipeline bloquean de verdad, ver [pipeline DevSecOps](pipeline-devsecops.md#cómo-comprobar-que-los-controles-bloquean-de-verdad). Los datos de demostración (admin, cédulas, PIN) están en [instalación y despliegue](instalacion-y-despliegue.md#datos-de-demostración).

## Ventana de tiempo y escrutinio

1. **Ventana de tiempo respetada** — Crear una elección con `scheduledStart` en el futuro y votar inmediatamente: debe responder `403` ("aún no abre"). Repetir con `scheduledEnd` ya pasado: debe responder `403` ("ya cerró").
2. **Cierre automático sin intervención manual** — Crear una elección con una ventana de 1–2 minutos y no tocar nada: revisar `docker compose logs -f scheduler-worker` y confirmar que, sin ninguna llamada manual, la elección pasa de `scheduled` → `active` → `closed`, y que `scrutiny-service` recibe la llamada de certificación automáticamente.
3. **Resultado congelado tras el cierre** — Antes del cierre, `GET /api/elections/:id/results` en Analytics debe recalcular en cada llamada (`certified: false`). Después del cierre, debe devolver siempre el mismo `recordHash` sin importar cuántas veces se consulte (`certified: true`).
4. **Detección de manipulación en el libro de actas** — Con acceso directo a PostgreSQL, intentar `UPDATE scrutiny_ledger SET total_votes = 9999 WHERE election_id = 1;`. El trigger `trg_scrutiny_no_update` debe rechazar la operación con una excepción. Si en cambio se simula una alteración fuera de ese camino (por ejemplo, restaurando un backup editado a mano), `GET /verify` en Scrutiny debe reportar `valid: false` y señalar en qué `electionId` se rompió la cadena.
5. **Endpoint interno protegido** — Intentar `POST /internal/certify/1` en Scrutiny sin el header `X-Internal-Token` (o con uno incorrecto): debe responder `401`, incluso desde dentro de la red `app-net`.

## Login dual y auditoría

1. **PIN incorrecto** — Intentar `POST /login/voter` con la `cedula` correcta y un `pin` equivocado: debe responder `401` genérico ("Cédula o PIN incorrectos"), igual que si la cédula no existiera (evita dar pistas a quien intenta adivinar). Un votante sin PIN asignado (`access_code_hash` nulo, p. ej. cargado antes de esta migración) debe fallar igual, nunca aceptar la cédula como contraseña.
2. **Cédula fuera del padrón** — Intentar con una cédula que no exista en `voters`: `401` genérico, y debe quedar un evento `LOGIN_FAILURE_VOTER` en `GET /admin/audit-log` (pestaña "Auditoría" en el frontend), identificado solo por `voter_id_hash`, nunca por la cédula real.
3. **Token de rol equivocado** — Intentar votar (`POST /vote`) usando un JWT de **administrador** en vez de uno de **votante**: debe responder `403` ("Este token no es válido para votar"). Intentar usar un token de **votante** contra una ruta `/admin/*` de Voting o Auth: debe responder `403` también.
4. **Expiración corta del token de votante** — Iniciar sesión como votante, esperar a que pase `VOTER_JWT_EXPIRES_IN` (10 minutos por defecto) y luego intentar votar: debe responder `401` ("expirada, inicia sesión de nuevo").
5. **Append-only del log de auditoría** — Igual que con `scrutiny_ledger`: `UPDATE audit_log SET actor_ref = 'x' WHERE id = 1;` directo en PostgreSQL debe ser rechazado por el trigger `trg_audit_no_update`.
6. **Nada de PII en el log** — Revisar cualquier fila de `audit_log` para eventos de tipo `*_VOTER`: la columna `actor_ref` debe contener siempre un hash SHA-256 (64 caracteres hexadecimales), nunca un número de cédula reconocible.

## Detener una elección, plantilla presidencial, mesas y acta

1. **Detener una elección antes de tiempo** — En "Elecciones", crea una con ventana larga (ej. 1 hora) y pulsa "Detener" mientras está `scheduled` o `active`. Debe quedar `closed` de inmediato, con `stopped_manually: true`. En menos de un minuto (`SCHEDULER_CRON`), `scheduler-worker` la certifica igual que a una cerrada por tiempo — revisa `docker compose logs -f scheduler-worker` para confirmarlo, y luego "Resultados" debe mostrar `certified: true`.
2. **Nadie puede votar después de detenerla** — Justo después de detener una elección que estaba `active`, intenta `POST /vote` contra ella: debe responder `403`, igual que si hubiera cerrado por tiempo.
3. **Plantilla presidencial con candidatos** — En "Plantillas", crea una del tipo "Elección presidencial" con al menos 2 candidatos (número, nombre, logo opcional). Verifica que `GET /admin/templates` devuelva cada opción con `candidateNumber` y `logo` (o `null` si no se cargó foto).
4. **Los candidatos viajan a la elección y a la boleta** — Instancia una elección desde esa plantilla; `GET /elections/active` y `GET /elections/:id/options` deben incluir `candidate_number` y `logo` por cada opción, y la boleta del votante (pestaña "Votante" del frontend) debe mostrar la foto y el número, no solo un texto plano.
5. **Puesto y mesa asociados al votante** — Al cargar el padrón (`/admin/voters/bulk`) sin `pollingPlace` o `votingTable`, debe responder `400`. Con ambos campos presentes, `GET /admin/voters` debe devolverlos, y el login de ese votante (`/login/voter`) debe incluirlos en la respuesta y en el JWT.
6. **El voto queda etiquetado con la mesa real, no con lo que diga el cliente** — Inspecciona la tabla `votes` tras emitir un voto: `polling_place` y `voting_table` deben coincidir con el padrón, nunca con un valor que el navegador pudiera enviar directamente (Voting los toma del JWT verificado, no del body de la petición).
7. **El acta consolida por mesa y determina un ganador** — Con votantes de al menos 2 mesas distintas (el padrón de demostración ya trae "Mesa 1" y "Mesa 2"), vota desde cédulas de ambas mesas en la misma elección presidencial y espera la certificación. `GET /certifications/:electionId` en Scrutiny debe devolver `results.byTable` con una entrada por mesa (y su propio conteo por candidato) y `results.winner` con el candidato de más votos a nivel global.
8. **Empates se reportan, no se ocultan** — Fuerza un empate exacto entre dos candidatos (mismo número de votos) y certifica la elección: `winner.tie` debe ser `true` y `winner.tiedWith` debe listar al otro candidato empatado, en vez de elegir uno arbitrariamente.

## Estadística avanzada de los reportes

En **Reportes**, al agregar un widget, hay cuatro fuentes de datos que responden preguntas concretas (la lógica está en `services/analytics/src/advancedStats.js`, con pruebas en `advancedStats.test.js`):

| Fuente | Qué responde | Cómo lo calcula |
|---|---|---|
| **Proyección de participación** | ¿Con qué participación va a cerrar la jornada? | Con al menos 2 elecciones anteriores comparables: cuánto de sus votos se había emitido a esta misma altura de la ventana (mediana y rango). Sin historial: el ritmo actual, con intervalo de Poisson. No proyecta antes del 10 % de la jornada ni con menos de 10 votos. |
| **Momento de definición** | ¿Cuántas veces cambió el primer lugar y desde cuándo lidera el que va primero? | Resultado acumulado por tramos de tiempo. Cada punto agrupa al menos 5 votos, para que la evolución no permita deducir votos individuales. |
| **Integridad del acta** | ¿El acta certificada sigue intacta y coincide con los votos guardados? | Analytics recalcula por su cuenta toda la cadena de hashes (independiente de Scrutiny) y vuelve a contar los votos contra el acta: detecta también votos agregados o borrados después de certificar, que la cadena sola no ve. |
| **Accesos sospechosos** | ¿Alguien intentó adivinar PINs, cédulas o contraseñas de admin? | Reglas sobre los logins de la auditoría en ventanas de 15 min: 5 PIN incorrectos para una cédula, 5 cédulas inexistentes desde una IP, 8 fallos desde una IP, 3 fallos para un usuario admin, y el caso más serio: varios PIN fallidos seguidos de un ingreso exitoso. |

Para verlas en acción: la integridad de una elección de prueba del escrutinio (`CITEST-SCRUTINY-…`) aparece como **Alterada**, porque esas pruebas borran sus votos después de certificar — el acta dice N votos y en la base quedan 0. Los accesos sospechosos muestran los intentos fallidos que generan las pruebas de login durante la ventana de cada elección.

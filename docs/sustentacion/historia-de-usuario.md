# Historia de usuario para la sustentación

El enunciado pide presentar en la sustentación una historia de usuario completa, distinta de la autenticación. La elegida es la del **acta que no se puede alterar sin que se note**, por cuatro razones:

- **Es el valor central del sistema.** Sin ella, LiveMetric sería un formulario de encuestas.
- **Atraviesa todo.** Participan los seis componentes, los tres actores humanos y el worker, y las dos tablas *append-only*.
- **Responde a las amenazas más graves del modelo**, la 9 y la 15 (manipulación del acta), además de la 6, la 7 y la 8.
- **Se puede atacar en vivo** y ver cómo el sistema lo detecta.

## La historia

> **Como** administrador o auditor de una elección,
> **quiero** que al cerrarse el sistema certifique el resultado en un acta firmada, y que cada vez que la consulte me diga si esa acta sigue siendo la original,
> **para** dar el resultado por oficial con la certeza de que nadie lo alteró, ni siquiera quien tenga acceso a la base de datos.

## Criterios de aceptación

1. **Voto único.** *Dado* un votante que ya votó en una elección, *cuando* intenta votar de nuevo, *entonces* el sistema lo rechaza y su papeleta no vuelve a aparecer.
2. **Solo dentro del horario.** *Dado* una elección que todavía no abrió o que ya cerró, *cuando* alguien intenta votar, *entonces* el voto se rechaza.
3. **Cierre y certificación automáticos.** *Dado* que venció el horario de una elección, o que un administrador la detuvo, *cuando* pasa el siguiente minuto, *entonces* el sistema la cierra y emite su acta. El acta recuenta los votos desde cero, queda encadenada a la anterior por su hash y firmada con Ed25519. Nadie más que el propio sistema puede ordenar la certificación.
4. **Veredicto en cada consulta.** *Dado* un acta intacta, *cuando* se consultan los resultados, *entonces* se muestra **Acta verificada**, con la clave que la firmó.
5. **La alteración se detecta aunque se rehaga la cadena.** *Dado* que alguien con acceso total a la base cambia el acta y recalcula todos los hashes, *cuando* se consulta, *entonces* se muestra **Acta alterada** con los motivos. Pasa en Resultados, en Escrutinio y en el PDF.
6. **El acta oficial es del administrador.** *Dado* un auditor o un votante, *cuando* intentan descargar el acta en PDF o verificar la cadena, *entonces* el sistema lo rechaza. El auditor sí ve el veredicto en Resultados.

## Trazabilidad

| Criterio | Amenaza del modelo | Control | Prueba automática |
|---|---|---|---|
| 1 | 6 (Elevación de privilegios) | `UNIQUE(election_id, voter_id_hash)` en la base; el historial del votante en el frontend | voting: *rechaza el doble voto del mismo votante en la misma elección (409)*; frontend: *en una elección donde ya votó no le vuelve a mostrar la papeleta* |
| 2 | 7 (Manipulación) | Cada voto valida `status = 'active'` y la ventana de tiempo | voting: *rechaza votar en una elección fuera de ventana / no activa todavía (403)* |
| 3 | 8 (Suplantación) | `scheduler-worker` cierra y pide la certificación con el token interno; Scrutiny recuenta, encadena y firma | scheduler: *cierra una elección "active" cuya scheduled_end ya pasó*, *solicita la certificación de una elección "closed" sin acta…*; scrutiny: *rechaza la petición sin el token interno*, *certifica una elección cerrada con votos reales y devuelve el acta (201)* |
| 4 | 9 (Manipulación) | Analytics verifica la firma con la clave pública, el hash, la cadena y el reconteo | analytics: *acta intacta, firmada y con los votos iguales a los certificados → "integra"*; frontend: *un acta verificada se muestra en verde, con la clave que la firmó* |
| 5 | 9 y 15 (Manipulación, Suplantación) | Firma Ed25519: sin la clave privada no se puede rehacer | analytics: *reescribir un acta y rehacer todos los hashes no alcanza: la firma deja de corresponder*; scrutiny: *GET /verify lo detecta por la firma, aunque la cadena de hashes cuadre*, *el PDF del acta alterada se sigue generando (encabezado con la advertencia)*; frontend: *un acta alterada se muestra en rojo…* |
| 6 | 11 (Elevación de privilegios) | Scrutiny acepta solo el rol `admin` (`middleware/auth.js`) | scrutiny: *un auditor o un votante no pueden descargar el acta ni verificar la cadena (403)* |

Todas corren en el job `unit-tests` del pipeline en cada push. Durante la operación, el tablero de Grafana muestra la actividad del proceso electoral (aperturas, cierres y certificaciones) y el estado del worker.

## Demostración en vivo (unos 6 minutos)

### Preparación, antes de la sustentación

1. **Instalación de demostración.** Levantar una instalación nueva con `./scripts/start.sh` (o `scripts\start.bat`) y crear su administrador cuando el script lo pida. El paso 5 cambia el acta de forma **permanente**: no usar una instalación con datos que importen. Para volver a empezar: `./scripts/start.sh borrar` (borra la base; el `.env` queda).
2. **Plantilla.** En **Plantillas**, crear una genérica con tres opciones.
3. **Padrón y autenticadores.**
   - En **Padrón**, agregar tres votantes con el formulario y anotar los PIN que muestra (solo se ven esa vez). Cada PIN vale 24 horas desde que se genera: conviene hacerlo el día de la sustentación (o regenerarlos esa mañana). Si el puesto es nuevo, el formulario pide su ubicación (departamento, municipio, localidad y zona); con "Puesto Central", de la demostración, ya la tiene.
   - Ingresar una vez con cada votante para registrar su autenticador: escanear el QR con Microsoft Authenticator o Google Authenticator en un celular (pueden quedar las tres cuentas en el mismo) y salir. Así, en la demostración, cada ingreso es cédula, PIN y código.
   - **Opcional, voto asistido:** marcar a uno de los tres como **Voto asistido**, crear en **Usuarios** el jurado de su mesa y registrar el autenticador del jurado.
4. **Ventanas abiertas.**
   - El navegador con el administrador.
   - Una ventana de incógnito para el votante.
   - Una terminal en la raíz del repositorio.
   - Opcional: Grafana en `http://localhost:3010`, con el monitoreo levantado (ver `monitoring/README.md`).

### Pasos

| # | Quién | Qué se hace | Qué se ve y qué decir |
|---|---|---|---|
| 1 | Administrador | **Elecciones** → programar "Elección de la sustentación", con apertura en un minuto y cierre en una hora | El worker la abre solo, sin intervención manual, en el siguiente minuto |
| 2 | Votante | Ingresar con cédula, PIN y el código de su app autenticadora; elegir una opción, **Emitir voto** | Sin el código del celular, el PIN solo no alcanza. "Voto registrado". Al volver, la papeleta ya no aparece: *Ya emitiste tu voto en esta elección*. El historial dice que votó, pero no en qué elección ni por quién (criterio 1) |
| 3 | Votante | Repetir con uno o dos votantes más (si se preparó, uno asistido: autoriza el jurado de su mesa con su código) | Hacen falta varios votos para poder dar vuelta el resultado en el paso 5. En el asistido, la auditoría registra qué jurado autorizó |
| 4 | Administrador | **Elecciones** → **Detener** → confirmar | En menos de un minuto el worker pide la certificación a Scrutiny. En **Resultados**: **✓ Acta verificada**, con la clave. **Descargar Acta** (PDF) y **Escrutinio → Verificar actas** (criterios 3 y 4) |
| 5 | Atacante | En la terminal: `docker compose exec -T analytics-service node - <id> < scripts/demo/alterar-acta.js`, donde `<id>` es el número de la elección (columna ID de **Elecciones**) | El script cuenta lo que hace, en cinco pasos. **1.** El `UPDATE` directo lo rechaza la base (*append-only*). **2.** Con permisos de dueño de la tabla, apaga el trigger. **3.** Mueve votos para dar vuelta el ganador. **4.** Recalcula todos los hashes: la cadena vuelve a cuadrar. **5.** Reactiva el trigger. Corre en el contenedor de Analytics a propósito: tiene la base y el código, pero no la clave privada |
| 6 | Administrador | Volver a consultar **Resultados** y **Escrutinio → Verificar actas** | **✘ Acta alterada**: *La firma digital no corresponde al acta* y *N opción(es) no coinciden con el acta* (Figura 1). La cadena de hashes sola no lo habría detectado; la firma y el reconteo sí (criterio 5) |
| 7 | Auditor (opcional) | Ingresar con una cuenta de auditor | Ve el mismo veredicto en **Resultados**, pero no tiene el botón del PDF ni la pestaña **Escrutinio** (criterio 6) |

![Pestaña Resultados con el sello de acta alterada, después del ataque](../img/27-acta-alterada.png)

*Figura 1. El ataque del paso 5, detectado: el acta dice que ganó la Opción B, pero su firma ya no corresponde y el reconteo de los votos guardados no coincide.*

### Preguntas probables

- **¿Por qué no alcanza con la cadena de hashes?** Porque no usa ningún secreto: quien pueda escribir en la base puede recalcularla completa. Es justo lo que hace el paso 5. La firma, en cambio, solo la puede producir quien tiene la clave privada.
- **¿Y si el atacante tiene la clave privada?** Podría firmar un acta falsa. Por eso la clave vive solo en el `.env` de la instalación y en el contenedor de Scrutiny; Analytics, que verifica, solo tiene la pública. Es el riesgo residual de la amenaza 15.
- **¿Por qué se pudo apagar el trigger?** Porque los servicios se conectan a la base como dueños de las tablas. El trigger protege contra errores y contra un acceso limitado, pero no contra el dueño; la garantía de fondo es la firma. Un usuario de base por servicio, sin permiso para cambiar las tablas, está en el trabajo futuro.
- **¿Se puede deshacer la alteración?** No: la tabla es *append-only* y el sistema no corrige actas. La alteración queda visible, que es lo que se busca.
- **¿Por qué no verifica el mismo servicio que firma?** Si lo hiciera, comprometer ese servicio bastaría para firmar y "verificar" a la vez. Analytics recalcula todo por su cuenta, con la clave pública.

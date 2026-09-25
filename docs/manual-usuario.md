# Manual de Usuario — LiveMetric

> Sistema de Elecciones y Escrutinio en Tiempo Real
> Documento correspondiente a la sección 4.2 de la documentación obligatoria del curso.

Este manual está escrito para quien **usa** LiveMetric, no para quien lo instala ni lo
desarrolla. Si necesita levantar el sistema, vea
[Instalación y despliegue](instalacion-y-despliegue.md).

---

## Tabla de contenido

1. [Antes de empezar](#1-antes-de-empezar)
2. [Los tres tipos de usuario](#2-los-tres-tipos-de-usuario)
3. [Ingreso al sistema](#3-ingreso-al-sistema)
4. [Guía del Administrador](#4-guía-del-administrador)
5. [Guía del Votante](#5-guía-del-votante)
6. [Guía del Auditor](#6-guía-del-auditor)
7. [Ciclo completo de una elección](#7-ciclo-completo-de-una-elección)
8. [Preguntas frecuentes](#8-preguntas-frecuentes)

---

## 1. Antes de empezar

LiveMetric se usa desde el navegador. Una vez que el sistema está levantado, se accede en:

```
http://localhost:3000
```

Desde otro equipo de la misma red, se reemplaza `localhost` por la IP del servidor.

No requiere instalar nada en el equipo del usuario. Funciona en Chrome, Firefox y Edge
en sus versiones recientes.

> 📸 **Captura 01 — `01-pantalla-inicio.png`**
> La pantalla de ingreso completa, recién abierta, con las dos pestañas visibles
> (Administrador / Votante) y el logotipo de LiveMetric.

---

## 2. Los tres tipos de usuario

| Rol | Cómo entra | Qué puede hacer |
|---|---|---|
| **Administrador** | usuario + contraseña | Todo: crear plantillas y elecciones, cargar el padrón, generar PINes, crear usuarios, consultar resultados, escrutinio y auditoría |
| **Auditor** | usuario + contraseña | **Solo lectura**: consultar resultados y reportes. No puede modificar nada |
| **Votante** | cédula + PIN de acceso | Ver las elecciones abiertas, emitir su voto y consultar su historial |

El rol de **Auditor** existe para que alguien pueda supervisar el proceso sin tener
capacidad de alterarlo. Es la aplicación del principio de mínimo privilegio: quien
verifica no necesita poder modificar.

---

## 3. Ingreso al sistema

La pantalla de inicio tiene dos pestañas. Elija la que corresponda a su rol.

### 3.1 Administrador o Auditor

1. Pestaña **Administrador**.
2. Escriba su **Usuario** y **Contraseña**.
3. Botón **Ingresar como administrador**.

El sistema lo lleva al panel que corresponde a su rol: los administradores ven nueve
pestañas; los auditores, solo dos.

> 📸 **Captura 02 — `02-login-admin.png`**
> La pestaña de Administrador con los campos Usuario y Contraseña diligenciados
> (con la contraseña oculta por puntos, nunca visible).

### 3.2 Votante

1. Pestaña **Votante**.
2. Escriba su número de **Cédula**.
3. Escriba su **PIN de acceso**, que le entrega el encargado de su puesto de votación.
4. Botón **Ingresar a votar**.

> 📸 **Captura 03 — `03-login-votante.png`**
> La pestaña de Votante con los campos Cédula y PIN, mostrando el texto de ayuda
> *"El PIN te lo entrega el encargado de tu puesto de votación"*.

**Si el ingreso falla**, el sistema siempre responde lo mismo: *"Cédula o PIN
incorrectos"*. No distingue entre una cédula que no existe y un PIN equivocado. Esto es
intencional: evita que alguien pueda averiguar quién está inscrito en el padrón probando
números de cédula.

> 📸 **Captura 04 — `04-login-fallido.png`**
> Un intento fallido mostrando el mensaje genérico de error.

**La sesión del votante dura 10 minutos.** Es tiempo suficiente para votar, y limita el
riesgo si alguien deja la sesión abierta en un equipo compartido. Además, recargar la
página cierra la sesión: en un puesto de votación el equipo pasa de mano en mano, y
dejar la sesión guardada en el navegador sería un riesgo.

---

## 4. Guía del Administrador

El panel de administración tiene nueve pestañas.

> 📸 **Captura 05 — `05-panel-admin.png`**
> El panel completo recién ingresado, con las nueve pestañas visibles y la de
> Resumen activa.

### 4.1 Resumen

Muestra el estado general del sistema: cuántas elecciones hay **Programadas**, **Activas**
y **Cerradas**, más una guía de primeros pasos.

Es la pantalla de control: de un vistazo se sabe si hay una votación en curso.

> 📸 **Captura 06 — `06-resumen.png`**
> La pestaña Resumen con al menos una elección en cada estado, para que se vean
> los tres contadores con datos.

### 4.2 Plantillas

Una **plantilla** es el modelo reutilizable de una votación: define qué se pregunta y
cuáles son las opciones. Se crea una vez y sirve para muchas elecciones.

Para crear una:

1. Pestaña **Plantillas** → **Nueva plantilla**.
2. Escriba el **Nombre** (por ejemplo, *Elección Presidencial 2026*).
3. Opcionalmente, una **Descripción**.
4. En **Candidatos**, agregue cada opción con su **número**, **nombre** y, si desea, un
   **logo o foto**.
5. Use **Quitar** para eliminar una fila que sobre.
6. Guarde la plantilla.

> 📸 **Captura 07 — `07-plantilla-nueva.png`**
> El formulario de nueva plantilla con tres o cuatro candidatos ya cargados,
> mostrando los campos de número, nombre y foto.

> 📸 **Captura 08 — `08-plantillas-lista.png`**
> El listado de plantillas existentes.

### 4.3 Elecciones

Aquí se **instancia** una plantilla: se convierte el modelo en una votación real con
fecha y hora.

1. Pestaña **Elecciones** → **Nueva elección**.
2. Elija la **Plantilla** en el desplegable.
3. Escriba el **Título de la elección**.
4. Defina **Apertura** y **Cierre** (fecha y hora).
5. Botón **Programar elección**.

La elección queda en estado **Programada**. **No hay que abrirla ni cerrarla a mano**: el
sistema la abre sola al llegar la hora de apertura y la cierra sola al vencer la de
cierre. Un componente interno revisa esto de forma continua.

Si necesita terminar una votación antes de tiempo, use **Detener** sobre una elección
activa.

> 📸 **Captura 09 — `09-eleccion-programar.png`**
> El formulario de nueva elección con plantilla seleccionada y las dos fechas.

> 📸 **Captura 10 — `10-elecciones-lista.png`**
> El listado mostrando elecciones en distintos estados (programada, activa, cerrada).

### 4.4 Padrón

El **padrón** es la lista de quiénes tienen derecho a votar. Sin estar en el padrón, una
persona no puede ingresar.

**Cargar votantes:**

1. Pestaña **Padrón**.
2. En **Votantes a cargar**, pegue la lista con los datos de cada persona (cédula,
   nombre, puesto de votación y mesa).
3. Botón **Cargar al padrón**.

**Generar los PINes:**

Cada votante necesita un **PIN de acceso** para poder ingresar. Se generan desde esta
misma pestaña, en la sección **PIN de acceso generados**.

> ⚠️ **Importante:** el PIN se muestra **una sola vez**, en el momento de generarlo.
> Después el sistema solo guarda una versión cifrada que no se puede revertir. Guarde o
> imprima los PINes en ese momento; si se pierde uno, hay que generarlo de nuevo para esa
> persona.

Si un votante pierde su PIN, el administrador se lo regenera desde el listado del padrón.

> 📸 **Captura 11 — `11-padron-carga.png`**
> El formulario de carga con varios votantes listos para cargar.

> 📸 **Captura 12 — `12-padron-pines.png`**
> La pantalla de PINes generados. **Cubra o difumine los PINes reales antes de
> guardar la captura**: no deben quedar credenciales visibles en la documentación del
> proyecto.

> 📸 **Captura 13 — `13-padron-lista.png`**
> El listado del padrón con las columnas Cédula y Nombre.

### 4.5 Usuarios

Para crear otros administradores o auditores.

1. Pestaña **Usuarios**.
2. **Usuario** y **Contraseña** (mínimo 10 caracteres).
3. Elija el rol: **Administrador** o **Auditor (solo lectura)**.
4. Botón **Crear usuario**.

> 📸 **Captura 14 — `14-usuarios.png`**
> El formulario mostrando las dos opciones de rol disponibles.

### 4.6 Resultados

Muestra el conteo de cada elección. Mientras la votación está abierta, los resultados son
**preliminares y en vivo**. Una vez cerrada, se muestran los **certificados**.

> 📸 **Captura 15 — `15-resultados-vivo.png`**
> Resultados de una elección activa, con las gráficas de conteo.

> 📸 **Captura 16 — `16-resultados-certificados.png`**
> Resultados de una elección ya cerrada y certificada.

### 4.7 Reportes

Tableros con estadística avanzada: participación, evolución en el tiempo, proyección de
participación, métricas operativas, de integridad y de accesos sospechosos.

Los tableros se pueden **exportar a PDF**.

> 📸 **Captura 17 — `17-reportes.png`**
> Un tablero de reportes con varias gráficas cargadas.

### 4.8 Escrutinio

Es la pestaña que diferencia a LiveMetric de un sistema de encuestas cualquiera.

Cuando una elección se cierra, el sistema **recuenta los votos desde cero**, de forma
independiente, genera un **acta por mesa de votación** y la sella con una huella digital
(un código llamado *hash*). Cada acta incluye además la huella de la anterior, formando
una **cadena**.

Esto significa que si alguien alterara un acta, su huella cambiaría y **la cadena se
rompería de forma visible**. No hace falta confiar en el sistema: se puede comprobar.

Desde esta pestaña usted puede:

- Ver el acta de cada mesa, con su desglose de votos.
- **Verificar la integridad de la cadena**: el sistema recorre todas las actas y confirma
  que ninguna fue alterada.
- **Descargar el acta en PDF** para archivarla o imprimirla.

> 📸 **Captura 18 — `18-escrutinio-actas.png`**
> El listado de actas por mesa, con sus huellas digitales visibles.

> 📸 **Captura 19 — `19-escrutinio-verificacion.png`**
> El resultado de la verificación de integridad, mostrando la cadena íntegra.

> 📸 **Captura 20 — `20-acta-pdf.png`**
> El acta descargada en PDF, abierta en el visor.

### 4.9 Auditoría

Un registro de todo lo que ocurre en el sistema: ingresos exitosos y fallidos, creación
de elecciones, cargas al padrón, certificaciones. Cada evento muestra **Evento**,
**Actor**, **Referencia** y **Fecha**.

Dos características importantes:

- **Es inmutable.** Ni siquiera un administrador puede borrar o modificar un registro. La
  base de datos lo impide a nivel del motor.
- **No guarda cédulas.** A cada persona se la identifica con un código derivado de su
  documento, no con el documento mismo. Así se puede auditar el comportamiento sin
  exponer los datos personales de nadie.

> 📸 **Captura 21 — `21-auditoria.png`**
> El registro de auditoría con varios eventos de distinto tipo, mostrando que las
> referencias de actor son códigos y no cédulas.

---

## 5. Guía del Votante

La experiencia del votante es deliberadamente simple: tres pasos y termina.

### 5.1 Ver las elecciones abiertas

Al ingresar, aparece **Elecciones abiertas ahora**, junto con su **Puesto** y **Mesa**
asignados.

Si no hay ninguna votación en curso, verá el mensaje *"No hay elecciones activas en este
momento. Vuelve más tarde."*

> 📸 **Captura 22 — `22-votante-elecciones.png`**
> La vista del votante con una elección abierta y sus datos de puesto y mesa visibles.

### 5.2 Emitir el voto

1. Revise las opciones: cada candidato aparece con su número, nombre y foto.
2. Seleccione su opción.
3. Confirme.

> 📸 **Captura 23 — `23-votante-boleta.png`**
> La boleta con los candidatos desplegados.

Al confirmar, aparece la pantalla **Voto registrado**.

> 📸 **Captura 24 — `24-voto-registrado.png`**
> La confirmación de voto registrado.

### 5.3 Historial

Abajo aparece **Historial de tus votos**: en qué elecciones ya participó. No muestra **por
quién** votó — eso el sistema no lo revela a nadie —, solo que el voto fue emitido.

Si intenta votar dos veces en la misma elección, verá *"Ya emitiste tu voto en esta
elección"* y la opción quedará bloqueada. El sistema lo impide por tres vías distintas y
simultáneas, de modo que ni un fallo ni una manipulación pueden burlarlo.

> 📸 **Captura 25 — `25-votante-historial.png`**
> El historial mostrando el aviso *"Ya emitiste tu voto en esta elección"*.

### 5.4 Salir

Botón **Salir**, arriba a la derecha. En un puesto de votación compartido, es importante
hacerlo siempre antes de ceder el equipo al siguiente votante.

---

## 6. Guía del Auditor

El auditor entra por la misma pestaña que el administrador, pero su panel tiene solo dos
secciones: **Resultados** y **Reportes**.

No puede crear elecciones, ni cargar el padrón, ni crear usuarios. Esas opciones
sencillamente no aparecen: la restricción no es que los botones estén ocultos, es que el
servidor rechaza cualquier intento de usar esas funciones con una sesión de auditor.

> 📸 **Captura 26 — `26-panel-auditor.png`**
> El panel del auditor, donde se aprecia que solo hay dos pestañas frente a las
> nueve del administrador. Esta captura es valiosa puesta al lado de la Captura 05.

---

## 7. Ciclo completo de una elección

Resumen del recorrido de punta a punta:

| # | Paso | Quién | Dónde |
|---|---|---|---|
| 1 | Crear la plantilla con los candidatos | Administrador | Plantillas |
| 2 | Cargar el padrón de votantes | Administrador | Padrón |
| 3 | Generar y entregar los PINes | Administrador | Padrón |
| 4 | Programar la elección con su ventana horaria | Administrador | Elecciones |
| 5 | **Apertura automática** al llegar la hora | Sistema | — |
| 6 | Ingresar y votar | Votantes | Vista de votante |
| 7 | Seguir los resultados preliminares | Administrador / Auditor | Resultados |
| 8 | **Cierre automático** al vencer la hora | Sistema | — |
| 9 | **Recuento y certificación automáticos** | Sistema | — |
| 10 | Consultar actas y verificar la cadena | Administrador / Auditor | Escrutinio |
| 11 | Descargar el acta en PDF | Administrador / Auditor | Escrutinio |

Los pasos 5, 8 y 9 no requieren intervención humana. Que la certificación ocurra sola, y
que ningún usuario pueda dispararla, es parte del diseño: el resultado no depende de que
alguien decida cuándo generarlo.

---

## 8. Preguntas frecuentes

**¿Puedo cambiar mi voto después de emitirlo?**
No. Una vez confirmado, el voto es definitivo.

**Perdí mi PIN, ¿qué hago?**
Pídale al administrador que le genere uno nuevo desde la pestaña Padrón.

**¿El sistema sabe por quién voté?**
El voto queda asociado a su mesa de votación, no a usted. El sistema registra que usted
votó — para impedir que vote dos veces — pero no vincula su identidad con la opción
elegida.

**Me salió "Cédula o PIN incorrectos" y estoy seguro de que están bien.**
Puede haber tres causas: la cédula no está en el padrón, el PIN es incorrecto, o su
registro todavía no tiene PIN asignado. El mensaje es el mismo en los tres casos por
seguridad. Consulte con el encargado del puesto.

**Se me cerró la sesión mientras votaba.**
La sesión del votante dura 10 minutos y se cierra al recargar la página. Vuelva a
ingresar con su cédula y PIN; si no alcanzó a confirmar, su voto no quedó registrado y
puede emitirlo de nuevo.

**¿Cómo sé que los resultados no fueron alterados?**
En la pestaña Escrutinio, use **Verificar integridad**. El sistema recorre toda la cadena
de actas y confirma que ninguna fue modificada. Si algo hubiera cambiado, la verificación
fallaría señalando el punto exacto.

---

## Anexo — Lista de capturas

Guárdelas en `docs/img/` con estos nombres exactos y reemplace cada marcador 📸 de este
documento por la imagen, con la sintaxis `![descripción](img/nombre.png)`.

| # | Archivo | Contenido |
|---|---|---|
| 01 | `01-pantalla-inicio.png` | Pantalla de ingreso |
| 02 | `02-login-admin.png` | Ingreso de administrador |
| 03 | `03-login-votante.png` | Ingreso de votante |
| 04 | `04-login-fallido.png` | Error genérico de credenciales |
| 05 | `05-panel-admin.png` | Panel de administrador (9 pestañas) |
| 06 | `06-resumen.png` | Pestaña Resumen |
| 07 | `07-plantilla-nueva.png` | Formulario de plantilla |
| 08 | `08-plantillas-lista.png` | Listado de plantillas |
| 09 | `09-eleccion-programar.png` | Programar elección |
| 10 | `10-elecciones-lista.png` | Listado de elecciones |
| 11 | `11-padron-carga.png` | Carga del padrón |
| 12 | `12-padron-pines.png` | PINes generados (**difuminar**) |
| 13 | `13-padron-lista.png` | Listado del padrón |
| 14 | `14-usuarios.png` | Creación de usuarios y roles |
| 15 | `15-resultados-vivo.png` | Resultados preliminares |
| 16 | `16-resultados-certificados.png` | Resultados certificados |
| 17 | `17-reportes.png` | Tablero de reportes |
| 18 | `18-escrutinio-actas.png` | Actas por mesa |
| 19 | `19-escrutinio-verificacion.png` | Verificación de la cadena |
| 20 | `20-acta-pdf.png` | Acta en PDF |
| 21 | `21-auditoria.png` | Registro de auditoría |
| 22 | `22-votante-elecciones.png` | Elecciones abiertas |
| 23 | `23-votante-boleta.png` | Boleta de votación |
| 24 | `24-voto-registrado.png` | Confirmación de voto |
| 25 | `25-votante-historial.png` | Historial y bloqueo de doble voto |
| 26 | `26-panel-auditor.png` | Panel de auditor (2 pestañas) |

**Recomendaciones para las capturas:**

- Ventana del navegador en 1280 px de ancho: se ve completo y pesa poco.
- Use los datos de demostración, nunca datos reales de personas.
- **Difumine los PINes** de la captura 12 y cualquier contraseña visible.
- Formato PNG.
- Las capturas 05 y 26 juntas demuestran visualmente el control de acceso por rol:
  vale la pena usarlas también en el informe y en el video.

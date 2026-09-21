-- Migración 003: reemplaza "cédula como contraseña" por un PIN de acceso
-- real, asignado por el administrador al cargar el padrón (no hay registro
-- de cuentas self-service). Aditiva y segura de re-ejecutar.

ALTER TABLE voters ADD COLUMN IF NOT EXISTS access_code_hash TEXT;

-- Los votantes cargados ANTES de esta migración quedan con
-- access_code_hash NULL: no podrán iniciar sesión hasta que un admin les
-- genere un PIN (botón "Regenerar PIN" en la pestaña Padrón, o
-- POST /admin/voters/:id/reset-pin). Es intencional: fallar cerrado en vez
-- de dejarlos entrar con la cédula como antes.

-- Excepción SOLO para los 5 votantes de demostración sembrados por
-- db/init.sql (mismo criterio de riesgo aceptado y documentado que el admin
-- de demostración: entorno local de evaluación, nunca producción real):
-- se les asigna el PIN fijo "123456" para que la demo siga siendo usable
-- sin tener que regenerar PINes a mano. El WHERE evita pisar un PIN real
-- si alguno ya fue asignado.
UPDATE voters
   SET access_code_hash = '$2a$12$Ggbitu7PTzh/kWQEfrN77O6Dpx.3ZaXnIJen37XVNuLYOTSQU0Yru' -- bcrypt('123456')
 WHERE cedula IN ('1000000001','1000000002','1000000003','1000000004','1000000005')
   AND access_code_hash IS NULL;

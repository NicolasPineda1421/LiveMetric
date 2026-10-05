-- Migración 008: ningún PIN sin fecha de vencimiento.
--
-- El PIN del votante sirve hasta su vencimiento, haya o no una votación
-- abierta (antes, además, solo servía durante la votación). Los PIN
-- generados antes de la migración 007 no tienen fecha (NULL): sin la regla
-- de la votación, valdrían para siempre. Reciben la misma fecha que el panel
-- propone al generar uno: el cierre de la última elección programada o
-- abierta, o, si no hay ninguna, 24 horas desde que corre esta migración;
-- nunca más de 90 días. (Hoy el panel ya no propone una fecha: cada PIN
-- vence PIN_VIGENCIA_HORAS después de generarlo.)
--
-- Es seguro re-ejecutarlo: los PIN nuevos siempre tienen fecha, así que
-- después de la primera vez no queda ninguno que cambiar.

UPDATE voters
   SET access_code_expires_at = LEAST(
         COALESCE(
           (SELECT max(scheduled_end) FROM elections
             WHERE status IN ('scheduled', 'active') AND scheduled_end > now()),
           now() + interval '24 hours'
         ),
         now() + interval '90 days'
       )
 WHERE access_code_hash IS NOT NULL
   AND access_code_expires_at IS NULL;

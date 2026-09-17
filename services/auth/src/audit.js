const pool = require('./db');

// Inserta un evento en el log de auditoría (append-only, ver init.sql).
// "actorRef" NUNCA debe contener una cédula ni una contraseña en texto
// plano: para votantes se espera el voter_id_hash, no el valor crudo.
// Un fallo al auditar NUNCA debe tumbar la petición del usuario (por eso
// se atrapa el error aquí mismo y solo se loguea a consola), pero sí queda
// visible en los logs del contenedor para que un operador lo note.
async function recordAuditEvent({ eventType, actorType, actorRef = null, req, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (event_type, actor_type, actor_ref, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        eventType,
        actorType,
        actorRef,
        req?.ip || null,
        req?.headers?.['user-agent'] || null,
        JSON.stringify(metadata),
      ]
    );
  } catch (err) {
    console.error('[audit] No se pudo registrar el evento de auditoría:', err.message);
  }
}

module.exports = { recordAuditEvent };

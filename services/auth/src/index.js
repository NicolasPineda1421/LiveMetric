require('dotenv').config();
const app = require('./app');
const pool = require('./db');
const { encryptPlaintextVoters } = require('./voterBackfill');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[auth-service] escuchando en puerto ${PORT}`));

// Una base recién creada trae el padrón de demostración de db/init.sql sin
// cifrar: se cifra al arrancar (idempotente, ver voterBackfill.js). Con
// reintentos, porque en Swarm la base puede no estar lista todavía; si no
// se logra, el servicio sigue funcionando y se reintenta en el próximo
// arranque.
(async function encryptPendingVoters(attempt = 1) {
  try {
    const changed = await encryptPlaintextVoters(pool);
    if (changed) console.log(`[auth-service] padrón: ${changed} votante(s) cifrados al arrancar`);
  } catch (err) {
    if (attempt >= 10) {
      console.error(`[auth-service] no se pudo revisar el cifrado del padrón: ${err.message}`);
      return;
    }
    setTimeout(() => encryptPendingVoters(attempt + 1), 3000);
  }
})();

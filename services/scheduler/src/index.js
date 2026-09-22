require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { runSchedulerTick } = require('./schedulerTick');

const PORT = process.env.PORT || 3005;
const SCRUTINY_URL = process.env.SCRUTINY_INTERNAL_URL; // ej. http://scrutiny-service:3004
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const CRON_EXPRESSION = process.env.SCHEDULER_CRON || '* * * * *'; // cada minuto por defecto

if (!SCRUTINY_URL || !INTERNAL_SERVICE_TOKEN) {
  console.error('FATAL: SCRUTINY_INTERNAL_URL y INTERNAL_SERVICE_TOKEN son obligatorios.');
  process.exit(1);
}

// -----------------------------------------------------------------------
// Este proceso NO expone lógica de negocio por HTTP hacia el público; el
// pequeño servidor Express de abajo solo sirve para exponer /health, algo
// que Docker y Kubernetes necesitan para verificar que el worker sigue vivo.
// -----------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
let lastRunAt = null;
let lastRunSummary = null;

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'scheduler', lastRunAt, lastRunSummary })
);

app.listen(PORT, () => console.log(`[scheduler-worker] healthcheck escuchando en puerto ${PORT}`));

async function tick() {
  const summary = await runSchedulerTick({ scrutinyUrl: SCRUTINY_URL, internalToken: INTERNAL_SERVICE_TOKEN });
  lastRunAt = new Date().toISOString();
  lastRunSummary = summary;
  console.log(`[scheduler-worker] Tick completado:`, summary);
}

cron.schedule(CRON_EXPRESSION, tick);
console.log(`[scheduler-worker] Programado con expresión cron "${CRON_EXPRESSION}"`);

// Ejecuta un primer tick inmediatamente al arrancar, sin esperar al próximo minuto.
tick();

// Configuración por defecto para desarrollo (`npm run dev`). En producción
// dentro de Docker, este archivo se REGENERA por el entrypoint del
// contenedor (ver docker-entrypoint.sh) a partir de variables de entorno,
// para que los puertos sean configurables sin reconstruir la imagen.
window.__LIVEMETRIC_CONFIG__ = {
  AUTH_URL: 'http://localhost:3001',
  VOTING_URL: 'http://localhost:3002',
  ANALYTICS_URL: 'http://localhost:3003',
  SCRUTINY_URL: 'http://localhost:3004',
};

// Solo para correr los tests localmente (fuera de Docker): dentro de
// docker-compose, cada servicio recibe DB_HOST/DB_PORT/DB_USER/DB_PASSWORD
// ya mapeados desde SUPABASE_DB_* (ver docker-compose.yml). Fuera de Docker
// (npm test, o el job "unit-tests" del pipeline) no existe ese mapeo, así
// que se completa aquí — con "||" para nunca pisar un valor que Docker ya
// haya puesto.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

process.env.DB_HOST = process.env.DB_HOST || process.env.SUPABASE_DB_HOST;
process.env.DB_PORT = process.env.DB_PORT || process.env.SUPABASE_DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || process.env.SUPABASE_DB_NAME || 'postgres';
process.env.DB_USER = process.env.DB_USER || process.env.SUPABASE_DB_USER;
process.env.DB_PASSWORD = process.env.DB_PASSWORD || process.env.SUPABASE_DB_PASSWORD;
process.env.DB_SSL = process.env.DB_SSL || 'true';

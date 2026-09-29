// ESLint con reglas de seguridad (SAST de la fase 2 del pipeline, junto a
// Semgrep). Las reglas son comunes a todos los servicios: ver
// scripts/lib/eslint-reglas-seguridad.js. Se corre con "npm run lint".
const security = require('eslint-plugin-security');
const { comunes } = require('../../scripts/lib/eslint-reglas-seguridad');

module.exports = [
  { ignores: ['coverage/'] },
  // Una excepción que ya no hace falta también es un error: no quedan
  // comentarios de "eslint-disable" justificando algo que ya no existe.
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    plugins: { security },
    rules: comunes,
  },
];

// ESLint con reglas de seguridad (SAST de la fase 2 del pipeline, junto a
// Semgrep): las comunes a todos los servicios más las propias del navegador
// (XSS, tabnabbing). Ver scripts/lib/eslint-reglas-seguridad.js. Se corre
// con "npm run lint".
import security from 'eslint-plugin-security';
import reglas from '../../scripts/lib/eslint-reglas-seguridad.js';

export default [
  { ignores: ['dist/'] },
  // Una excepción que ya no hace falta también es un error: no quedan
  // comentarios de "eslint-disable" justificando algo que ya no existe.
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { security },
    rules: { ...reglas.comunes, ...reglas.navegador },
  },
];

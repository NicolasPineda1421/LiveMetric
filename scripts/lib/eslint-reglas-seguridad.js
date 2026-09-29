// LiveMetric - Reglas de seguridad de ESLint, comunes a los 6 servicios: el
// SAST para Node.js de la fase 2 del pipeline, junto a Semgrep. Cada
// servicio tiene su eslint.config.js, que carga eslint-plugin-security de su
// propio node_modules y toma de acá la lista de reglas.
//
// Todas son "error": cualquier hallazgo hace fallar el pipeline. Un falso
// positivo solo pasa con un comentario en esa misma línea que diga por qué
// no es un riesgo, así la excepción queda documentada y justificada junto
// al código, y se ve en cada revisión:
//   // eslint-disable-next-line security/<regla> -- <por qué no es un riesgo>

'use strict';

// Node.js y navegador: los 15 controles de eslint-plugin-security y los
// del núcleo de ESLint que ejecutan texto como código.
const comunes = {
  // Ejecutar texto como código.
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'security/detect-eval-with-expression': 'error',
  // require() de una ruta que no es literal: podría cargar código elegido por otro.
  'security/detect-non-literal-require': 'error',
  // Comandos del sistema operativo (inyección de comandos).
  'security/detect-child-process': 'error',
  // Expresiones regulares con backtracking catastrófico (ReDoS) o armadas con datos.
  'security/detect-unsafe-regex': 'error',
  'security/detect-non-literal-regexp': 'error',
  // obj[clave] con clave variable: prototype pollution.
  'security/detect-object-injection': 'error',
  // Rutas de archivo armadas con datos: path traversal.
  'security/detect-non-literal-fs-filename': 'error',
  // Comparar secretos con === o !== filtra información por el tiempo de respuesta.
  'security/detect-possible-timing-attacks': 'error',
  // Aleatoriedad no criptográfica y APIs de Buffer inseguras u obsoletas.
  'security/detect-pseudoRandomBytes': 'error',
  'security/detect-buffer-noassert': 'error',
  'security/detect-new-buffer': 'error',
  // Middlewares de Express en un orden que anula la protección CSRF.
  'security/detect-no-csrf-before-method-override': 'error',
  // Plantillas que desactivan el escape de HTML.
  'security/detect-disable-mustache-escape': 'error',
  // Caracteres Unicode que esconden o invierten código ("Trojan Source").
  'security/detect-bidi-characters': 'error',
  'security/detect-invisible-characters': 'error',
};

// Solo el frontend (React en el navegador): lo que abre la puerta a XSS o a
// que otra pestaña controle la de LiveMetric. Van como selectores del núcleo
// de ESLint (no-restricted-syntax) porque eslint-plugin-react todavía no
// soporta ESLint 10.
const navegador = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      message: 'dangerouslySetInnerHTML inserta HTML sin escapar (XSS): renderiza el texto con JSX.',
    },
    {
      selector: "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
      message: 'Asignar innerHTML/outerHTML inserta HTML sin escapar (XSS): usa textContent o JSX.',
    },
    {
      selector: "CallExpression[callee.property.name=/^(write|writeln|insertAdjacentHTML)$/]",
      message: 'document.write / insertAdjacentHTML insertan HTML sin escapar (XSS).',
    },
    {
      selector: 'Literal[value=/^\\s*javascript:/i]',
      message: 'Una URL "javascript:" ejecuta código al usarse (XSS).',
    },
    {
      selector:
        "JSXOpeningElement:has(JSXAttribute[name.name='target'][value.value='_blank']):not(:has(JSXAttribute[name.name='rel']))",
      message: 'target="_blank" sin rel="noopener noreferrer" deja que la página abierta controle esta (tabnabbing).',
    },
  ],
};

module.exports = { comunes, navegador };

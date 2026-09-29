// Lee una tabla por clave, pero solo sus propiedades propias: una clave como
// "__proto__" o "constructor" (por ejemplo, la de un tablero guardado que
// alguien editó a mano) no llega a los miembros que el objeto hereda. Es la
// forma de leer obj[clave] cuando la clave no es un literal (regla
// security/detect-object-injection, ver scripts/lib/eslint-reglas-seguridad.js).
export function ownValue(table, key) {
  // eslint-disable-next-line security/detect-object-injection -- la clave se comprobó con Object.hasOwn
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

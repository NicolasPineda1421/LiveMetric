// ownValue: la lectura de obj[clave] que usa el frontend cuando la clave
// viene de afuera (un tablero guardado, la respuesta de un servicio).
import { ownValue } from '../utils/ownValue.js';

describe('ownValue', () => {
  const tabla = { votos: 12, cero: 0 };

  it('devuelve las propiedades propias, incluidas las que valen 0', () => {
    expect(ownValue(tabla, 'votos')).toBe(12);
    expect(ownValue(tabla, 'cero')).toBe(0);
  });

  it('no llega a lo que el objeto hereda de Object.prototype', () => {
    for (const clave of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(ownValue(tabla, clave)).toBeUndefined();
    }
  });

  it('una clave inexistente da undefined, no un error', () => {
    expect(ownValue(tabla, 'no-existe')).toBeUndefined();
    expect(ownValue(Object.create(null), 'votos')).toBeUndefined();
  });
});

// Doble de src/api.js para las pruebas de componentes: cada función del
// cliente real pasa a ser un jest.fn. Si la prueba no dice otra cosa,
// devuelve una promesa que nunca se resuelve: la pantalla se queda
// "cargando" en lugar de fallar con datos que la prueba no preparó.
//
// Uso, en cada archivo de prueba:
//   jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());
//   beforeEach(() => reiniciarApiFalsa(api));
const pendiente = () => new Promise(() => {});

export function crearApiFalsa() {
  const { api } = jest.requireActual('../api.js');
  return { api: Object.fromEntries(Object.keys(api).map((nombre) => [nombre, jest.fn(pendiente)])) };
}

export function reiniciarApiFalsa(api) {
  for (const fn of Object.values(api)) fn.mockReset().mockImplementation(pendiente);
}

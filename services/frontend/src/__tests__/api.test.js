// Cliente HTTP del frontend (src/api.js): a dónde manda cada petición, cuándo
// adjunta el token y cómo convierte los errores en mensajes para la pantalla.
// fetch es un doble: nada sale de la prueba.
let api;

// api.js lee window.__LIVEMETRIC_CONFIG__ (el config.js que genera nginx al
// arrancar) una sola vez, al cargarse: cada caso lo carga de nuevo.
function cargarApi(config) {
  window.__LIVEMETRIC_CONFIG__ = config;
  jest.isolateModules(() => {
    ({ api } = require('../api.js'));
  });
}

function respuesta(status, cuerpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (cuerpo === undefined ? Promise.reject(new SyntaxError('sin cuerpo')) : Promise.resolve(cuerpo)),
    blob: () => Promise.resolve(new Blob(['%PDF-1.7'])),
  };
}

const RELATIVAS = { AUTH_URL: '/auth', VOTING_URL: '/voting', ANALYTICS_URL: '/analytics', SCRUTINY_URL: '/scrutiny' };

beforeEach(() => {
  global.fetch = jest.fn();
  cargarApi(RELATIVAS);
});

afterEach(() => {
  delete window.__LIVEMETRIC_CONFIG__;
  delete global.fetch;
});

describe('a dónde van las peticiones', () => {
  it('usa las rutas relativas del config.js: todo pasa por el nginx del frontend', async () => {
    fetch.mockResolvedValue(respuesta(200, { token: 't', role: 'admin' }));
    await api.loginAdmin('admin', 'clave');
    expect(fetch).toHaveBeenCalledWith('/auth/login/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'clave' }),
    });
  });

  it('sin config.js (npm run dev) apunta a los puertos locales de cada servicio', async () => {
    cargarApi(undefined);
    fetch.mockResolvedValue(respuesta(200, []));
    await api.listActiveElections();
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:3002/elections/active');
  });
});

describe('el token de sesión', () => {
  it('va como "Bearer" cuando hay sesión', async () => {
    fetch.mockResolvedValue(respuesta(200, { votes: [] }));
    await api.listMyVotes('jwt-del-votante');
    const [url, opciones] = fetch.mock.calls[0];
    expect(url).toBe('/voting/my-votes');
    expect(opciones.headers.Authorization).toBe('Bearer jwt-del-votante');
    expect(opciones.body).toBeUndefined();
  });

  it('no se manda en las rutas públicas', async () => {
    fetch.mockResolvedValue(respuesta(200, []));
    await api.listActiveElections();
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });
});

describe('errores', () => {
  it('muestra el mensaje que manda el backend', async () => {
    fetch.mockResolvedValue(respuesta(401, { error: 'Cédula o PIN incorrectos' }));
    await expect(api.loginVoter('1000000001', '000000')).rejects.toThrow('Cédula o PIN incorrectos');
  });

  it('si la respuesta de error no trae cuerpo, dice el código y a qué servicio se llamó', async () => {
    fetch.mockResolvedValue(respuesta(502));
    await expect(api.castVote('t', 1, 2)).rejects.toThrow('Error 502 en voting/vote');
  });

  it('si el servicio no responde, lo explica sin mostrar el error técnico del navegador', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await api.verifyChain('t').catch((e) => e);
    expect(error.message).toMatch(/No se pudo contactar el servicio "scrutiny"/);
    expect(error.message).not.toMatch(/Failed to fetch/);
  });

  it('una respuesta correcta sin cuerpo no rompe el flujo', async () => {
    fetch.mockResolvedValue(respuesta(204));
    await expect(api.deleteDashboard('t', 3)).resolves.toBeNull();
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
  });
});

describe('descarga del acta en PDF', () => {
  let nombreDescargado;

  beforeEach(() => {
    nombreDescargado = null;
    window.URL.createObjectURL = jest.fn(() => 'blob:acta');
    window.URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function registrar() {
      nombreDescargado = this.download;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('baja el PDF con el token y un nombre que dice de qué elección es', async () => {
    fetch.mockResolvedValue(respuesta(200));
    await api.downloadActaPdf('jwt-admin', 7);
    expect(fetch).toHaveBeenCalledWith('/scrutiny/certifications/7/acta.pdf', { headers: { Authorization: 'Bearer jwt-admin' } });
    expect(nombreDescargado).toBe('acta-escrutinio-eleccion-7.pdf');
    // El enlace temporal no queda en la página ni el blob en memoria.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:acta');
  });

  it('si el servicio la rechaza, muestra su motivo', async () => {
    fetch.mockResolvedValue(respuesta(409, { error: 'La elección todavía no está certificada' }));
    await expect(api.downloadActaPdf('t', 7)).rejects.toThrow('La elección todavía no está certificada');
    expect(nombreDescargado).toBeNull();
  });

  it('si el error no es JSON, usa un mensaje genérico', async () => {
    fetch.mockResolvedValue(respuesta(500));
    await expect(api.downloadActaPdf('t', 7)).rejects.toThrow('Error 500 al generar el acta');
  });
});

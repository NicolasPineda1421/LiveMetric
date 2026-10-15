// El .env del compose de Docker Hub (scripts/generarEnv.js) y los secretos
// que genera (secretosInstalacion.js), los mismos que scripts/lib/generar-env.js.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SECRETOS, crearGenerador, publicaDe } = require('../secretosInstalacion');
const { prepararEnv, leerVariables, secretosFaltantes, main } = require('../scripts/generarEnv');

/* eslint-disable security/detect-non-literal-fs-filename -- archivos dentro de la carpeta temporal de cada prueba, y el compose del repo */

let carpeta;
beforeEach(() => {
  carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'generar-env-'));
});
afterEach(() => {
  fs.rmSync(carpeta, { recursive: true, force: true });
});

const leer = (ruta) => leerVariables(fs.readFileSync(ruta, 'utf8'));

describe('secretos de la instalación', () => {
  test('cada uno con su formato, y la pública de las actas en pareja con la privada', () => {
    const generado = crearGenerador();
    expect(Buffer.from(generado('VOTERS_ENCRYPTION_KEY'), 'base64')).toHaveLength(32);
    expect(generado('POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    // Semgrep (node_secret) toma el nombre de la variable por un secreto escrito
    // en el código: el valor es el que genera crearGenerador, al azar.
    // nosemgrep: node_secret
    expect(Buffer.from(generado('JWT_SECRET'), 'base64')).toHaveLength(48);

    const privada = generado('ACTA_SIGNING_KEY');
    const publica = generado('ACTA_PUBLIC_KEY');
    expect(Buffer.from(privada, 'base64')).toHaveLength(32);
    expect(publicaDe(privada)).toBe(publica);
    // Firman y verifican como scrutiny y analytics (32 bytes envueltos en DER).
    const clavePrivada = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(privada, 'base64')]),
      format: 'der',
      type: 'pkcs8',
    });
    const clavePublica = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publica, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const firma = crypto.sign(null, Buffer.from('acta'), clavePrivada);
    expect(crypto.verify(null, Buffer.from('acta'), clavePublica, firma)).toBe(true);
  });

  test('con una privada que ya había, la pública se deriva de ella', () => {
    const privada = crearGenerador()('ACTA_SIGNING_KEY');
    const generado = crearGenerador(privada);
    expect(generado('ACTA_SIGNING_KEY')).toBe(privada);
    expect(generado('ACTA_PUBLIC_KEY')).toBe(publicaDe(privada));
  });
});

describe('generarEnv.js', () => {
  test('sin .env, lo crea con todos los secretos, solo para el dueño', () => {
    const ruta = path.join(carpeta, '.env');
    expect(prepararEnv(ruta)).toMatch(/Se creó el \.env/);
    const variables = leer(ruta);
    expect([...variables.keys()]).toEqual(SECRETOS);
    expect(publicaDe(variables.get('ACTA_SIGNING_KEY'))).toBe(variables.get('ACTA_PUBLIC_KEY'));
    // En Windows no hay permisos de Unix: el mode 0o600 no tiene efecto y Node
    // informa 0o666 para cualquier archivo que se puede escribir.
    if (process.platform !== 'win32') expect(fs.statSync(ruta).mode & 0o777).toBe(0o600);
    // Las opcionales van comentadas: no cambian nada si no se tocan.
    expect(fs.readFileSync(ruta, 'utf8')).toMatch(/^# LIVEMETRIC_VERSION=/m);
  });

  test('si el .env está completo, no lo cambia', () => {
    const ruta = path.join(carpeta, '.env');
    prepararEnv(ruta);
    const antes = fs.readFileSync(ruta, 'utf8');
    expect(prepararEnv(ruta)).toMatch(/ya existe y está completo/);
    expect(fs.readFileSync(ruta, 'utf8')).toBe(antes);
  });

  test('agrega los que faltan sin tocar los que están (también con CRLF y comillas)', () => {
    const ruta = path.join(carpeta, '.env');
    const privada = crearGenerador()('ACTA_SIGNING_KEY');
    fs.writeFileSync(ruta, `# mio\r\nJWT_SECRET="mi-secreto"\r\nACTA_SIGNING_KEY=${privada}\r\nLIVEMETRIC_PUERTO=3900\r\n`);

    expect(prepararEnv(ruta)).toMatch(/faltaban POSTGRES_PASSWORD, VOTER_ID_SALT, VOTERS_ENCRYPTION_KEY, INTERNAL_SERVICE_TOKEN, ACTA_PUBLIC_KEY/);
    const variables = leer(ruta);
    expect(variables.get('JWT_SECRET')).toBe('mi-secreto');
    expect(variables.get('ACTA_SIGNING_KEY')).toBe(privada);
    expect(variables.get('ACTA_PUBLIC_KEY')).toBe(publicaDe(privada));
    expect(variables.get('LIVEMETRIC_PUERTO')).toBe('3900');
    expect(secretosFaltantes(Object.fromEntries(variables))).toEqual([]);
  });

  test('una pública sin su privada no se completa', () => {
    const ruta = path.join(carpeta, '.env');
    fs.writeFileSync(ruta, `ACTA_PUBLIC_KEY=${crearGenerador()('ACTA_PUBLIC_KEY')}\n`);
    expect(() => prepararEnv(ruta)).toThrow(/ACTA_PUBLIC_KEY pero no ACTA_SIGNING_KEY/);
  });

  test('si en su lugar hay una carpeta (como la crea Docker), lo dice', () => {
    const ruta = path.join(carpeta, '.env');
    fs.mkdirSync(ruta);
    expect(() => prepararEnv(ruta)).toThrow(/no es un archivo/);
  });

  test('--revisar falla si falta algún secreto y dice cómo crearlo', () => {
    const errores = jest.spyOn(console, 'error').mockImplementation(() => {});
    const salida = jest.spyOn(console, 'log').mockImplementation(() => {});
    const entorno = process.env;
    try {
      process.env = { ...entorno, ...Object.fromEntries(SECRETOS.map((n) => [n, ''])) };
      expect(main(['--revisar'])).toBe(1);
      expect(errores.mock.calls.flat().join('\n')).toMatch(/No hay \.env[\s\S]*docker compose run --rm configurar/);

      process.env = { ...process.env, ...Object.fromEntries(SECRETOS.map((n) => [n, 'si'])), JWT_SECRET: '' };
      expect(main(['--revisar'])).toBe(1);
      expect(errores.mock.calls.flat().join('\n')).toMatch(/le faltan: JWT_SECRET/);

      process.env = { ...process.env, JWT_SECRET: 'si' };
      expect(main(['--revisar'])).toBe(0);
    } finally {
      process.env = entorno;
      errores.mockRestore();
      salida.mockRestore();
    }
  });
});

describe('docker-hub/docker-compose.yml', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docker-hub', 'docker-compose.yml'), 'utf8');

  test('revisa cada secreto, sin recibir su valor', () => {
    for (const nombre of SECRETOS) {
      expect(compose).toContain(`${nombre}: \${${nombre}:+si}`);
    }
  });

  test('ningún servicio exige un secreto con ":?" (no dejaría correr "configurar" sin .env)', () => {
    expect(compose).not.toMatch(/\$\{[A-Z_]+:\?/);
  });
});

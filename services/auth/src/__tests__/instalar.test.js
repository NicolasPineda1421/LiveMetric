// La imagen de instalación de Docker Hub (docker-hub/instalar.js): deja el
// compose y el .env en la carpeta montada, sin pisar nada ajeno.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SECRETOS } = require('../secretosInstalacion');
const { leerVariables } = require('../scripts/generarEnv');
const { instalar, estaMontada } = require('../../../../docker-hub/instalar');

/* eslint-disable security/detect-non-literal-fs-filename -- archivos dentro de la carpeta temporal de cada prueba */

let carpeta;
let mountinfo;
beforeEach(() => {
  carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'instalar-'));
  // Una tabla de montajes en la que la carpeta de la prueba está montada.
  mountinfo = path.join(carpeta, '..', `${path.basename(carpeta)}.mountinfo`);
  fs.writeFileSync(mountinfo, `1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:1 /home/x ${carpeta} rw - ext4 /dev/sda1 rw\n`);
});
afterEach(() => {
  fs.rmSync(carpeta, { recursive: true, force: true });
  fs.rmSync(mountinfo, { force: true });
});

const compose = () => path.join(carpeta, 'docker-compose.yml');
const env = () => path.join(carpeta, '.env');

test('en una carpeta vacía deja el compose de LiveMetric y el .env con todos los secretos', () => {
  const { estadoCompose, estadoEnv } = instalar(carpeta, { mountinfo });
  expect(estadoCompose).toBe('creado');
  expect(estadoEnv).toMatch(/Se creó el \.env/);
  expect(fs.readFileSync(compose(), 'utf8')).toMatch(/^name: livemetric-dockerhub$/m);
  expect([...leerVariables(fs.readFileSync(env(), 'utf8')).keys()]).toEqual(SECRETOS);
});

test('correrla de nuevo actualiza el compose y no cambia los secretos', () => {
  instalar(carpeta, { mountinfo });
  const secretos = fs.readFileSync(env(), 'utf8');
  fs.writeFileSync(compose(), 'name: livemetric-dockerhub\n# version vieja\n');

  const { estadoCompose, estadoEnv } = instalar(carpeta, { mountinfo });
  expect(estadoCompose).toBe('actualizado');
  expect(estadoEnv).toMatch(/ya existe y está completo/);
  expect(fs.readFileSync(env(), 'utf8')).toBe(secretos);
  expect(instalar(carpeta, { mountinfo }).estadoCompose).toBe('ya estaba al día');
});

test('no pisa un docker-compose.yml ajeno', () => {
  fs.writeFileSync(compose(), 'services:\n  web:\n    image: nginx\n');
  expect(() => instalar(carpeta, { mountinfo })).toThrow(/docker-compose\.yml que no es de LiveMetric/);
  expect(fs.readFileSync(compose(), 'utf8')).toMatch(/nginx/);
  expect(fs.existsSync(env())).toBe(false);
});

test('no mezcla sus secretos con un .env ajeno', () => {
  fs.writeFileSync(env(), 'OTRA_APP_TOKEN=abc\n');
  expect(() => instalar(carpeta, { mountinfo })).toThrow(/\.env que no es de LiveMetric/);
  expect(fs.readFileSync(env(), 'utf8')).toBe('OTRA_APP_TOKEN=abc\n');
});

test('sin la carpeta montada (sin -v), se detiene y dice el comando', () => {
  fs.writeFileSync(mountinfo, '1 0 8:1 / / rw - ext4 /dev/sda1 rw\n');
  expect(() => instalar(carpeta, { mountinfo })).toThrow(/-v "\$\{PWD\}:/);
  expect(fs.readdirSync(carpeta)).toEqual([]);
});

test('fuera de Linux (sin tabla de montajes) no puede saberlo y sigue', () => {
  expect(estaMontada(carpeta, path.join(carpeta, 'no-existe'))).toBe(true);
});

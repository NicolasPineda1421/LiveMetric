// Límite de peticiones detrás del nginx del frontend. En un archivo aparte,
// como voterLoginLimit en auth: el contador del límite vive en la memoria
// de la app, y Jest carga una app nueva por archivo.
//
// Todas las peticiones llegan desde nginx; el cliente real va en
// X-Forwarded-For. Sin "trust proxy", el límite contaba a todos los
// usuarios como uno solo, y uno podía agotar el cupo de todos.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const pool = require('../db');

const token = jwt.sign({ sub: 1, username: 'ci-admin', role: 'admin' }, process.env.JWT_SECRET, {
  algorithm: 'HS256',
  expiresIn: '1h',
});
const consultar = (ip) =>
  request(app).get('/verify').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip);

afterAll(async () => {
  await pool.end();
});

it('cada cliente detrás del proxy tiene su propio cupo: agotar el de uno no bloquea a otro', async () => {
  for (let i = 0; i < 60; i++) {
    expect((await consultar('10.0.0.1')).status).not.toBe(429);
  }
  expect((await consultar('10.0.0.1')).status).toBe(429);
  expect((await consultar('10.0.0.2')).status).not.toBe(429);
});

#!/usr/bin/env node
// LiveMetric - Imprime la IP de esta PC en la red local, para que
// scripts/start.sh y scripts/start.bat muestren la URL con la que otros
// equipos de la misma red llegan al frontend (publicado en 0.0.0.0:3000).
//
// Es la IP de la interfaz por la que sale el trafico hacia afuera, igual que
// "ip route get": listar las interfaces no alcanza, porque tambien estan las
// de Docker (172.17.x.x, etc.), que no sirven desde otra PC. "Conectar" un
// socket UDP no manda ningun paquete: solo le pide al sistema operativo que
// elija la ruta, y con ella la IP de origen. Sin red, no imprime nada.

'use strict';

const dgram = require('dgram');

const socket = dgram.createSocket('udp4');
socket.on('error', () => socket.close());
socket.connect(53, '1.1.1.1', () => {
  const { address } = socket.address();
  if (address && address !== '0.0.0.0') process.stdout.write(`${address}\n`);
  socket.close();
});

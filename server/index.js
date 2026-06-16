const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SPAWN = { x: 480, y: 96 }; // top straight of the speedway oval

app.use(express.static(path.join(__dirname, '..', 'client')));

/** @type {Record<string, {x:number,y:number,dir:string}>} */
const players = {};

io.on('connection', (socket) => {
  players[socket.id] = { x: SPAWN.x, y: SPAWN.y, dir: 'down' };

  socket.emit('init', { id: socket.id, players });
  socket.broadcast.emit('playerJoined', { id: socket.id, state: players[socket.id] });

  socket.on('move', (state) => {
    if (!players[socket.id]) return;
    players[socket.id] = state;
    socket.broadcast.emit('playerMoved', { id: socket.id, state });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Adventure game server listening on http://localhost:${PORT}`);
});

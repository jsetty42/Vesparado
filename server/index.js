const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_NAME_LENGTH = 8;
const MAX_RACERS = 12;
const TOTAL_LAPS = 5;
const COUNTDOWN_MS = 3000;

// Must mirror the track geometry constants in client/game.js.
const FINISH_X = 496;
const FINISH_Y_TOP = 32;
const FINISH_Y_BOTTOM = 224;

const COLORS = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4,
  0x46f0f0, 0xf032e6, 0xbcf60c, 0xfabebe, 0x008080, 0x9a6324,
];

app.use(express.static(path.join(__dirname, '..', 'client')));

/** @type {Map<string, object>} */
const players = new Map();
let phase = 'lobby'; // 'lobby' | 'countdown' | 'racing' | 'results'
let racingOrder = []; // ids of players racing in the current/most recent race

function recalcSlots() {
  const sorted = [...players.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  sorted.forEach((p, i) => {
    if (i < MAX_RACERS) {
      p.slot = 'racer';
      p.color = COLORS[i];
    } else {
      p.slot = 'spectator';
      p.color = null;
    }
  });
}

function publicPlayers() {
  return [...players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    slot: p.slot,
    color: p.color,
    ready: p.ready,
    x: p.x,
    y: p.y,
    rotation: p.rotation,
    laps: p.laps,
    finished: p.finished,
  }));
}

function broadcastLobby() {
  io.emit('lobbyState', { phase, players: publicPlayers() });
}

function gridPosition(index) {
  const col = index % 3;
  const row = Math.floor(index / 3);
  const laneY = FINISH_Y_TOP + ((FINISH_Y_BOTTOM - FINISH_Y_TOP) * (col + 0.5)) / 3;
  // Stay within the flat part of the top straight (~176px behind the line) so all
  // 12 grid slots land on track instead of curving into the corner.
  const spawnX = FINISH_X + 50 + row * 36;
  return { x: spawnX, y: laneY, rotation: -Math.PI / 2 };
}

function maybeStartRace() {
  const racers = [...players.values()].filter((p) => p.slot === 'racer');
  if (racers.length === 0) return;
  if (racers.every((p) => p.ready)) startRace(racers);
}

function startRace(racers) {
  phase = 'countdown';
  racingOrder = racers.map((p) => p.id);
  racers.forEach((p, i) => {
    const pos = gridPosition(i);
    p.x = pos.x;
    p.y = pos.y;
    p.rotation = pos.rotation;
    p.laps = 0;
    p.finished = false;
    p.finishTime = null;
  });

  io.emit('raceStarting', {
    countdownMs: COUNTDOWN_MS,
    grid: racers.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
    })),
  });

  setTimeout(() => {
    if (phase !== 'countdown') return; // race may have been aborted by mass-disconnect
    phase = 'racing';
    io.emit('raceStarted', {});
  }, COUNTDOWN_MS);
}

function checkRaceEnd() {
  if (phase !== 'racing' && phase !== 'countdown') return;
  const racers = racingOrder.map((id) => players.get(id)).filter(Boolean);

  if (racers.length === 0) {
    // Every racer left before finishing (or before the race even started) —
    // there's no one left to race, so don't get stuck outside the lobby.
    racingOrder = [];
    phase = 'lobby';
    recalcSlots();
    broadcastLobby();
    return;
  }

  if (phase === 'racing' && racers.every((p) => p.finished)) endRace(racers);
}

function endRace(racers) {
  phase = 'results';
  const standings = [...racers]
    .sort((a, b) => (a.finishTime || Infinity) - (b.finishTime || Infinity))
    .map((p, i) => ({ rank: i + 1, name: p.name, color: p.color }));
  io.emit('raceResults', { standings });

  players.forEach((p) => {
    p.ready = false;
    p.laps = 0;
    p.finished = false;
    p.finishTime = null;
  });
  racingOrder = [];
  phase = 'lobby';
  recalcSlots();
  broadcastLobby();
}

io.on('connection', (socket) => {
  const rawName = typeof socket.handshake.query.name === 'string' ? socket.handshake.query.name : '';
  const name = rawName.trim().slice(0, MAX_NAME_LENGTH) || 'Player';

  players.set(socket.id, {
    id: socket.id,
    name,
    connectedAt: Date.now(),
    slot: 'spectator',
    color: null,
    ready: false,
    x: FINISH_X,
    y: (FINISH_Y_TOP + FINISH_Y_BOTTOM) / 2,
    rotation: -Math.PI / 2,
    laps: 0,
    finished: false,
    finishTime: null,
  });

  if (phase === 'lobby') recalcSlots();

  const activeRacers =
    phase === 'countdown' || phase === 'racing'
      ? racingOrder
          .map((id) => players.get(id))
          .filter(Boolean)
          .map((p) => ({ id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, rotation: p.rotation, laps: p.laps }))
      : [];

  socket.emit('init', {
    id: socket.id,
    phase,
    totalLaps: TOTAL_LAPS,
    players: publicPlayers(),
    activeRacers,
  });
  broadcastLobby();

  socket.on('ready', () => {
    const p = players.get(socket.id);
    if (!p || p.slot !== 'racer' || phase !== 'lobby') return;
    p.ready = true;
    broadcastLobby();
    maybeStartRace();
  });

  socket.on('move', (state) => {
    const p = players.get(socket.id);
    if (!p || p.slot !== 'racer' || phase !== 'racing' || p.finished) return;
    p.x = state.x;
    p.y = state.y;
    p.rotation = state.rotation;
    p.laps = state.laps;
    if (p.laps >= TOTAL_LAPS) {
      p.finished = true;
      p.finishTime = Date.now();
    }
    socket.broadcast.emit('playerMoved', {
      id: socket.id,
      state: { x: p.x, y: p.y, rotation: p.rotation, laps: p.laps },
    });
    checkRaceEnd();
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    racingOrder = racingOrder.filter((id) => id !== socket.id);
    if (phase === 'lobby') recalcSlots();
    io.emit('playerLeft', { id: socket.id });
    broadcastLobby();
    if (phase === 'racing' || phase === 'countdown') checkRaceEnd();
  });
});

server.listen(PORT, () => {
  console.log(`Vesparado server listening on http://localhost:${PORT}`);
});

const TILE = 32;
const MAP_COLS = 30;
const MAP_ROWS = 20;
const SCOOTER_SIZE = Math.round(TILE * 1.5); // Vespa is 50% bigger than a tile

const FORWARD_SPEED = 160;
const REVERSE_SPEED = 90;
const TURN_STEP_DEG = 30;
const TURN_INTERVAL_MS = 140; // time between discrete 30-degree steering steps
const VEHICLE_SPIN_DURATION_MS = 1500;
const WALL_SPIN_DURATION_MS = 500;
const SPIN_RATE_DEG = 25; // degrees per frame while spinning out
const MAX_NAME_LENGTH = 8;
const COLLISION_RADIUS = SCOOTER_SIZE * 0.18; // much smaller than the full sprite

// Fixed logical viewport the camera renders (independent of the physical screen
// size). Phaser's FIT scale mode then scales this to fit any device/orientation.
const VIEW_W = 480;
const VIEW_H = 320;
const IS_TOUCH_DEVICE = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// Must mirror the COLORS list in server/index.js (same order = same player gets same color).
const COLORS = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4,
  0x46f0f0, 0xf032e6, 0xbcf60c, 0xfabebe, 0x008080, 0x9a6324,
];

let playerName = (window.prompt(`Enter your name (max ${MAX_NAME_LENGTH} characters):`, '') || '')
  .trim()
  .slice(0, MAX_NAME_LENGTH);
if (!playerName) playerName = 'Player';

// Signed-distance test for a rounded rectangle centered at (cx, cy). <= 0 means inside.
function roundedRectDist(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Track tiles: 0 = grass infield, 1 = road, 2 = finish line, 3 = crowd stands (outside the track).
// A 6-tile-wide rounded-rectangle oval (50% wider than the original 4), Indy-speedway style.
const TRACK_WIDTH_TILES = 6;
const CENTER_X = (MAP_COLS * TILE) / 2;
const CENTER_Y = (MAP_ROWS * TILE) / 2;
const OUTER_HALF_W = (MAP_COLS / 2 - 1) * TILE;
const OUTER_HALF_H = (MAP_ROWS / 2 - 1) * TILE;
const OUTER_RADIUS = 8 * TILE;
const THICKNESS = TRACK_WIDTH_TILES * TILE;
const INNER_HALF_W = OUTER_HALF_W - THICKNESS;
const INNER_HALF_H = OUTER_HALF_H - THICKNESS;
const INNER_RADIUS = Math.max(OUTER_RADIUS - THICKNESS, 0);

const FINISH_COL = MAP_COLS / 2;
const FINISH_X = FINISH_COL * TILE + TILE / 2; // must match server's FINISH_X
const FINISH_Y_TOP = CENTER_Y - OUTER_HALF_H; // must match server's FINISH_Y_TOP
const FINISH_Y_BOTTOM = CENTER_Y - INNER_HALF_H; // must match server's FINISH_Y_BOTTOM

const MAP = [];
for (let r = 0; r < MAP_ROWS; r++) {
  const row = [];
  for (let c = 0; c < MAP_COLS; c++) {
    const px = c * TILE + TILE / 2;
    const py = r * TILE + TILE / 2;
    const insideOuter =
      roundedRectDist(px, py, CENTER_X, CENTER_Y, OUTER_HALF_W, OUTER_HALF_H, OUTER_RADIUS) <= 0;
    const insideInner =
      roundedRectDist(px, py, CENTER_X, CENTER_Y, INNER_HALF_W, INNER_HALF_H, INNER_RADIUS) <= 0;
    if (insideOuter && !insideInner) {
      const isFinish = c === FINISH_COL && r < MAP_ROWS / 2;
      row.push(isFinish ? 2 : 1);
    } else if (insideInner) {
      row.push(0);
    } else {
      row.push(3);
    }
  }
  MAP.push(row);
}

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
    this.otherSprites = {};
    this.otherMeta = {};
    this.nameTexts = {};
    this.heading = 0;
    this.spinUntil = 0;
    this.nextTurnAt = 0;
    this.raceStarted = false;
    this.myLaps = 0;
    this.finished = false;
    this.totalLaps = 5;
    this.myId = null;
    this.lastLobbyPlayers = [];
    this.resultsShowing = false;
  }

  preload() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });

    g.fillStyle(0x3a7d44, 1).fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x2f6a37, 1).fillCircle(TILE * 0.25, TILE * 0.3, 2);
    g.fillStyle(0x2f6a37, 1).fillCircle(TILE * 0.7, TILE * 0.65, 2);
    g.generateTexture('grass', TILE, TILE);
    g.clear();

    // Plain bleacher base color; the crowd detail is painted on top as a
    // continuous overlay in create() so it doesn't look like a repeating tile.
    g.fillStyle(0x6b5a44, 1).fillRect(0, 0, TILE, TILE);
    g.generateTexture('stands', TILE, TILE);
    g.clear();

    COLORS.forEach((color, i) => {
      this.drawVespaSilhouette(g, color);
      g.generateTexture(`vespa${i}`, SCOOTER_SIZE, SCOOTER_SIZE);
      g.clear();
    });

    g.destroy();
  }

  // Side-profile Vespa silhouette (like a classic scooter icon), drawn vertically
  // so the "front" still points toward y=0 — keeping it consistent with the
  // existing heading/rotation math even though it reads as a side view.
  drawVespaSilhouette(g, color) {
    const cx = SCOOTER_SIZE / 2;
    const cy = SCOOTER_SIZE / 2;

    g.fillStyle(0x111111, 1).fillCircle(cx, cy - 16, 5); // front wheel
    g.fillStyle(0x111111, 1).fillCircle(cx, cy + 16, 5); // rear wheel
    g.fillStyle(0x333333, 1).fillCircle(cx, cy - 16, 2); // front hub
    g.fillStyle(0x333333, 1).fillCircle(cx, cy + 16, 2); // rear hub

    g.fillStyle(color, 1).fillEllipse(cx, cy, 7, 15); // main body silhouette
    g.fillStyle(color, 1).fillEllipse(cx, cy - 12, 6, 6); // front leg shield
    g.fillStyle(color, 1).fillEllipse(cx, cy + 10, 7, 6); // rear seat hump
    g.fillStyle(color, 1).fillRect(cx - 2, cy - 22, 4, 6); // handlebar stem

    g.fillStyle(0xffffff, 1).fillCircle(cx, cy - 15, 2); // headlight
  }

  textureForColor(color) {
    const idx = COLORS.indexOf(color);
    return `vespa${idx >= 0 ? idx : 0}`;
  }

  setSmallHitbox(sprite) {
    const offset = SCOOTER_SIZE / 2 - COLLISION_RADIUS;
    sprite.body.setCircle(COLLISION_RADIUS, offset, offset);
  }

  setupTouchControls() {
    if (!IS_TOUCH_DEVICE) return;
    document.getElementById('touchControls').style.display = 'block';

    const bind = (id, key) => {
      const el = document.getElementById(id);
      const setDown = (e) => {
        e.preventDefault();
        this.touch[key] = true;
      };
      const setUp = (e) => {
        e.preventDefault();
        this.touch[key] = false;
      };
      el.addEventListener('touchstart', setDown, { passive: false });
      el.addEventListener('touchend', setUp, { passive: false });
      el.addEventListener('touchcancel', setUp, { passive: false });
      el.addEventListener('mousedown', setDown);
      el.addEventListener('mouseup', setUp);
      el.addEventListener('mouseleave', setUp);
    };

    bind('steerLeft', 'left');
    bind('steerRight', 'right');
    bind('throttle', 'up');
    bind('brake', 'down');
  }

  create() {
    // Background tiles: only the off-track cells (grass infield / crowd stands).
    // The track surface itself is drawn separately below as a smooth vector
    // shape so the curves aren't limited to the blocky tile grid.
    this.boundaries = this.physics.add.staticGroup();
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const cell = MAP[r][c];
        const isRoad = cell === 1 || cell === 2;
        if (isRoad) continue;
        const tex = cell === 0 ? 'grass' : 'stands';
        const tile = this.add.image(c * TILE + TILE / 2, r * TILE + TILE / 2, tex);
        this.physics.add.existing(tile, true);
        this.boundaries.add(tile);
      }
    }

    const trackGfx = this.add.graphics();
    trackGfx.fillStyle(0x3d3d3d, 1);
    trackGfx.fillRoundedRect(
      CENTER_X - OUTER_HALF_W,
      CENTER_Y - OUTER_HALF_H,
      OUTER_HALF_W * 2,
      OUTER_HALF_H * 2,
      OUTER_RADIUS
    );
    trackGfx.fillStyle(0x3a7d44, 1);
    trackGfx.fillRoundedRect(
      CENTER_X - INNER_HALF_W,
      CENTER_Y - INNER_HALF_H,
      INNER_HALF_W * 2,
      INNER_HALF_H * 2,
      Math.max(INNER_RADIUS, 0.01)
    );

    // Checkered-flag start/finish line: a true two-axis checkerboard of small squares.
    const finishSquare = 6;
    const finishWidth = TILE;
    const finishHeight = FINISH_Y_BOTTOM - FINISH_Y_TOP;
    const finishCols = Math.round(finishWidth / finishSquare);
    const finishRows = Math.round(finishHeight / finishSquare);
    for (let j = 0; j < finishRows; j++) {
      for (let i = 0; i < finishCols; i++) {
        trackGfx.fillStyle((i + j) % 2 === 0 ? 0x000000 : 0xffffff, 1);
        trackGfx.fillRect(
          FINISH_X - finishWidth / 2 + i * finishSquare,
          FINISH_Y_TOP + j * finishSquare,
          finishSquare,
          finishSquare
        );
      }
    }

    // Crowd in the stands: bench-tier lines plus scattered spectators, painted
    // as one continuous overlay across the whole stands area (not per-tile)
    // so it doesn't read as an obviously repeating texture.
    const standsGfx = this.add.graphics();
    const crowdColors = [0xffcc00, 0xff5555, 0x55aaff, 0xffffff, 0x55cc55, 0xff9933, 0xdd66dd, 0x66ddcc];
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        if (MAP[r][c] !== 3) continue;
        const x0 = c * TILE;
        const y0 = r * TILE;

        standsGfx.lineStyle(1, 0x4a3a28, 0.8);
        for (let line = 1; line < 3; line++) {
          const ly = y0 + (TILE / 3) * line;
          standsGfx.beginPath();
          standsGfx.moveTo(x0, ly);
          standsGfx.lineTo(x0 + TILE, ly);
          standsGfx.strokePath();
        }

        for (let k = 0; k < 7; k++) {
          const px = x0 + 3 + Math.random() * (TILE - 6);
          const py = y0 + 3 + Math.random() * (TILE - 6);
          const radius = 1.1 + Math.random() * 1.4;
          standsGfx.fillStyle(0x222222, 0.55).fillEllipse(px, py + radius * 1.4, radius * 1.8, radius); // shoulders
          standsGfx.fillStyle(crowdColors[Math.floor(Math.random() * crowdColors.length)], 1).fillCircle(
            px,
            py,
            radius
          ); // head
        }
      }
    }

    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D');
    this.touch = { left: false, right: false, up: false, down: false };
    this.setupTouchControls();
    this.otherPlayersGroup = this.physics.add.group();

    this.physics.world.setBounds(0, 0, MAP_COLS * TILE, MAP_ROWS * TILE);

    const zoom = Math.min(this.scale.width / (MAP_COLS * TILE), this.scale.height / (MAP_ROWS * TILE));
    this.cameras.main.setZoom(Math.min(zoom, 1));
    this.cameras.main.centerOn(CENTER_X, CENTER_Y);

    this.statusText = this.add
      .text(this.scale.width / 2, 24, '', {
        fontSize: '32px',
        fontFamily: 'sans-serif',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 5,
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    this.lobbyOverlay = document.getElementById('lobbyOverlay');
    this.lobbyList = document.getElementById('lobbyList');
    this.lobbyStatus = document.getElementById('lobbyStatus');
    this.readyBtn = document.getElementById('readyBtn');
    this.resultsOverlay = document.getElementById('resultsOverlay');
    this.resultsList = document.getElementById('resultsList');
    this.finishBtn = document.getElementById('finishBtn');

    this.readyBtn.addEventListener('click', () => {
      this.socket.emit('ready');
      this.readyBtn.disabled = true;
      this.lobbyStatus.textContent = 'Waiting for other racers...';
    });

    this.finishBtn.addEventListener('click', () => {
      this.resultsShowing = false;
      this.resultsOverlay.style.display = 'none';
      this.renderLobby(this.lastLobbyPlayers);
      this.lobbyOverlay.style.display = 'flex';
    });

    this.socket = io({ query: { name: playerName } });

    this.socket.on('init', ({ id, totalLaps, players }) => {
      this.myId = id;
      this.totalLaps = totalLaps;
      this.lastLobbyPlayers = players;
      this.renderLobby(players);
    });

    this.socket.on('lobbyState', ({ players }) => {
      this.lastLobbyPlayers = players;
      if (!this.resultsShowing) this.renderLobby(players);
    });

    this.socket.on('raceStarting', ({ countdownMs, grid }) => this.beginRace(grid, countdownMs));

    this.socket.on('raceStarted', () => {
      this.raceStarted = true;
    });

    this.socket.on('playerMoved', ({ id, state }) => {
      const sprite = this.otherSprites[id];
      if (sprite) {
        sprite.setPosition(state.x, state.y);
        if (typeof state.rotation === 'number') sprite.rotation = state.rotation;
      }
      const label = this.nameTexts[id];
      if (label) label.setPosition(state.x, state.y - SCOOTER_SIZE / 2 - 4);
      if (this.otherMeta[id] && typeof state.laps === 'number') {
        this.otherMeta[id].laps = state.laps;
        this.updateOtherLabel(id);
      }
    });

    this.socket.on('playerLeft', ({ id }) => {
      const sprite = this.otherSprites[id];
      if (sprite) {
        sprite.destroy();
        delete this.otherSprites[id];
      }
      const label = this.nameTexts[id];
      if (label) {
        label.destroy();
        delete this.nameTexts[id];
      }
      delete this.otherMeta[id];
    });

    this.socket.on('raceResults', ({ standings }) => {
      this.resultsShowing = true;
      this.renderResults(standings);
      this.lobbyOverlay.style.display = 'none';
      this.resultsOverlay.style.display = 'flex';
    });

    this.lastSent = { x: 0, y: 0, rotation: 0, laps: 0 };
  }

  renderLobby(playersList) {
    this.lobbyList.innerHTML = '';
    let me = null;
    playersList.forEach((p) => {
      if (p.id === this.myId) me = p;
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = p.color != null ? `#${p.color.toString(16).padStart(6, '0')}` : '#666';
      const label = document.createElement('span');
      label.textContent = p.name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = p.slot === 'spectator' ? 'Spectating' : p.ready ? 'Ready' : 'Not Ready';
      li.append(swatch, label, tag);
      this.lobbyList.appendChild(li);
    });

    if (me && me.slot === 'racer') {
      this.readyBtn.style.display = 'inline-block';
      this.readyBtn.disabled = me.ready;
      this.lobbyStatus.textContent = me.ready ? 'Waiting for other racers...' : '';
    } else {
      this.readyBtn.style.display = 'none';
      this.lobbyStatus.textContent = "You're spectating — the first 12 players race.";
    }
  }

  renderResults(standings) {
    this.resultsList.innerHTML = '';
    standings.forEach((s) => {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = s.color != null ? `#${s.color.toString(16).padStart(6, '0')}` : '#666';
      const label = document.createElement('span');
      label.textContent = `${s.rank}. ${s.name}`;
      li.append(swatch, label);
      this.resultsList.appendChild(li);
    });
  }

  beginRace(grid, countdownMs) {
    // Clear sprites/labels from any previous race.
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    if (this.myNameText) {
      this.myNameText.destroy();
      this.myNameText = null;
    }
    Object.values(this.nameTexts).forEach((t) => t.destroy());
    this.otherPlayersGroup.clear(true, true); // also destroys the contained sprites
    this.otherSprites = {};
    this.otherMeta = {};
    this.nameTexts = {};

    this.heading = 0;
    this.spinUntil = 0;
    this.nextTurnAt = 0;
    this.raceStarted = false;
    this.myLaps = 0;
    this.finished = false;

    let isRacing = false;

    grid.forEach((entry) => {
      const texture = this.textureForColor(entry.color);
      if (entry.id === this.myId) {
        isRacing = true;
        this.heading = entry.rotation;
        this.prevX = entry.x;
        this.player = this.physics.add
          .image(entry.x, entry.y, texture)
          .setCollideWorldBounds(true);
        this.player.rotation = entry.rotation;
        this.setSmallHitbox(this.player);
        this.physics.add.collider(this.player, this.boundaries, (player, wallTile) =>
          this.triggerSpin(WALL_SPIN_DURATION_MS, wallTile.x, wallTile.y, TILE * 0.75)
        );
        this.physics.add.overlap(this.player, this.otherPlayersGroup, (player, other) =>
          this.triggerSpin(VEHICLE_SPIN_DURATION_MS, other.x, other.y, TILE * 1.25)
        );
        this.cameras.main.setZoom(1);
        this.cameras.main.startFollow(this.player, true);
        this.myNameText = this.addNameLabel(entry.x, entry.y);
        this.updateMyLabel();
      } else {
        const sprite = this.physics.add.image(entry.x, entry.y, texture);
        sprite.body.setAllowGravity(false);
        sprite.body.moves = false;
        sprite.rotation = entry.rotation;
        this.setSmallHitbox(sprite);
        this.otherSprites[entry.id] = sprite;
        this.otherPlayersGroup.add(sprite);
        this.otherMeta[entry.id] = { name: entry.name, laps: 0 };
        this.nameTexts[entry.id] = this.addNameLabel(entry.x, entry.y);
        this.updateOtherLabel(entry.id);
      }
    });

    if (!isRacing) {
      // Spectating this race: keep the wide fitted camera view.
      const zoom = Math.min(this.scale.width / (MAP_COLS * TILE), this.scale.height / (MAP_ROWS * TILE));
      this.cameras.main.setZoom(Math.min(zoom, 1));
      this.cameras.main.centerOn(CENTER_X, CENTER_Y);
    }

    this.lobbyOverlay.style.display = 'none';
    this.resultsOverlay.style.display = 'none';

    let count = Math.round(countdownMs / 1000);
    this.statusText.setText(String(count));
    const tick = () => {
      count--;
      if (count > 0) {
        this.statusText.setText(String(count));
        this.time.delayedCall(1000, tick);
      } else {
        this.statusText.setText('GO!');
        this.time.delayedCall(800, () => this.statusText.setText(''));
      }
    };
    this.time.delayedCall(1000, tick);
  }

  addNameLabel(x, y) {
    return this.add
      .text(x, y - SCOOTER_SIZE / 2 - 4, '', {
        fontSize: '12px',
        fontFamily: 'sans-serif',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
  }

  updateMyLabel() {
    if (this.myNameText) this.myNameText.setText(`${playerName} ${this.myLaps}/${this.totalLaps}`);
  }

  updateOtherLabel(id) {
    const label = this.nameTexts[id];
    const meta = this.otherMeta[id];
    if (label && meta) label.setText(`${meta.name} ${meta.laps}/${this.totalLaps}`);
  }

  triggerSpin(durationMs, awayFromX, awayFromY, pushDist) {
    const now = this.time.now;
    if (now < this.spinUntil) return;
    this.spinUntil = now + durationMs;

    const dx = this.player.x - awayFromX;
    const dy = this.player.y - awayFromY;
    const dist = Math.max(Math.hypot(dx, dy), 0.01);
    const newX = this.player.x + (dx / dist) * pushDist;
    const newY = this.player.y + (dy / dist) * pushDist;
    this.player.body.reset(newX, newY);
  }

  checkLapCrossing(prevX, currX, currY) {
    if (this.myLaps >= this.totalLaps) return;
    const inBand = currY >= FINISH_Y_TOP && currY <= FINISH_Y_BOTTOM;
    if (!inBand) return;

    if (prevX > FINISH_X && currX <= FINISH_X) {
      this.myLaps++;
      this.updateMyLabel();
      if (this.myLaps >= this.totalLaps) {
        this.finished = true;
        this.statusText.setText('FINISHED!');
        this.time.delayedCall(3000, () => this.statusText.setText(''));
      }
    }
  }

  update(time) {
    if (!this.player) return;

    const spinning = time < this.spinUntil;

    if (!this.raceStarted || this.finished) {
      this.player.body.setVelocity(0, 0);
    } else if (spinning) {
      this.heading += Phaser.Math.DegToRad(SPIN_RATE_DEG);
      this.player.rotation = this.heading;
      this.player.body.setVelocity(0, 0);
    } else {
      const left = this.cursors.left.isDown || this.wasd.A.isDown || this.touch.left;
      const right = this.cursors.right.isDown || this.wasd.D.isDown || this.touch.right;
      const up = this.cursors.up.isDown || this.wasd.W.isDown || this.touch.up;
      const down = this.cursors.down.isDown || this.wasd.S.isDown || this.touch.down;

      if ((left || right) && time >= this.nextTurnAt) {
        this.heading += Phaser.Math.DegToRad(TURN_STEP_DEG) * (right ? 1 : -1);
        this.nextTurnAt = time + TURN_INTERVAL_MS;
      }

      const speed = up ? FORWARD_SPEED : down ? -REVERSE_SPEED : 0;
      this.player.rotation = this.heading;
      this.player.body.setVelocity(Math.sin(this.heading) * speed, -Math.cos(this.heading) * speed);
    }

    const { x, y, rotation } = this.player;

    if (this.raceStarted && !this.finished) {
      this.checkLapCrossing(this.prevX, x, y);
    }
    this.prevX = x;

    if (this.myNameText) this.myNameText.setPosition(x, y - SCOOTER_SIZE / 2 - 4);

    if (
      Math.abs(x - this.lastSent.x) > 1 ||
      Math.abs(y - this.lastSent.y) > 1 ||
      rotation !== this.lastSent.rotation ||
      this.myLaps !== this.lastSent.laps
    ) {
      this.lastSent = { x, y, rotation, laps: this.myLaps };
      this.socket.emit('move', { x, y, rotation, laps: this.myLaps });
    }
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: VIEW_W,
    height: VIEW_H,
  },
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: MainScene,
});

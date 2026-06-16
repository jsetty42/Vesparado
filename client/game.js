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
const TOTAL_LAPS = 5;

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

// Track tiles: 0 = grass infield, 1 = road, 2 = crowd stands (outside the track).
// A 4-tile-wide rounded-rectangle oval, Indy-speedway style, with double-radius corners.
const TRACK_WIDTH_TILES = 4;
const CENTER_X = (MAP_COLS * TILE) / 2;
const CENTER_Y = (MAP_ROWS * TILE) / 2;
const OUTER_HALF_W = (MAP_COLS / 2 - 1) * TILE;
const OUTER_HALF_H = (MAP_ROWS / 2 - 1) * TILE;
const OUTER_RADIUS = 8 * TILE; // doubled corner radius
const THICKNESS = TRACK_WIDTH_TILES * TILE;
const INNER_HALF_W = OUTER_HALF_W - THICKNESS;
const INNER_HALF_H = OUTER_HALF_H - THICKNESS;
const INNER_RADIUS = Math.max(OUTER_RADIUS - THICKNESS, 0);

const FINISH_COL = MAP_COLS / 2;
const FINISH_X = FINISH_COL * TILE + TILE / 2;
const FINISH_Y_TOP = CENTER_Y - OUTER_HALF_H;
const FINISH_Y_BOTTOM = CENTER_Y - INNER_HALF_H;

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
      row.push(isFinish ? 2 : 1); // 1 = road, 2 = finish line
    } else if (insideInner) {
      row.push(0); // infield grass
    } else {
      row.push(3); // crowd stands
    }
  }
  MAP.push(row);
}

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
    this.otherSprites = {};
    this.otherMeta = {};
    this.heading = 0; // radians; 0 = facing up, increases clockwise
    this.spinUntil = 0;
    this.nextTurnAt = 0;
    this.raceStarted = false;
    this.myLaps = 0;
    this.finished = false;
  }

  preload() {
    // Procedurally generated textures so we don't need external art assets.
    const g = this.make.graphics({ x: 0, y: 0, add: false });

    g.fillStyle(0x3a7d44, 1).fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x2f6a37, 1).fillCircle(TILE * 0.25, TILE * 0.3, 2);
    g.fillStyle(0x2f6a37, 1).fillCircle(TILE * 0.7, TILE * 0.65, 2);
    g.generateTexture('grass', TILE, TILE);
    g.clear();

    g.fillStyle(0x3d3d3d, 1).fillRect(0, 0, TILE, TILE);
    g.generateTexture('road', TILE, TILE);
    g.clear();

    // Checkered start/finish line.
    const checks = 4;
    const cs = TILE / checks;
    for (let i = 0; i < checks; i++) {
      for (let j = 0; j < checks; j++) {
        g.fillStyle((i + j) % 2 === 0 ? 0x000000 : 0xffffff, 1).fillRect(i * cs, j * cs, cs, cs);
      }
    }
    g.generateTexture('finish', TILE, TILE);
    g.clear();

    // Crowd stands: bleacher rows with small colorful dots representing spectators.
    const crowdColors = [0xffcc00, 0xff5555, 0x55aaff, 0xffffff, 0x55cc55, 0xff9933];
    g.fillStyle(0x6b5a44, 1).fillRect(0, 0, TILE, TILE);
    let colorIndex = 0;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) {
        g.fillStyle(crowdColors[colorIndex % crowdColors.length], 1).fillCircle(
          col * (TILE / 4) + TILE / 8,
          row * (TILE / 3) + TILE / 6,
          2
        );
        colorIndex++;
      }
    }
    g.generateTexture('stands', TILE, TILE);
    g.clear();

    this.drawVespa(g, 0x3399ff, 0xddeeff, 0xffffff);
    g.generateTexture('player', SCOOTER_SIZE, SCOOTER_SIZE);
    g.clear();

    this.drawVespa(g, 0xff6633, 0xffe0cc, 0x222222);
    g.generateTexture('otherPlayer', SCOOTER_SIZE, SCOOTER_SIZE);
    g.destroy();
  }

  // Top-down Vespa scooter, facing "up" (front toward y=0), drawn for a SCOOTER_SIZE canvas.
  drawVespa(g, bodyColor, panelColor, stripeColor) {
    const cx = SCOOTER_SIZE / 2;
    const cy = SCOOTER_SIZE / 2;

    g.fillStyle(0x222222, 1).fillRect(cx - 5, cy - 19, 10, 8); // front wheel
    g.fillStyle(0x222222, 1).fillRect(cx - 5, cy + 11, 10, 8); // rear wheel
    g.fillStyle(0x888888, 1).fillCircle(cx, cy - 15, 2.5); // front wheel rim
    g.fillStyle(0x888888, 1).fillCircle(cx, cy + 15, 2.5); // rear wheel rim

    g.fillStyle(bodyColor, 1).fillEllipse(cx, cy, 17, 20); // body
    g.fillStyle(stripeColor, 1).fillRect(cx - 8.5, cy - 2, 17, 4); // racing stripe

    g.fillStyle(panelColor, 1).fillEllipse(cx, cy - 11, 9, 9); // front fairing
    g.fillStyle(0x222222, 1).fillEllipse(cx, cy + 9, 10, 7); // seat

    g.fillStyle(0xffffaa, 1).fillCircle(cx, cy - 17, 2.5); // headlight
    g.fillStyle(0xcc2222, 1).fillCircle(cx, cy + 17, 2); // taillight

    g.fillStyle(0x222222, 1).fillCircle(cx - 9, cy - 13, 2); // left mirror
    g.fillStyle(0x222222, 1).fillCircle(cx + 9, cy - 13, 2); // right mirror

    g.fillStyle(0xdddddd, 1).fillRect(cx - 4, cy + 19, 8, 3); // license plate

    g.fillStyle(0x444444, 1).fillRect(cx + 8, cy + 6, 3, 8); // exhaust pipe
  }

  create() {
    this.boundaries = this.physics.add.staticGroup();
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const cell = MAP[r][c];
        const isRoad = cell === 1 || cell === 2;
        const tex = cell === 2 ? 'finish' : cell === 1 ? 'road' : cell === 0 ? 'grass' : 'stands';
        const tile = this.add.image(c * TILE + TILE / 2, r * TILE + TILE / 2, tex);
        if (!isRoad) {
          this.physics.add.existing(tile, true);
          this.boundaries.add(tile);
        }
      }
    }

    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D');

    this.otherPlayersGroup = this.physics.add.group();
    this.nameTexts = {};

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

    document.getElementById('readyBtn').addEventListener('click', () => this.startCountdown());

    this.socket = io({ query: { name: playerName } });
    this.myId = null;

    this.socket.on('init', ({ id, players }) => {
      this.myId = id;
      const me = players[id];
      this.prevX = me.x;
      this.player = this.physics.add.image(me.x, me.y, 'player').setCollideWorldBounds(true);
      this.physics.add.collider(this.player, this.boundaries, (player, wallTile) =>
        this.triggerSpin(WALL_SPIN_DURATION_MS, wallTile.x, wallTile.y, TILE * 0.75)
      );
      this.physics.add.overlap(this.player, this.otherPlayersGroup, (player, other) =>
        this.triggerSpin(VEHICLE_SPIN_DURATION_MS, other.x, other.y, TILE * 1.25)
      );
      this.cameras.main.startFollow(this.player, true);
      this.myNameText = this.addNameLabel(me.x, me.y);
      this.updateMyLabel();

      Object.entries(players).forEach(([pid, state]) => {
        if (pid !== id) this.addOther(pid, state);
      });
    });

    this.socket.on('playerJoined', ({ id, state }) => this.addOther(id, state));

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

    this.physics.world.setBounds(0, 0, MAP_COLS * TILE, MAP_ROWS * TILE);
    this.lastSent = { x: 0, y: 0, rotation: 0, laps: 0 };
  }

  startCountdown() {
    document.getElementById('readyOverlay').style.display = 'none';
    let count = 3;
    this.statusText.setText(String(count));

    const tick = () => {
      count--;
      if (count > 0) {
        this.statusText.setText(String(count));
        this.time.delayedCall(1000, tick);
      } else {
        this.statusText.setText('GO!');
        this.raceStarted = true;
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
    if (this.myNameText) this.myNameText.setText(`${playerName} ${this.myLaps}/${TOTAL_LAPS}`);
  }

  updateOtherLabel(id) {
    const label = this.nameTexts[id];
    const meta = this.otherMeta[id];
    if (label && meta) label.setText(`${meta.name} ${meta.laps}/${TOTAL_LAPS}`);
  }

  addOther(id, state) {
    const sprite = this.physics.add.image(state.x, state.y, 'otherPlayer');
    sprite.body.setAllowGravity(false);
    sprite.body.moves = false; // remote players are positioned by network updates, not physics
    if (typeof state.rotation === 'number') sprite.rotation = state.rotation;
    this.otherSprites[id] = sprite;
    this.otherPlayersGroup.add(sprite);
    this.otherMeta[id] = { name: state.name || 'Player', laps: state.laps || 0 };
    this.nameTexts[id] = this.addNameLabel(state.x, state.y);
    this.updateOtherLabel(id);
  }

  triggerSpin(durationMs, awayFromX, awayFromY, pushDist) {
    const now = this.time.now;
    if (now < this.spinUntil) return; // already spinning, don't re-trigger
    this.spinUntil = now + durationMs;

    // Push away from the collision source so the spin doesn't immediately re-trigger.
    const dx = this.player.x - awayFromX;
    const dy = this.player.y - awayFromY;
    const dist = Math.max(Math.hypot(dx, dy), 0.01);
    const newX = this.player.x + (dx / dist) * pushDist;
    const newY = this.player.y + (dy / dist) * pushDist;
    this.player.body.reset(newX, newY);
  }

  checkLapCrossing(prevX, currX, currY) {
    if (this.myLaps >= TOTAL_LAPS) return;
    const inBand = currY >= FINISH_Y_TOP && currY <= FINISH_Y_BOTTOM;
    if (!inBand) return;

    // Only crossing right-to-left (counterclockwise) counts as completing a lap.
    if (prevX > FINISH_X && currX <= FINISH_X) {
      this.myLaps++;
      this.updateMyLabel();
      if (this.myLaps >= TOTAL_LAPS) {
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
      const left = this.cursors.left.isDown || this.wasd.A.isDown;
      const right = this.cursors.right.isDown || this.wasd.D.isDown;
      const up = this.cursors.up.isDown || this.wasd.W.isDown;
      const down = this.cursors.down.isDown || this.wasd.S.isDown;

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
  width: Math.min(MAP_COLS * TILE, window.innerWidth),
  height: Math.min(MAP_ROWS * TILE, window.innerHeight),
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: MainScene,
});

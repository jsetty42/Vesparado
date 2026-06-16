const TILE = 32;
const MAP_COLS = 25;
const MAP_ROWS = 19;

const FORWARD_SPEED = 160;
const REVERSE_SPEED = 90;
const TURN_STEP_DEG = 30;
const TURN_INTERVAL_MS = 140; // time between discrete 30-degree steering steps
const SPIN_DURATION_MS = 3000;
const SPIN_RATE_DEG = 25; // degrees per frame while spinning out

// 0 = grass (off-track), 1 = road. A 2-tile-wide rectangular track loop with a cross-street.
const ROAD_MARGIN = 3;
const MAP = [];
for (let r = 0; r < MAP_ROWS; r++) {
  const row = [];
  for (let c = 0; c < MAP_COLS; c++) {
    const onLoop =
      r === ROAD_MARGIN ||
      r === ROAD_MARGIN + 1 ||
      r === MAP_ROWS - 1 - ROAD_MARGIN ||
      r === MAP_ROWS - 2 - ROAD_MARGIN ||
      c === ROAD_MARGIN ||
      c === ROAD_MARGIN + 1 ||
      c === MAP_COLS - 1 - ROAD_MARGIN ||
      c === MAP_COLS - 2 - ROAD_MARGIN;
    const onCross =
      r === Math.floor(MAP_ROWS / 2) ||
      r === Math.floor(MAP_ROWS / 2) - 1 ||
      c === Math.floor(MAP_COLS / 2) ||
      c === Math.floor(MAP_COLS / 2) - 1;
    row.push(onLoop || onCross ? 1 : 0);
  }
  MAP.push(row);
}

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
    this.otherSprites = {};
    this.heading = 0; // radians; 0 = facing up, increases clockwise
    this.spinUntil = 0;
    this.nextTurnAt = 0;
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
    g.fillStyle(0xeeeeee, 1).fillRect(TILE / 2 - 1.5, TILE * 0.15, 3, TILE * 0.3);
    g.fillStyle(0xeeeeee, 1).fillRect(TILE / 2 - 1.5, TILE * 0.65, 3, TILE * 0.3);
    g.generateTexture('road', TILE, TILE);
    g.clear();

    this.drawVespa(g, 0x3399ff, 0xddeeff);
    g.generateTexture('player', TILE, TILE);
    g.clear();

    this.drawVespa(g, 0xff6633, 0xffe0cc);
    g.generateTexture('otherPlayer', TILE, TILE);
    g.destroy();
  }

  // Top-down Vespa scooter, facing "up" (front toward y=0) at native rotation.
  drawVespa(g, bodyColor, panelColor) {
    const cx = TILE / 2;
    const cy = TILE / 2;

    g.fillStyle(0x222222, 1).fillRect(cx - 4, cy + 8, 8, 6); // rear wheel
    g.fillStyle(0x222222, 1).fillRect(cx - 4, cy - 14, 8, 6); // front wheel
    g.fillStyle(bodyColor, 1).fillEllipse(cx, cy, 14, 22); // body
    g.fillStyle(panelColor, 1).fillEllipse(cx, cy - 7, 8, 8); // fairing
    g.fillStyle(0x222222, 1).fillEllipse(cx, cy + 5, 9, 6); // seat
    g.fillStyle(0xffffaa, 1).fillCircle(cx, cy - 12, 2); // headlight
    g.fillStyle(0x222222, 1).fillCircle(cx - 7, cy - 9, 1.5); // mirror
    g.fillStyle(0x222222, 1).fillCircle(cx + 7, cy - 9, 1.5); // mirror
  }

  create() {
    this.boundaries = this.physics.add.staticGroup();
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const isRoad = MAP[r][c] === 1;
        const tex = isRoad ? 'road' : 'grass';
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

    this.socket = io();
    this.myId = null;

    this.socket.on('init', ({ id, players }) => {
      this.myId = id;
      const me = players[id];
      this.player = this.physics.add.image(me.x, me.y, 'player').setCollideWorldBounds(true);
      this.physics.add.collider(this.player, this.boundaries);
      this.physics.add.overlap(this.player, this.otherPlayersGroup, (player, other) =>
        this.triggerSpin(other)
      );
      this.cameras.main.startFollow(this.player, true);

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
    });

    this.socket.on('playerLeft', ({ id }) => {
      const sprite = this.otherSprites[id];
      if (sprite) {
        sprite.destroy();
        delete this.otherSprites[id];
      }
    });

    this.physics.world.setBounds(0, 0, MAP_COLS * TILE, MAP_ROWS * TILE);
    this.lastSent = { x: 0, y: 0, rotation: 0 };
  }

  addOther(id, state) {
    const sprite = this.physics.add.image(state.x, state.y, 'otherPlayer');
    sprite.body.setAllowGravity(false);
    sprite.body.moves = false; // remote players are positioned by network updates, not physics
    if (typeof state.rotation === 'number') sprite.rotation = state.rotation;
    this.otherSprites[id] = sprite;
    this.otherPlayersGroup.add(sprite);
  }

  triggerSpin(other) {
    const now = this.time.now;
    if (now < this.spinUntil) return; // already spinning, don't re-trigger
    this.spinUntil = now + SPIN_DURATION_MS;

    // Push apart so the two scooters no longer overlap once the spin ends,
    // otherwise the overlap would immediately re-trigger another spin.
    const dx = this.player.x - other.x;
    const dy = this.player.y - other.y;
    const dist = Math.max(Math.hypot(dx, dy), 0.01);
    const pushDist = TILE * 1.25;
    const newX = this.player.x + (dx / dist) * pushDist;
    const newY = this.player.y + (dy / dist) * pushDist;
    this.player.body.reset(newX, newY);
  }

  update(time) {
    if (!this.player) return;

    const spinning = time < this.spinUntil;

    if (spinning) {
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
    if (
      Math.abs(x - this.lastSent.x) > 1 ||
      Math.abs(y - this.lastSent.y) > 1 ||
      rotation !== this.lastSent.rotation
    ) {
      this.lastSent = { x, y, rotation };
      this.socket.emit('move', { x, y, rotation });
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

const TILE = 32;
const MAP_COLS = 25;
const MAP_ROWS = 19;
const SPEED = 160;

// 0 = grass, 1 = road. A rectangular road loop with a cross-street through the middle.
const ROAD_MARGIN = 3;
const MAP = [];
for (let r = 0; r < MAP_ROWS; r++) {
  const row = [];
  for (let c = 0; c < MAP_COLS; c++) {
    const onLoop =
      r === ROAD_MARGIN ||
      r === MAP_ROWS - 1 - ROAD_MARGIN ||
      c === ROAD_MARGIN ||
      c === MAP_COLS - 1 - ROAD_MARGIN;
    const onCross = r === Math.floor(MAP_ROWS / 2) || c === Math.floor(MAP_COLS / 2);
    row.push(onLoop || onCross ? 1 : 0);
  }
  MAP.push(row);
}

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
    this.otherSprites = {};
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

    // Rear wheel
    g.fillStyle(0x222222, 1).fillRect(cx - 4, cy + 8, 8, 6);
    // Front wheel
    g.fillStyle(0x222222, 1).fillRect(cx - 4, cy - 14, 8, 6);

    // Main body (rounded, teardrop-ish via ellipse)
    g.fillStyle(bodyColor, 1).fillEllipse(cx, cy, 14, 22);

    // Front fairing/shield panel
    g.fillStyle(panelColor, 1).fillEllipse(cx, cy - 7, 8, 8);

    // Seat
    g.fillStyle(0x222222, 1).fillEllipse(cx, cy + 5, 9, 6);

    // Headlight
    g.fillStyle(0xffffaa, 1).fillCircle(cx, cy - 12, 2);

    // Mirrors
    g.fillStyle(0x222222, 1).fillCircle(cx - 7, cy - 9, 1.5);
    g.fillStyle(0x222222, 1).fillCircle(cx + 7, cy - 9, 1.5);
  }

  create() {
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tex = MAP[r][c] === 1 ? 'road' : 'grass';
        this.add.image(c * TILE + TILE / 2, r * TILE + TILE / 2, tex);
      }
    }

    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D');

    this.socket = io();
    this.myId = null;

    this.socket.on('init', ({ id, players }) => {
      this.myId = id;
      const me = players[id];
      this.player = this.physics.add.image(me.x, me.y, 'player').setCollideWorldBounds(true);
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
    const sprite = this.add.image(state.x, state.y, 'otherPlayer');
    if (typeof state.rotation === 'number') sprite.rotation = state.rotation;
    this.otherSprites[id] = sprite;
  }

  update() {
    if (!this.player) return;

    const left = this.cursors.left.isDown || this.wasd.A.isDown;
    const right = this.cursors.right.isDown || this.wasd.D.isDown;
    const up = this.cursors.up.isDown || this.wasd.W.isDown;
    const down = this.cursors.down.isDown || this.wasd.S.isDown;

    const body = this.player.body;
    body.setVelocity(0);
    if (left) body.setVelocityX(-SPEED);
    else if (right) body.setVelocityX(SPEED);
    if (up) body.setVelocityY(-SPEED);
    else if (down) body.setVelocityY(SPEED);
    body.velocity.normalize().scale(SPEED * (left || right || up || down ? 1 : 0));

    if (body.velocity.x !== 0 || body.velocity.y !== 0) {
      this.player.rotation = Math.atan2(body.velocity.y, body.velocity.x) + Math.PI / 2;
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

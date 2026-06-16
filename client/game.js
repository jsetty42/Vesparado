const TILE = 32;
const MAP_COLS = 25;
const MAP_ROWS = 19;
const SPEED = 160;

// 0 = floor, 1 = wall. Border walls plus a couple of obstacles.
const MAP = [];
for (let r = 0; r < MAP_ROWS; r++) {
  const row = [];
  for (let c = 0; c < MAP_COLS; c++) {
    const isBorder = r === 0 || c === 0 || r === MAP_ROWS - 1 || c === MAP_COLS - 1;
    const isPillar = (r === 5 && c >= 8 && c <= 12) || (r === 13 && c >= 8 && c <= 12);
    row.push(isBorder || isPillar ? 1 : 0);
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
    g.generateTexture('floor', TILE, TILE);
    g.clear();

    g.fillStyle(0x555555, 1).fillRect(0, 0, TILE, TILE);
    g.generateTexture('wall', TILE, TILE);
    g.clear();

    g.fillStyle(0x3399ff, 1).fillCircle(TILE / 2, TILE / 2, TILE / 2 - 4);
    g.generateTexture('player', TILE, TILE);
    g.clear();

    g.fillStyle(0xff6633, 1).fillCircle(TILE / 2, TILE / 2, TILE / 2 - 4);
    g.generateTexture('otherPlayer', TILE, TILE);
    g.destroy();
  }

  create() {
    this.walls = this.physics.add.staticGroup();
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tex = MAP[r][c] === 1 ? 'wall' : 'floor';
        const tile = this.add.image(c * TILE + TILE / 2, r * TILE + TILE / 2, tex);
        if (MAP[r][c] === 1) {
          this.physics.add.existing(tile, true);
          this.walls.add(tile);
        }
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
      this.physics.add.collider(this.player, this.walls);
      this.cameras.main.startFollow(this.player, true);

      Object.entries(players).forEach(([pid, state]) => {
        if (pid !== id) this.addOther(pid, state);
      });
    });

    this.socket.on('playerJoined', ({ id, state }) => this.addOther(id, state));

    this.socket.on('playerMoved', ({ id, state }) => {
      const sprite = this.otherSprites[id];
      if (sprite) sprite.setPosition(state.x, state.y);
    });

    this.socket.on('playerLeft', ({ id }) => {
      const sprite = this.otherSprites[id];
      if (sprite) {
        sprite.destroy();
        delete this.otherSprites[id];
      }
    });

    this.physics.world.setBounds(0, 0, MAP_COLS * TILE, MAP_ROWS * TILE);
    this.lastSent = { x: 0, y: 0 };
  }

  addOther(id, state) {
    this.otherSprites[id] = this.add.image(state.x, state.y, 'otherPlayer');
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

    const { x, y } = this.player;
    if (Math.abs(x - this.lastSent.x) > 1 || Math.abs(y - this.lastSent.y) > 1) {
      this.lastSent = { x, y };
      this.socket.emit('move', { x, y, dir: 'down' });
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

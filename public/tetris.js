// DOWNPOUR — game engine.
// Board is 10 wide, 22 tall (top 2 rows are the spawn buffer, never drawn).

export const COLS = 10;
export const ROWS = 22;
export const BUFFER = 2;
export const VISIBLE = ROWS - BUFFER;

export const PIECES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

// 1..7 map to PIECES above, 8 is garbage.
const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
  O: [[1, 1], [1, 1]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
};

const SPAWN_X = { I: 3, J: 3, L: 3, O: 4, S: 3, T: 3, Z: 3 };

// Super Rotation System kicks, written with y growing downward.
const KICKS_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

const KICKS_I = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

const LINE_SCORE = [0, 100, 300, 500, 800];
const LINE_ATTACK = [0, 0, 1, 2, 4];
const COMBO_ATTACK = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];

// Gravity in milliseconds per cell, indexed by level.
const GRAVITY = [
  1000, 793, 618, 473, 355, 262, 190, 135, 94, 64,
  43, 28, 18, 11, 7, 5, 4, 3, 2, 1.5, 1,
];

function rotateCW(m) {
  const n = m.length;
  const out = [];
  for (let y = 0; y < n; y++) {
    out.push(new Array(n).fill(0));
    for (let x = 0; x < n; x++) out[y][x] = m[n - 1 - x][y];
  }
  return out;
}

function buildRotations(key) {
  const states = [SHAPES[key]];
  for (let i = 1; i < 4; i++) states.push(rotateCW(states[i - 1]));
  return states;
}

const ROTATIONS = {};
for (const key of PIECES) ROTATIONS[key] = buildRotations(key);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Everyone in a room walks the same bag order, so nobody gets a kinder deck.
class BagStream {
  constructor(seed) {
    this.rand = mulberry32(seed);
    this.queue = [];
  }
  refill() {
    const bag = PIECES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      const tmp = bag[i];
      bag[i] = bag[j];
      bag[j] = tmp;
    }
    this.queue.push(...bag);
  }
  peek(n) {
    while (this.queue.length < n) this.refill();
    return this.queue.slice(0, n);
  }
  next() {
    while (this.queue.length < 1) this.refill();
    return this.queue.shift();
  }
}

export class Game {
  constructor(opts = {}) {
    this.seed = opts.seed ?? (Math.random() * 1e9) | 0;
    this.onAttack = opts.onAttack || (() => {});
    this.onTopOut = opts.onTopOut || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.reset(this.seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.bag = new BagStream(seed);
    this.board = new Uint8Array(COLS * ROWS);
    this.hold = null;
    this.holdUsed = false;
    this.lines = 0;
    this.score = 0;
    this.level = 1;
    this.combo = -1;
    this.backToBack = false;
    this.pending = 0;       // garbage rows waiting to rise
    this.attackSent = 0;
    this.dead = false;
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
    this.lastEvent = null;
    this.garbageSalt = 1;
    this.spawn();
  }

  get gravityMs() {
    return GRAVITY[Math.min(this.level - 1, GRAVITY.length - 1)];
  }

  cells(type, rot, px, py) {
    const m = ROTATIONS[type][rot];
    const out = [];
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m.length; x++) {
        if (m[y][x]) out.push([px + x, py + y]);
      }
    }
    return out;
  }

  collides(type, rot, px, py) {
    for (const [x, y] of this.cells(type, rot, px, py)) {
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && this.board[y * COLS + x]) return true;
    }
    return false;
  }

  spawn(type = null) {
    this.type = type || this.bag.next();
    this.rot = 0;
    this.x = SPAWN_X[this.type];
    this.y = 0;
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
    if (this.collides(this.type, this.rot, this.x, this.y)) this.topOut();
  }

  topOut() {
    if (this.dead) return;
    this.dead = true;
    this.onTopOut();
  }

  nextQueue(n = 4) {
    return this.bag.peek(n);
  }

  move(dx) {
    if (this.dead) return false;
    if (this.collides(this.type, this.rot, this.x + dx, this.y)) return false;
    this.x += dx;
    this.touchLock();
    return true;
  }

  rotate(dir) {
    if (this.dead || this.type === 'O') return false;
    const from = this.rot;
    const to = (from + (dir > 0 ? 1 : 3)) % 4;
    const table = this.type === 'I' ? KICKS_I : KICKS_JLSTZ;
    for (const [dx, dy] of table[from + '>' + to]) {
      if (!this.collides(this.type, to, this.x + dx, this.y + dy)) {
        this.rot = to;
        this.x += dx;
        this.y += dy;
        this.touchLock();
        return true;
      }
    }
    return false;
  }

  touchLock() {
    if (this.grounded && this.lockResets < 15) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  softDrop() {
    if (this.dead) return;
    if (!this.collides(this.type, this.rot, this.x, this.y + 1)) {
      this.y++;
      this.score += 1;
      this.dropTimer = 0;
    }
  }

  hardDrop() {
    if (this.dead) return;
    let dist = 0;
    while (!this.collides(this.type, this.rot, this.x, this.y + 1)) {
      this.y++;
      dist++;
    }
    this.score += dist * 2;
    this.lock();
  }

  ghostY() {
    let y = this.y;
    while (!this.collides(this.type, this.rot, this.x, y + 1)) y++;
    return y;
  }

  swapHold() {
    if (this.dead || this.holdUsed) return;
    const held = this.hold;
    this.hold = this.type;
    if (held) this.spawn(held);
    else this.spawn();
    this.holdUsed = true;
  }

  lock() {
    const id = PIECES.indexOf(this.type) + 1;
    for (const [x, y] of this.cells(this.type, this.rot, this.x, this.y)) {
      if (y < 0) continue;
      this.board[y * COLS + x] = id;
    }

    const cleared = this.clearLines();
    let attack = 0;

    if (cleared > 0) {
      const tetris = cleared === 4;
      this.combo++;
      attack = LINE_ATTACK[cleared];
      attack += COMBO_ATTACK[Math.min(this.combo, COMBO_ATTACK.length - 1)];
      if (tetris && this.backToBack) attack += 1;

      this.score += LINE_SCORE[cleared] * this.level + this.combo * 50 * this.level;
      this.lines += cleared;
      this.level = Math.min(20, 1 + Math.floor(this.lines / 10));

      if (this.isBoardEmpty()) {
        attack += 6;
        this.setEvent('PERFECT CLEAR');
      } else if (tetris) {
        this.setEvent(this.backToBack ? 'B2B TETRIS' : 'TETRIS');
      } else if (this.combo > 0) {
        this.setEvent((this.combo + 1) + 'x COMBO');
      } else {
        this.setEvent(['', 'SINGLE', 'DOUBLE', 'TRIPLE'][cleared]);
      }
      this.backToBack = tetris;
    } else {
      this.combo = -1;
      // Lines you clear cancel garbage first; the leftovers rise.
      if (this.pending > 0) this.applyGarbage(this.pending);
    }

    if (attack > 0) {
      const cancelled = Math.min(this.pending, attack);
      this.pending -= cancelled;
      const outgoing = attack - cancelled;
      if (outgoing > 0) {
        this.attackSent += outgoing;
        this.onAttack(outgoing);
      }
    }

    if (!this.dead) {
      this.holdUsed = false;
      this.spawn();
    }
  }

  setEvent(text) {
    this.lastEvent = text;
    this.onEvent(text);
  }

  isBoardEmpty() {
    for (let i = 0; i < this.board.length; i++) if (this.board[i]) return false;
    return true;
  }

  clearLines() {
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      let full = true;
      for (let x = 0; x < COLS; x++) {
        if (!this.board[y * COLS + x]) { full = false; break; }
      }
      if (!full) continue;
      cleared++;
      this.board.copyWithin(COLS, 0, y * COLS);
      this.board.fill(0, 0, COLS);
      y++;
    }
    return cleared;
  }

  queueGarbage(n) {
    this.pending += n;
  }

  applyGarbage(n) {
    this.pending = Math.max(0, this.pending - n);
    const rand = mulberry32(this.seed + this.garbageSalt * 2654435761);
    this.garbageSalt++;
    const hole = Math.floor(rand() * COLS);
    for (let i = 0; i < n; i++) {
      // Anything pushed past the ceiling means you are done.
      for (let x = 0; x < COLS; x++) {
        if (this.board[x]) { this.topOut(); return; }
      }
      this.board.copyWithin(0, COLS);
      const base = (ROWS - 1) * COLS;
      for (let x = 0; x < COLS; x++) this.board[base + x] = x === hole ? 0 : 8;
    }
    if (this.collides(this.type, this.rot, this.x, this.y)) {
      if (!this.collides(this.type, this.rot, this.x, this.y - 1)) this.y--;
      else this.topOut();
    }
  }

  tick(dt) {
    if (this.dead) return;
    const grounded = this.collides(this.type, this.rot, this.x, this.y + 1);

    if (grounded) {
      if (!this.grounded) { this.grounded = true; this.lockTimer = 0; }
      this.lockTimer += dt;
      if (this.lockTimer >= 500) this.lock();
      return;
    }

    this.grounded = false;
    this.lockTimer = 0;
    this.dropTimer += dt;
    const step = this.gravityMs;
    let guard = 0;
    while (this.dropTimer >= step && guard++ < ROWS) {
      this.dropTimer -= step;
      if (this.collides(this.type, this.rot, this.x, this.y + 1)) break;
      this.y++;
    }
  }

  // Compact snapshot of the visible board with the active piece drawn in,
  // so an opponent mini board moves in real time.
  snapshot() {
    const out = new Uint8Array(COLS * VISIBLE);
    out.set(this.board.subarray(BUFFER * COLS));
    if (!this.dead) {
      for (const [x, y] of this.cells(this.type, this.rot, this.x, this.y)) {
        const vy = y - BUFFER;
        if (vy >= 0 && vy < VISIBLE) out[vy * COLS + x] = PIECES.indexOf(this.type) + 1;
      }
    }
    let s = '';
    for (let i = 0; i < out.length; i++) s += out[i];
    return s;
  }
}

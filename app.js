// DOWNPOUR — client: screens, room socket, input, rendering.

import { Game, COLS, VISIBLE, BUFFER, PIECES } from './tetris.js';

/* ─────────────── palette ─────────────── */

const COLORS = [
  null,
  '#5ad6e0', // I
  '#6c8cff', // J
  '#ffa663', // L
  '#ffd772', // O
  '#6fe39b', // S
  '#c08bff', // T
  '#ff7a93', // Z
  '#454b60', // garbage
];

const $ = (sel) => document.querySelector(sel);
const el = {
  landing: $('#screen-landing'),
  room: $('#screen-room'),
  name: $('#input-name'),
  code: $('#input-code'),
  create: $('#btn-create'),
  joinForm: $('#form-join'),
  solo: $('#btn-solo'),
  landingError: $('#landing-error'),
  leave: $('#btn-leave'),
  codeChip: $('#btn-code'),
  roomCode: $('#room-code'),
  copyHint: $('#copy-hint'),
  playerCount: $('#player-count'),
  board: $('#canvas-board'),
  hold: $('#canvas-hold'),
  next: $('#canvas-next'),
  overlay: $('#overlay'),
  overlayBody: $('#overlay-body'),
  opponents: $('#opponents'),
  ticker: $('#ticker'),
  gauge: $('#gauge-fill'),
  flash: $('#flash'),
  statLines: $('#stat-lines'),
  statScore: $('#stat-score'),
  statLevel: $('#stat-level'),
  statSent: $('#stat-sent'),
};

/* ─────────────── app state ─────────────── */

const app = {
  mode: 'idle',        // idle | lobby | countdown | playing | dead | over | solo
  ws: null,
  me: null,
  host: null,
  room: '',
  players: [],
  boards: new Map(),   // id -> snapshot string
  game: null,
  solo: false,
  countdownEnd: 0,
  countdownShown: null,
  roomPhase: 'lobby',
  greeted: false,
  standings: [],
  lastSent: 0,
  lastSnapshot: '',
  tickerTimer: 0,
};

// Storage can be switched off entirely; the name is a convenience, not a feature.
function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (_) { /* private mode, sandboxed frame, whatever */ }
  return null;
}

const saved = remember('downpour.name');
if (saved) el.name.value = saved;

const urlRoom = new URL(location.href).searchParams.get('r');
if (urlRoom) el.code.value = urlRoom.toUpperCase();

/* ─────────────── screens ─────────────── */

function showScreen(which) {
  el.landing.classList.toggle('is-active', which === 'landing');
  el.room.classList.toggle('is-active', which === 'room');
}

function fail(text) {
  el.landingError.textContent = text;
}

function ticker(text, ms = 2600) {
  el.ticker.textContent = text;
  clearTimeout(app.tickerTimer);
  app.tickerTimer = setTimeout(() => { el.ticker.textContent = ''; }, ms);
}

/* ─────────────── landing actions ─────────────── */

function playerName() {
  const name = (el.name.value || '').trim().slice(0, 14);
  remember('downpour.name', name);
  return name || 'anon';
}

el.create.addEventListener('click', async () => {
  fail('');
  el.create.disabled = true;
  try {
    const res = await fetch('/api/new');
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    enterRoom(data.room);
  } catch (err) {
    fail('Could not reach the room service. Try again.');
  } finally {
    el.create.disabled = false;
  }
});

el.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  fail('');
  const code = (el.code.value || '').trim().toUpperCase();
  if (code.length < 3) return fail('That code looks too short.');
  enterRoom(code);
});

el.solo.addEventListener('click', () => startSolo());

el.leave.addEventListener('click', () => leaveRoom());

el.codeChip.addEventListener('click', async () => {
  const link = `${location.origin}/?r=${app.room}`;
  try {
    await navigator.clipboard.writeText(link);
    el.copyHint.textContent = 'link copied';
  } catch (_) {
    el.copyHint.textContent = app.room;
  }
  el.codeChip.classList.add('copied');
  setTimeout(() => {
    el.codeChip.classList.remove('copied');
    el.copyHint.textContent = 'copy';
  }, 1800);
});

/* ─────────────── room socket ─────────────── */

function enterRoom(code) {
  app.room = code;
  app.solo = false;
  app.greeted = false;
  app.roomPhase = 'lobby';
  app.players = [];
  app.boards.clear();
  el.roomCode.textContent = code;
  el.opponents.innerHTML = '<p class="empty-note">Nobody else yet. Send them the code.</p>';
  showScreen('room');
  resetGame(Date.now() & 0x7fffffff);
  setMode('lobby');
  history.replaceState(null, '', `/?r=${code}`);
  connect(code);
}

function connect(code) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/api/room/${code}/ws?name=${encodeURIComponent(playerName())}`;
  const ws = new WebSocket(url);
  app.ws = ws;

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    handle(msg);
  });

  ws.addEventListener('close', () => {
    if (app.solo || app.mode === 'idle') return;
    if (!app.greeted) {
      // Never got a welcome: the room was full, or the code goes nowhere.
      showScreen('landing');
      setMode('idle');
      fail('That room is full or no longer there.');
      return;
    }
    ticker('connection lost — reload to rejoin', 8000);
    renderOverlay();
  });

  ws.addEventListener('error', () => {
    if (!app.greeted) fail('Could not join that room.');
  });
}

function send(msg) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(msg));
}

function leaveRoom() {
  if (app.ws) { try { app.ws.close(); } catch (_) {} }
  app.ws = null;
  app.solo = false;
  app.greeted = false;
  setMode('idle');
  history.replaceState(null, '', '/');
  showScreen('landing');
}

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      app.me = msg.you;
      app.greeted = true;
      app.roomPhase = msg.phase;
      renderOverlay();
      break;

    case 'players':
      app.players = msg.players;
      app.host = msg.host;
      app.roomPhase = msg.phase;
      el.playerCount.textContent = String(msg.players.length);
      for (const p of msg.players) {
        if (p.board && p.id !== app.me) app.boards.set(p.id, p.board);
      }
      renderOpponents();
      if (app.mode === 'lobby' || app.mode === 'over' || app.mode === 'dead') renderOverlay();
      break;

    case 'start':
      resetGame(msg.seed);
      app.countdownEnd = performance.now() + msg.in;
      app.countdownShown = null;
      setMode('countdown');
      break;

    case 'go':
      if (app.mode === 'countdown') setMode('playing');
      break;

    case 'board':
      app.boards.set(msg.id, msg.b);
      paintOpponent(msg.id);
      break;

    case 'garbage':
      if (app.game && !app.game.dead) {
        app.game.queueGarbage(msg.n);
        el.flash.classList.remove('hit');
        void el.flash.offsetWidth;
        el.flash.classList.add('hit');
        ticker(`+${msg.n} from ${msg.from}`);
      }
      break;

    case 'hit':
      if (msg.from === app.me) {
        const victim = app.players.find((p) => p.id === msg.to);
        ticker(`sent ${msg.n} to ${victim ? victim.name : 'someone'}`);
        markTarget(msg.to);
      }
      break;

    case 'out':
      if (msg.id !== app.me) {
        const p = app.players.find((x) => x.id === msg.id);
        if (p) ticker(`${p.name} topped out`);
      }
      break;

    case 'over':
      app.standings = msg.standings;
      setMode('over');
      break;

    case 'lobby':
      app.boards.clear();
      resetGame(Date.now() & 0x7fffffff);
      setMode('lobby');
      renderOpponents();
      break;

    case 'notice':
      ticker(msg.text, 4000);
      break;

    default:
      break;
  }
}

/* ─────────────── mode + overlay ─────────────── */

function setMode(mode) {
  app.mode = mode;
  renderOverlay();
}

function renderOverlay() {
  const open = app.mode !== 'playing';
  el.overlay.classList.toggle('is-open', open);
  if (!open) { el.overlayBody.innerHTML = ''; return; }

  if (app.mode === 'countdown') {
    const left = Math.max(0, app.countdownEnd - performance.now());
    const n = Math.ceil(left / 1000);
    const label = n > 0 ? String(n) : 'GO';
    // Only repaint when the number changes, or the pop animation restarts every frame.
    if (app.countdownShown !== label) {
      app.countdownShown = label;
      el.overlayBody.innerHTML = `<div class="countdown">${label}</div>`;
    }
    return;
  }

  if (app.solo) return renderSoloOverlay();

  if (!app.greeted) {
    el.overlayBody.innerHTML = `<h2>Connecting…</h2><p>Reaching room ${escapeHTML(app.room)}.</p>`;
    return;
  }

  const isHost = app.me && app.me === app.host;
  const me = app.players.find((p) => p.id === app.me);

  if (app.mode === 'lobby' && (app.roomPhase === 'playing' || app.roomPhase === 'countdown')) {
    el.overlayBody.innerHTML = `
      <h2>Round in progress</h2>
      <p>You arrived mid-storm. Watch their boards on the right — you are in the next one.</p>
      ${rosterHTML(app.players, (p) => `<span class="tag ${p.alive ? 'on' : ''}">${p.alive ? 'alive' : 'out'}</span>`)}
    `;
    return;
  }

  if (app.mode === 'lobby') {
    const enough = app.players.length >= 2;
    const allReady = enough && app.players.every((p) => p.ready);
    el.overlayBody.innerHTML = `
      <h2>Waiting room</h2>
      <p>Pass this around. Anyone with the code drops into the same storm.</p>
      <span class="big-code">${app.room}</span>
      ${rosterHTML(app.players, (p) => `<span class="tag ${p.ready ? 'on' : ''}">${p.ready ? 'ready' : 'idle'}</span>`)}
      <button class="btn btn-ghost" data-act="ready">${me && me.ready ? 'Not ready' : 'I am ready'}</button>
      ${isHost
        ? `<button class="btn btn-primary" data-act="start" ${allReady ? '' : 'disabled'}>Start the round
             <span class="btn-note">${enough ? (allReady ? 'everyone is in' : 'waiting on ready') : 'needs a second player'}</span>
           </button>`
        : `<p style="margin-top:14px">The host starts the round.</p>`}
    `;
    return;
  }

  if (app.mode === 'dead') {
    const place = me && me.place ? me.place : app.players.length;
    el.overlayBody.innerHTML = `
      <h2>You are out</h2>
      <p>Finished ${ordinal(place)}. Watch the rest of it fall on the right.</p>
    `;
    return;
  }

  if (app.mode === 'over') {
    const standings = app.standings || [];
    const winner = standings[0];
    el.overlayBody.innerHTML = `
      <h2>${winner && winner.id === app.me ? 'You held out' : `${winner ? winner.name : 'Nobody'} held out`}</h2>
      <p>Final stack.</p>
      ${rosterHTML(standings, (p, i) => `<span class="place">${ordinal(p.place || i + 1)} · ${p.lines} lines</span>`, true)}
      ${isHost
        ? `<button class="btn btn-primary" data-act="again">Back to the room</button>`
        : `<p style="margin-top:14px">Waiting on the host for another round.</p>`}
    `;
    return;
  }

  el.overlayBody.innerHTML = `<h2>Connecting…</h2><p>Reaching room ${app.room}.</p>`;
}

function renderSoloOverlay() {
  if (app.mode === 'lobby') {
    el.overlayBody.innerHTML = `
      <h2>Warm up</h2>
      <p>No room, no opponents. Just the weather and you.</p>
      <button class="btn btn-primary" data-act="solostart">Drop the first piece</button>
    `;
  } else if (app.mode === 'over' || app.mode === 'dead') {
    el.overlayBody.innerHTML = `
      <h2>Topped out</h2>
      <p>${app.game.lines} lines · ${app.game.score.toLocaleString()} points.</p>
      <button class="btn btn-primary" data-act="solostart">Again</button>
      <button class="btn btn-ghost" data-act="leave">Back to the landing</button>
    `;
  }
}

function rosterHTML(list, tagFn, rankMode = false) {
  const items = list.map((p, i) => {
    const mine = p.id === app.me ? ' me' : '';
    const win = rankMode && i === 0 ? ' win' : '';
    return `<li class="${mine}${win}"><strong>${escapeHTML(p.name)}</strong>${tagFn(p, i)}</li>`;
  }).join('');
  return `<ul class="roster">${items}</ul>`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

el.overlayBody.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'ready') {
    const me = app.players.find((p) => p.id === app.me);
    send({ t: 'ready', v: !(me && me.ready) });
  } else if (act === 'start') {
    send({ t: 'start' });
  } else if (act === 'again') {
    send({ t: 'again' });
  } else if (act === 'solostart') {
    resetGame((Math.random() * 1e9) | 0);
    setMode('playing');
  } else if (act === 'leave') {
    leaveRoom();
  }
});

/* ─────────────── game wiring ─────────────── */

function resetGame(seed) {
  shards.length = 0;
  rowFlashes.length = 0;
  app.game = new Game({
    seed,
    onClear: (rows) => spawnShatter(rows),
    onAttack: (n) => { if (!app.solo) send({ t: 'attack', n }); },
    onTopOut: () => {
      if (app.solo) { setMode('over'); return; }
      pushState(true);          // let them see the board that killed you
      send({ t: 'dead' });
      setMode('dead');
    },
    onEvent: (text) => ticker(text),
  });
  app.lastSnapshot = '';
  updateStats();
}

function startSolo() {
  app.solo = true;
  app.room = 'solo';
  app.players = [];
  app.boards.clear();
  el.roomCode.textContent = 'SOLO';
  el.opponents.innerHTML = '<p class="empty-note">Warm-up run. Open a room when you want company.</p>';
  el.playerCount.textContent = '1';
  showScreen('room');
  resetGame((Math.random() * 1e9) | 0);
  setMode('lobby');
}

function pushState(force = false) {
  if (app.solo || !app.game) return;
  const snap = app.game.snapshot();
  const now = performance.now();
  if (!force && snap === app.lastSnapshot) return;
  if (!force && now - app.lastSent < 90) return;
  app.lastSent = now;
  app.lastSnapshot = snap;
  send({ t: 'state', b: snap, lines: app.game.lines });
}

function updateStats() {
  const g = app.game;
  if (!g) return;
  el.statLines.textContent = g.lines;
  el.statScore.textContent = g.score.toLocaleString();
  el.statLevel.textContent = g.level;
  el.statSent.textContent = g.attackSent;
  el.gauge.style.height = `${Math.min(100, (g.pending / 12) * 100)}%`;
}

/* ─────────────── input ─────────────── */

const held = { left: false, right: false, down: false };
const repeat = { left: 0, right: 0 };
const DAS = 150;
const ARR = 33;

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowDown: 'down', KeyS: 'down',
};

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const g = app.game;
  const live = app.mode === 'playing' && g && !g.dead;

  if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
  if (!live) return;

  const dir = KEYMAP[event.code];
  if (dir) {
    if (!held[dir]) {
      held[dir] = true;
      repeat[dir] = -DAS;
      if (dir === 'left') g.move(-1);
      else if (dir === 'right') g.move(1);
      else g.softDrop();
    }
    return;
  }

  switch (event.code) {
    case 'ArrowUp': case 'KeyX': g.rotate(1); break;
    case 'KeyZ': case 'ControlLeft': case 'ControlRight': g.rotate(-1); break;
    case 'Space': g.hardDrop(); break;
    case 'ShiftLeft': case 'ShiftRight': case 'KeyC': g.swapHold(); break;
    default: break;
  }
});

window.addEventListener('keyup', (event) => {
  const dir = KEYMAP[event.code];
  if (dir) held[dir] = false;
});

window.addEventListener('blur', () => {
  held.left = held.right = held.down = false;
});

function handleRepeats(dt) {
  const g = app.game;
  if (!g || g.dead) return;
  for (const dir of ['left', 'right']) {
    if (!held[dir]) { repeat[dir] = 0; continue; }
    repeat[dir] += dt;
    while (repeat[dir] >= ARR) {
      repeat[dir] -= ARR;
      g.move(dir === 'left' ? -1 : 1);
    }
  }
  if (held.down) {
    repeat.down = (repeat.down || 0) + dt;
    while (repeat.down >= 35) {
      repeat.down -= 35;
      g.softDrop();
    }
  } else {
    repeat.down = 0;
  }
}

/* ─────────────── rendering ─────────────── */

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext('2d');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Colours are authored as hex; glass needs them at arbitrary alpha.
const RGB_CACHE = {};
function withAlpha(hex, a) {
  if (!RGB_CACHE[hex]) {
    const n = parseInt(hex.slice(1), 16);
    RGB_CACHE[hex] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const [r, g, b] = RGB_CACHE[hex];
  return `rgba(${r},${g},${b},${a})`;
}

// A block of glass: you see through the middle, the edges hold the colour,
// and one corner catches the light.
function drawCell(ctx, x, y, size, colorIndex, opts = {}) {
  const color = COLORS[colorIndex] || '#8891a8';
  const pad = size * 0.05;
  const s = size - pad * 2;
  const r = Math.max(2, size * 0.18);
  const left = x + pad;
  const top = y + pad;

  if (opts.ghost) {
    ctx.save();
    ctx.strokeStyle = withAlpha(color, 0.45);
    ctx.lineWidth = Math.max(1, size * 0.045);
    ctx.setLineDash([size * 0.18, size * 0.13]);
    roundRect(ctx, left, top, s, s, r);
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.save();
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;

  // the pane: thin through the middle, denser where it turns
  const body = ctx.createLinearGradient(left, top, left + s, top + s);
  body.addColorStop(0, withAlpha(color, 0.62));
  body.addColorStop(0.45, withAlpha(color, 0.22));
  body.addColorStop(1, withAlpha(color, 0.5));
  ctx.fillStyle = body;
  roundRect(ctx, left, top, s, s, r);
  ctx.fill();

  // thickness — light on top, shadow pooling at the bottom
  const depth = ctx.createLinearGradient(left, top, left, top + s);
  depth.addColorStop(0, 'rgba(255,255,255,0.20)');
  depth.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  depth.addColorStop(1, 'rgba(0,0,0,0.26)');
  ctx.fillStyle = depth;
  roundRect(ctx, left, top, s, s, r);
  ctx.fill();

  // a specular streak laid across the top-left corner
  ctx.save();
  roundRect(ctx, left, top, s, s, r);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.26)';
  ctx.beginPath();
  ctx.moveTo(left - s * 0.10, top + s * 0.44);
  ctx.lineTo(left + s * 0.50, top - s * 0.10);
  ctx.lineTo(left + s * 0.74, top - s * 0.10);
  ctx.lineTo(left - s * 0.10, top + s * 0.70);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // the polished edge
  const rim = ctx.createLinearGradient(left, top, left + s, top + s);
  rim.addColorStop(0, 'rgba(255,255,255,0.85)');
  rim.addColorStop(0.4, withAlpha(color, 0.75));
  rim.addColorStop(1, 'rgba(255,255,255,0.26)');
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1, size * 0.055);
  roundRect(ctx, left, top, s, s, r);
  ctx.stroke();

  ctx.restore();
}

/* ─────────────── glass shatter ─────────────── */

// Shards are tracked in board cells rather than pixels, so a window resize
// mid-flight doesn't tear them apart.
const shards = [];
const rowFlashes = [];
const MAX_SHARDS = 900;

function makeShard(x, y, color) {
  const angle = Math.random() * Math.PI * 2;
  const speed = 0.0016 + Math.random() * 0.0055;   // cells per millisecond
  const corners = 3 + (Math.random() < 0.45 ? 1 : 0);
  const pts = [];
  for (let i = 0; i < corners; i++) {
    const a = (i / corners) * Math.PI * 2 + Math.random() * 0.7;
    const rad = 0.10 + Math.random() * 0.22;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  const life = 700 + Math.random() * 700;
  return {
    x, y, color, pts, life, max: life,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed - 0.004,   // kicked upward, then gravity wins
    rot: Math.random() * Math.PI,
    vrot: (Math.random() - 0.5) * 0.012,
  };
}

function spawnShatter(rows) {
  for (const row of rows) {
    const vy = row.y - BUFFER;
    if (vy < 0 || vy >= VISIBLE) continue;
    rowFlashes.push({ y: vy, life: 420, max: 420 });
    for (let x = 0; x < COLS; x++) {
      const v = row.cells[x];
      if (!v) continue;
      for (let i = 0; i < 5 && shards.length < MAX_SHARDS; i++) {
        shards.push(makeShard(x + Math.random(), vy + Math.random(), COLORS[v]));
      }
    }
  }
}

function stepShatter(dt) {
  const gravity = 0.000022;   // cells per millisecond squared
  for (let i = shards.length - 1; i >= 0; i--) {
    const s = shards[i];
    s.life -= dt;
    if (s.life <= 0) { shards.splice(i, 1); continue; }
    s.vy += gravity * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.rot += s.vrot * dt;
  }
  for (let i = rowFlashes.length - 1; i >= 0; i--) {
    rowFlashes[i].life -= dt;
    if (rowFlashes[i].life <= 0) rowFlashes.splice(i, 1);
  }
}

function drawShatter(ctx, size) {
  for (const f of rowFlashes) {
    const t = f.life / f.max;
    ctx.fillStyle = `rgba(255,255,255,${0.5 * t * t})`;
    ctx.fillRect(0, f.y * size, COLS * size, size);
  }
  for (const s of shards) {
    const t = Math.max(0, s.life / s.max);
    ctx.save();
    ctx.translate(s.x * size, s.y * size);
    ctx.rotate(s.rot);
    ctx.beginPath();
    ctx.moveTo(s.pts[0][0] * size, s.pts[0][1] * size);
    for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i][0] * size, s.pts[i][1] * size);
    ctx.closePath();
    ctx.fillStyle = withAlpha(s.color, 0.5 * t);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.8 * t})`;
    ctx.lineWidth = Math.max(0.6, size * 0.03);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBoard() {
  const ctx = fitCanvas(el.board);
  const w = el.board.width;
  const h = el.board.height;
  const size = w / COLS;
  const g = app.game;

  ctx.clearRect(0, 0, w, h);

  // frosted backing, so the blocks in front of it read as translucent
  const backing = ctx.createLinearGradient(0, 0, 0, h);
  backing.addColorStop(0, 'rgba(255,255,255,0.055)');
  backing.addColorStop(1, 'rgba(255,255,255,0.015)');
  ctx.fillStyle = backing;
  ctx.fillRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 1; x < COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x * size) + 0.5, 0);
    ctx.lineTo(Math.round(x * size) + 0.5, h);
    ctx.stroke();
  }
  for (let y = 1; y < VISIBLE; y++) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y * size) + 0.5);
    ctx.lineTo(w, Math.round(y * size) + 0.5);
    ctx.stroke();
  }

  if (!g) return;

  for (let y = BUFFER; y < BUFFER + VISIBLE; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = g.board[y * COLS + x];
      if (v) drawCell(ctx, x * size, (y - BUFFER) * size, size, v);
    }
  }

  if (!g.dead) {
    const id = PIECES.indexOf(g.type) + 1;
    const gy = g.ghostY();
    for (const [x, y] of g.cells(g.type, g.rot, g.x, gy)) {
      if (y >= BUFFER) drawCell(ctx, x * size, (y - BUFFER) * size, size, id, { ghost: true });
    }
    for (const [x, y] of g.cells(g.type, g.rot, g.x, g.y)) {
      if (y >= BUFFER) drawCell(ctx, x * size, (y - BUFFER) * size, size, id);
    }
  }

  drawShatter(ctx, size);
}

function drawPiecePreview(ctx, type, cx, cy, size) {
  const id = PIECES.indexOf(type) + 1;
  const cells = shapeCells(type);
  const minX = Math.min(...cells.map((c) => c[0]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const ox = cx - ((maxX - minX + 1) * size) / 2 - minX * size;
  const oy = cy - ((maxY - minY + 1) * size) / 2 - minY * size;
  for (const [x, y] of cells) drawCell(ctx, ox + x * size, oy + y * size, size, id);
}

const SHAPE_CACHE = {};
function shapeCells(type) {
  if (!SHAPE_CACHE[type]) {
    const probe = new Game({ seed: 1 });
    SHAPE_CACHE[type] = probe.cells(type, 0, 0, 0);
  }
  return SHAPE_CACHE[type];
}

function drawSideCanvases() {
  const g = app.game;
  if (!g) return;

  const hctx = fitCanvas(el.hold);
  hctx.clearRect(0, 0, el.hold.width, el.hold.height);
  if (g.hold) {
    const size = el.hold.width / 5.6;
    hctx.globalAlpha = g.holdUsed ? 0.35 : 1;
    drawPiecePreview(hctx, g.hold, el.hold.width / 2, el.hold.height / 2, size);
    hctx.globalAlpha = 1;
  }

  const nctx = fitCanvas(el.next);
  nctx.clearRect(0, 0, el.next.width, el.next.height);
  const queue = g.nextQueue(4);
  const size = el.next.width / 6;
  const slot = el.next.height / queue.length;
  queue.forEach((type, i) => {
    nctx.globalAlpha = i === 0 ? 1 : 0.55 - i * 0.09;
    drawPiecePreview(nctx, type, el.next.width / 2, slot * (i + 0.5), i === 0 ? size : size * 0.82);
  });
  nctx.globalAlpha = 1;
}

/* ─────────────── opponents ─────────────── */

const oppNodes = new Map();

function renderOpponents() {
  const others = app.players.filter((p) => p.id !== app.me);

  if (!others.length) {
    if (!app.solo) {
      el.opponents.innerHTML = '<p class="empty-note">Nobody else yet. Send them the code.</p>';
    }
    oppNodes.clear();
    return;
  }

  const seen = new Set();
  for (const p of others) {
    seen.add(p.id);
    let node = oppNodes.get(p.id);
    if (!node) {
      const wrap = document.createElement('div');
      wrap.className = 'opponent';
      wrap.innerHTML = `
        <canvas width="100" height="200"></canvas>
        <div class="opponent-name"><strong></strong><span></span></div>`;
      const note = el.opponents.querySelector('.empty-note');
      if (note) note.remove();
      el.opponents.appendChild(wrap);
      node = { wrap, canvas: wrap.querySelector('canvas'), name: wrap.querySelector('strong'), meta: wrap.querySelector('span') };
      oppNodes.set(p.id, node);
    }
    node.name.textContent = p.name;
    node.meta.textContent = p.alive || app.mode === 'lobby' ? `${p.lines}L` : 'out';
    node.wrap.classList.toggle('dead', app.mode !== 'lobby' && !p.alive);
    paintOpponent(p.id);
  }

  for (const [id, node] of oppNodes) {
    if (!seen.has(id)) {
      node.wrap.remove();
      oppNodes.delete(id);
      app.boards.delete(id);
    }
  }
}

function paintOpponent(id) {
  const node = oppNodes.get(id);
  if (!node) return;
  const snap = app.boards.get(id);
  const canvas = node.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(40, Math.round(rect.width * dpr));
  const h = Math.round((w / COLS) * VISIBLE);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.height = `${h / dpr}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!snap) return;
  const size = w / COLS;
  for (let i = 0; i < snap.length; i++) {
    const v = snap.charCodeAt(i) - 48;
    if (!v) continue;
    const x = i % COLS;
    const y = (i / COLS) | 0;
    // same glass idea, cheap enough to run on five boards at once
    const c = COLORS[v] || '#8891a8';
    ctx.fillStyle = withAlpha(c, 0.40);
    ctx.fillRect(x * size, y * size, size - 1, size - 1);
    ctx.fillStyle = withAlpha(c, 0.85);
    ctx.fillRect(x * size, y * size, size - 1, Math.max(1, size * 0.24));
  }
}

function markTarget(id) {
  const node = oppNodes.get(id);
  if (!node) return;
  node.wrap.classList.add('target');
  setTimeout(() => node.wrap.classList.remove('target'), 500);
}

/* ─────────────── main loop ─────────────── */

let last = performance.now();

function frame(now) {
  const dt = Math.min(100, now - last);
  last = now;

  if (app.mode === 'countdown') {
    renderOverlay();
    if (now >= app.countdownEnd) setMode('playing');
  }

  if (app.mode === 'playing' && app.game) {
    handleRepeats(dt);
    app.game.tick(dt);
    updateStats();
    pushState();
  }

  if (el.room.classList.contains('is-active')) {
    stepShatter(dt);   // shards keep flying even while an overlay is up
    drawBoard();
    drawSideCanvases();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ─────────────── ambient rain ─────────────── */

(function rain() {
  const canvas = document.getElementById('rain');
  const ctx = canvas.getContext('2d');
  let drops = [];
  let w = 0;
  let h = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = canvas.width = Math.round(window.innerWidth * dpr);
    h = canvas.height = Math.round(window.innerHeight * dpr);
    const count = Math.round((w * h) / 46000);
    drops = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      len: 18 + Math.random() * 70,
      v: 0.6 + Math.random() * 2.4,
      a: 0.04 + Math.random() * 0.12,
    }));
  }

  function step() {
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1.1;
    for (const d of drops) {
      ctx.strokeStyle = `rgba(160,170,220,${d.a})`;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x, d.y + d.len);
      ctx.stroke();
      d.y += d.v * 3;
      if (d.y > h) { d.y = -d.len; d.x = Math.random() * w; }
    }
    requestAnimationFrame(step);
  }

  window.addEventListener('resize', resize);
  resize();
  step();
})();

showScreen('landing');

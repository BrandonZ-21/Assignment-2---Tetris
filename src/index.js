// DOWNPOUR — Cloudflare Worker entry + the Durable Object that owns one room.
//
// The Worker is a thin router. Every room code maps to exactly one Durable
// Object instance, which holds the WebSockets, the shared piece seed, and the
// routing of garbage lines between players. Boards are simulated on each
// client; the room only relays.

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ2345679'; // no look-alikes
const MAX_PLAYERS = 6;
const COUNTDOWN_MS = 3200;

function makeCode(len = 4) {
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/new') {
      // Hand out a code that nobody is sitting in right now.
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = makeCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch('https://room/probe');
        const info = await res.json();
        if (info.count === 0) return json({ room: code });
      }
      return json({ room: makeCode(5) });
    }

    const match = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{3,8})\/(ws|probe)$/);
    if (match) {
      const code = match[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const forward = new URL(request.url);
      forward.pathname = '/' + match[2];
      forward.searchParams.set('room', code);
      return stub.fetch(new Request(forward, request));
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, { status: 404 });

    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.meta = null;
  }

  async loadMeta() {
    if (!this.meta) {
      this.meta = (await this.ctx.storage.get('meta')) || {
        code: '',
        phase: 'lobby', // lobby | countdown | playing | over
        seed: 0,
        round: 0,
      };
    }
    return this.meta;
  }

  saveMeta() {
    return this.ctx.storage.put('meta', this.meta);
  }

  sockets() {
    return this.ctx.getWebSockets();
  }

  players() {
    const list = [];
    for (const ws of this.sockets()) {
      const p = ws.deserializeAttachment();
      if (p) list.push(p);
    }
    list.sort((a, b) => a.joined - b.joined);
    return list;
  }

  hostId() {
    const list = this.players();
    return list.length ? list[0].id : null;
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch (_) { /* socket already gone */ }
  }

  broadcast(msg, exceptId = null) {
    const payload = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      const p = ws.deserializeAttachment();
      if (exceptId && p && p.id === exceptId) continue;
      try { ws.send(payload); } catch (_) { /* socket already gone */ }
    }
  }

  socketFor(id) {
    for (const ws of this.sockets()) {
      const p = ws.deserializeAttachment();
      if (p && p.id === id) return ws;
    }
    return null;
  }

  update(ws, patch) {
    const p = ws.deserializeAttachment() || {};
    const next = { ...p, ...patch };
    ws.serializeAttachment(next);
    return next;
  }

  roster() {
    return {
      t: 'players',
      host: this.hostId(),
      phase: this.meta.phase,
      players: this.players().map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        alive: p.alive,
        lines: p.lines,
        place: p.place,
        board: p.board || null,
      })),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.loadMeta();

    if (url.pathname === '/probe') {
      return json({ count: this.sockets().length, phase: this.meta.phase });
    }

    if (url.pathname !== '/ws') return json({ error: 'not found' }, { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'expected websocket' }, { status: 426 });
    }

    const code = url.searchParams.get('room') || '';
    const rawName = (url.searchParams.get('name') || '').slice(0, 14).trim();
    const name = rawName || 'player';

    if (this.sockets().length >= MAX_PLAYERS) {
      return json({ error: 'room full' }, { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    if (!this.meta.code) {
      this.meta.code = code;
      await this.saveMeta();
    }

    const player = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      ready: false,
      alive: false,
      lines: 0,
      place: null,
      board: null,
      joined: Date.now() + Math.random(),
    };
    server.serializeAttachment(player);

    this.send(server, {
      t: 'welcome',
      you: player.id,
      room: code,
      phase: this.meta.phase,
      max: MAX_PLAYERS,
    });
    this.broadcast(this.roster());

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.loadMeta();
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const me = ws.deserializeAttachment();
    if (!me) return;

    switch (msg.t) {
      case 'name': {
        const name = String(msg.name || '').slice(0, 14).trim() || 'player';
        this.update(ws, { name });
        this.broadcast(this.roster());
        break;
      }

      case 'ready': {
        this.update(ws, { ready: !!msg.v });
        this.broadcast(this.roster());
        break;
      }

      case 'start': {
        if (me.id !== this.hostId()) return;
        if (this.meta.phase === 'countdown' || this.meta.phase === 'playing') return;
        const list = this.players();
        if (list.length < 2) {
          this.send(ws, { t: 'notice', text: 'Two players minimum. Send the code to someone.' });
          return;
        }
        await this.beginRound();
        break;
      }

      case 'again': {
        if (me.id !== this.hostId()) return;
        this.meta.phase = 'lobby';
        await this.saveMeta();
        for (const sock of this.sockets()) {
          this.update(sock, { ready: false, alive: false, lines: 0, place: null, board: null });
        }
        this.broadcast({ t: 'lobby' });
        this.broadcast(this.roster());
        break;
      }

      case 'state': {
        if (this.meta.phase !== 'playing') return;
        const board = typeof msg.b === 'string' ? msg.b.slice(0, 200) : null;
        const lines = Number(msg.lines) || 0;
        this.update(ws, { board, lines });
        this.broadcast({ t: 'board', id: me.id, b: board, lines }, me.id);
        break;
      }

      case 'attack': {
        if (this.meta.phase !== 'playing') return;
        const n = Math.max(0, Math.min(20, Number(msg.n) || 0));
        if (!n) return;
        const targets = this.players().filter((p) => p.alive && p.id !== me.id);
        if (!targets.length) return;
        const victim = targets[Math.floor(Math.random() * targets.length)];
        const sock = this.socketFor(victim.id);
        if (sock) this.send(sock, { t: 'garbage', n, from: me.name });
        this.broadcast({ t: 'hit', from: me.id, to: victim.id, n });
        break;
      }

      case 'dead': {
        if (this.meta.phase !== 'playing' || !me.alive) return;
        await this.kill(ws);
        break;
      }

      default:
        break;
    }
  }

  async beginRound() {
    this.meta.phase = 'countdown';
    this.meta.round++;
    this.meta.seed = (Math.random() * 2147483647) | 0;
    await this.saveMeta();

    for (const sock of this.sockets()) {
      this.update(sock, { alive: true, lines: 0, place: null, board: null, ready: false });
    }

    this.broadcast({ t: 'start', seed: this.meta.seed, in: COUNTDOWN_MS });
    this.broadcast(this.roster());

    this.ctx.waitUntil((async () => {
      await new Promise((r) => setTimeout(r, COUNTDOWN_MS));
      await this.loadMeta();
      if (this.meta.phase !== 'countdown') return;
      this.meta.phase = 'playing';
      await this.saveMeta();
      this.broadcast({ t: 'go' });
    })());
  }

  async kill(ws) {
    const me = ws.deserializeAttachment();
    if (!me || !me.alive) return;
    const aliveAfter = this.players().filter((p) => p.alive && p.id !== me.id).length;
    this.update(ws, { alive: false, place: aliveAfter + 1 });
    this.broadcast({ t: 'out', id: me.id, place: aliveAfter + 1 });
    this.broadcast(this.roster());
    if (aliveAfter <= 1) await this.endRound();
  }

  async endRound() {
    this.meta.phase = 'over';
    await this.saveMeta();
    for (const sock of this.sockets()) {
      const p = sock.deserializeAttachment();
      if (p && p.alive) this.update(sock, { alive: false, place: 1 });
    }
    const standings = this.players()
      .map((p) => ({ id: p.id, name: p.name, lines: p.lines, place: p.place || 99 }))
      .sort((a, b) => a.place - b.place || b.lines - a.lines);
    this.broadcast({ t: 'over', standings });
    this.broadcast(this.roster());
  }

  async webSocketClose(ws) {
    await this.handleGone(ws);
  }

  async webSocketError(ws) {
    await this.handleGone(ws);
  }

  async handleGone(ws) {
    await this.loadMeta();
    const me = ws.deserializeAttachment();
    try { ws.close(1000, 'bye'); } catch (_) { /* already closed */ }
    if (me && me.alive && this.meta.phase === 'playing') {
      const aliveAfter = this.players().filter((p) => p.alive && p.id !== me.id).length;
      this.update(ws, { alive: false, place: aliveAfter + 1 });
      if (aliveAfter <= 1) await this.endRound();
    }
    // The socket is gone from getWebSockets() by the time listeners re-read it.
    setTimeout(() => {
      if (this.sockets().length === 0) {
        this.meta.phase = 'lobby';
        this.saveMeta();
        return;
      }
      this.broadcast(this.roster());
    }, 0);
  }
}

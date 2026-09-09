# DOWNPOUR

*Blocks fall. Someone is watching.*

A multiplayer falling-block game for Cloudflare Workers. Open a room, pass the
four-letter code to a friend, and stack against each other in the same weather —
you see their board in real time, and every line you clear lands on somebody else
as garbage. Last board standing wins.

Two to six players. No accounts, no leaderboards, no ranking. Keyboard only.

## How it plays

| Key | |
| --- | --- |
| `←` `→` | move |
| `↓` | soft drop |
| `↑` / `X` | rotate clockwise |
| `Z` | rotate counter-clockwise |
| `space` | hard drop |
| `shift` / `C` | hold |

Standard rules under the hood: 7-bag randomiser, SRS rotation with wall kicks,
ghost piece, hold, lock delay with move resets, combo and back-to-back bonuses.

**Attacks.** A double sends 1 row, a triple 2, a tetris 4, a perfect clear 6,
plus a combo bonus. Incoming garbage is cancelled by your own clears before it
rises, so a well-timed tetris eats an attack instead of taking it. Garbage lands
on one randomly chosen living opponent.

**Fairness.** Everyone in a room is fed the same seeded piece order, so nobody
gets a kinder deck.

## Architecture

```
browser  ──WebSocket──▶  Worker (router)  ──▶  Durable Object "Room"
   │                                              │
   └─ simulates its own board                     └─ roster, phase, shared seed,
      and sends 10×20 snapshots                      garbage routing, standings
```

- `src/index.js` — the Worker (a thin router) and the `Room` Durable Object.
  One room code maps to exactly one object instance. It never simulates a board;
  it holds the roster, hands out the shared seed, relays board snapshots, and
  decides who takes each attack. It runs no timer of its own, so an idle room
  sleeps and costs nothing.
- `tetris.js` — the game engine. No DOM, no network.
- `app.js` — screens, room socket, input handling, canvas rendering, and the
  glass-and-shatter drawing.
- `styles.css` — colour and mood.
- `.assetsignore` — the site is served from the repository root, so this is what
  keeps `src/`, `wrangler.jsonc` and `package.json` from being published.

Every block is drawn as a translucent pane of glass, and clearing a row bursts
those panes into shards that spin, fall and fade.

Board snapshots are 200-character strings (one digit per visible cell, the active
piece drawn in), sent at most every 90 ms and only when something changed.

## Running it

You need Node.js 18+ (this is the only build dependency — there is no bundler,
the browser loads the ES modules directly).

```bash
npm install
npx wrangler dev
```

Open the printed URL in two browser windows to play against yourself.

## Deploying

```bash
npx wrangler login
npx wrangler deploy
```

Durable Objects with a SQLite backend are on the Workers free plan, so this
deploys as-is. The name of the Worker (and therefore the
`downpour.<your-subdomain>.workers.dev` URL) is set by `name` in
`wrangler.jsonc`.

## Making it yours

Everything about the look lives in three places:

- **Palette and mood** — the custom properties at the top of `styles.css`, and
  the `COLORS` array at the top of `app.js` (one entry per piece).
- **Name and copy** — `index.html`: the wordmark, the tagline, the blurb, and
  the overlay strings in `renderOverlay()` in `app.js`.
- **Feel** — `DAS`/`ARR` in `app.js` for how the keys repeat, and the `GRAVITY`
  table in `tetris.js` for how hard it rains.
- **The glass** — `drawCell()` in `app.js` is the whole material: body gradient,
  depth, specular streak, rim. `makeShard()` and `stepShatter()` next to it
  control how the breakage flies.

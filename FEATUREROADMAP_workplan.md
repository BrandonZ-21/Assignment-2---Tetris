# FEATUREROADMAP — workplan

Every task is a checkbox. Each names what it touches and what "done" means, so
you can stop after any one of them and pick the next up later without holding
anything in your head.

The order matters: **a single-player game is live on the internet before any
multiplayer work starts.** If you run out of time in Phase 2, Phase 1 is already
deployed and playable.

Legend: `[x]` done · `[ ]` not started · `[~]` done but not yet verified live

---

## Phase 1 — a single-player game, live

- [x] **1.1 Repository and first commit**
  Files: everything. Done when: the repo exists on GitHub with one commit.

- [x] **1.2 The three documents**
  Files: `README.md`, `ProductSpec.md`, `FEATUREROADMAP_workplan.md`.
  Done when: all three exist and describe what is actually being built.

- [x] **1.3 The engine — board, pieces, gravity**
  Depends on: nothing. Files: `tetris.js`.
  10×22 board, seven piece shapes, a 7-bag randomiser, gravity by level.
  Done when: pieces spawn, fall on a timer, and stop on the floor.

- [x] **1.4 Movement, rotation, wall kicks**
  Depends on: 1.3. Files: `tetris.js`, `app.js` (keyboard).
  Arrows to move, up/X and Z to rotate, SRS kick tables so rotation works
  against a wall. Done when: an I-piece rotates flush against the left edge.

- [x] **1.5 Locking, line clears, scoring**
  Depends on: 1.4. Files: `tetris.js`.
  Lock delay with move resets, full rows removed, stack falls, score and level.
  Done when: filling a row removes it and the rows above drop by one.

- [x] **1.6 Hold, ghost piece, next queue**
  Depends on: 1.5. Files: `tetris.js`, `app.js`.
  Done when: shift stores a piece, the ghost shows the landing spot, and the
  next four pieces are visible.

- [x] **1.7 The landing screen**
  Depends on: nothing. Files: `index.html`, `styles.css`.
  Name field, "Open a room", a code field and "Join", a solo warm-up link.
  Done when: it reads like a product and not a test page.

- [x] **1.8 Deploy config for Cloudflare Workers**
  Files: `wrangler.jsonc`, `.assetsignore`.
  Assets served from the folder holding `index.html`, `not_found_handling` set
  to `single-page-application`, `run_worker_first` for `/api/*` so the API is
  not swallowed by that fallback. Done when: `npx wrangler deploy` succeeds.

- [ ] **1.9 Single-player game live on the internet** ← *the safety net*
  Depends on: 1.3–1.8.
  Done when: the `workers.dev` URL opens, "Warm up alone" plays a full game,
  and you can send the link to someone who is not you.

---

## Phase 2 — two or more players

- [x] **2.1 The room object**
  Depends on: 1.8. Files: `src/index.js`.
  One Durable Object per room code, SQLite-backed, holding the roster.
  Done when: two browser tabs on the same code appear in each other's roster.

- [x] **2.2 Room codes and the join flow**
  Depends on: 2.1. Files: `src/index.js`, `app.js`, `index.html`.
  `/api/new` hands out an unused four-letter code; `?r=CODE` prefills it.
  Done when: a code copied from one window joins the room from another.

- [x] **2.3 Ready-up, countdown, shared seed**
  Depends on: 2.2. Files: `src/index.js`, `app.js`.
  Everyone marks ready, the host starts, all clients count down from the same
  duration and get an identical piece order. **No timer in the Durable Object.**
  Done when: two windows start together and see the same first piece.

- [x] **2.4 Seeing their board**
  Depends on: 2.3. Files: `app.js`, `src/index.js`.
  Each client sends a 200-character board snapshot about ten times a second;
  the room relays it to everyone else. Done when: moving a piece in one window
  moves it on the mini board in the other. **This is the graded requirement.**

- [x] **2.5 Garbage attacks**
  Depends on: 2.4. Files: `tetris.js`, `src/index.js`, `app.js`.
  Clears send rows to a random living opponent; incoming garbage is cancelled
  by your own clears first. Done when: a tetris in one window pushes four rows
  up in the other.

- [x] **2.6 Topping out, places, standings**
  Depends on: 2.5. Files: `src/index.js`, `app.js`.
  Done when: the loser sees their place, the winner sees the standings, and the
  host can send everyone back to the room for another round.

- [ ] **2.7 Two players live on the internet** ← *the assignment's bar*
  Depends on: 2.1–2.6 deployed.
  Done when: two browser windows are open to the live URL, both typed the same
  room code, and each can see the other player's blocks moving.

---

## Phase 3 — the look

- [x] **3.1 Colour, type, mood**
  Files: `styles.css`, `index.html`.
  Ink background, one violet light source, ambient rain, Space Grotesk and IBM
  Plex Mono. Done when: it looks like a decision rather than a default.

- [~] **3.2 Glass blocks**
  Depends on: 1.5. Files: `app.js`.
  Every block a translucent pane: gradient body you can see through, colour
  gathered at the edges, specular streak across one corner, polished rim.
  Done when: the grid is visible through a resting block. *Written, not yet
  seen running.*

- [~] **3.3 Glass shattering on a clear**
  Depends on: 3.2, 1.5. Files: `tetris.js` (`onClear`), `app.js`.
  Cleared rows burst into spinning shards that fly out, fall under gravity and
  fade, with a white flash along the row. Shards are tracked in board cells, not
  pixels, so resizing mid-flight doesn't tear them. Done when: clearing a row
  visibly breaks it. *Written, not yet seen running.*

---

## Phase 4 — finishing

- [ ] **4.1 Run the test suites again**
  The engine suite (rotation, clears, garbage, attack maths) and the room suite
  (roster, host, attack routing, standings) both passed before the Phase 3 and
  timer changes. They need re-running. Done when: both are green again.

- [ ] **4.2 Play a real two-window round on the live URL**
  Done when: a full round completes, garbage crosses between boards, and the
  standings are right.

- [ ] **4.3 Submit**
  The live URL and the GitHub repo link.

---

## Parked — deliberately not doing

Accounts and logins · leaderboards and saved scores · ranked play and
matchmaking · phone and tablet support. All four are out of scope in the brief.

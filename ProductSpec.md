# ProductSpec — DOWNPOUR

## What it is

A browser game where two to six people drop falling blocks against each other at
the same time. One person opens a room and gets a four-letter code; anyone who
types that code lands in the same game. You play your own board and watch theirs
fill up beside you. Clear lines and the overflow is dumped on somebody else.
Last board still standing wins.

Named DOWNPOUR. The line is *"Blocks fall. Someone is watching."*

## What a player does

1. Lands on the page, types a name (or doesn't — "anon" is fine)
2. Presses **Open a room** and gets a code like `K4TQ`, or types a friend's code
   and presses **Join**
3. Both press **I am ready**; the person who opened the room presses **Start**
4. Three-second countdown, then blocks fall
5. Clearing lines sends garbage rows to a random living opponent; the rows rise
   from the bottom of their board and push their stack toward the ceiling
6. Stack past the top and you're out, with your finishing place shown
7. Last player alive wins; the host sends everyone back to the room for another

There is no sign-up, no password, no saved score, no ranking. Close the tab and
nothing about you persists anywhere.

## The look

Glass. Every block is a translucent pane — you see the grid through the middle,
the colour gathers at the edges, and one corner catches a specular highlight.
Clear a row and the glass breaks: each block bursts into spinning shards that
fly out, fall under gravity, and fade, with a white flash along the row.

Around it: near-black ink, one violet light source, aqua for good news, rose for
damage. Ambient rain drifts behind everything. Type is Space Grotesk for display
and IBM Plex Mono for codes and numbers.

## How it is organised

```
index.html    the two screens: landing, and the room
styles.css    colour, type, layout - all the mood lives here
tetris.js     the game engine. no DOM, no network, no opinions about looks
app.js        screens, room socket, keyboard, canvas drawing, glass + shatter
src/index.js  the Cloudflare Worker: a router, plus the Room Durable Object
wrangler.jsonc  deployment config
```

### The engine (`tetris.js`)

Owns one board and nothing else. 10 columns by 22 rows, the top 2 hidden as
spawn space. Standard rules: a 7-bag randomiser so you never get five S-pieces
in a row, SRS rotation with wall kicks, a ghost showing where the piece lands,
hold, and a half-second lock delay that resets when you move.

It knows nothing about the network. It reports what happened through four
callbacks — `onAttack`, `onTopOut`, `onEvent`, `onClear` — and `app.js` decides
what to do about it. `onClear` hands over the rows that just vanished, with
their colours, which is what the shatter animation is built from.

### The client (`app.js`)

Runs the loop, reads the keyboard, draws the canvas, and holds the WebSocket.
Roughly ten times a second it sends the room a 200-character string: one digit
per visible cell, with the falling piece drawn in. That string is what the other
players see on your mini board.

### The room (`src/index.js`)

One Durable Object per room code — a single small server that only exists while
people are in that room. It is deliberately not a game engine. It holds:

- who is in the room, their names, ready flags, and whether they're still alive
- the shared random seed, so everyone gets the identical piece order
- routing: when you send an attack, it picks a living opponent and forwards it
- finishing places and the final standings

Boards are simulated on each player's own machine. The room relays.

**It never runs a timer.** No `setInterval`, no `setTimeout`, no alarm. The
countdown is run by each client from a duration the room sends. A room with
nobody typing costs nothing and sleeps.

## Rules that produce the fights

| You clear | You send |
| --- | --- |
| 1 line | nothing |
| 2 lines | 1 row |
| 3 lines | 2 rows |
| 4 lines (a tetris) | 4 rows |
| back-to-back tetris | +1 row |
| perfect clear | +6 rows |
| combo (clearing on consecutive pieces) | +1 to +5 rows |

Garbage you have coming is cancelled by your own clears before it lands. A
well-timed tetris eats an incoming attack instead of taking it, which is the
main thing worth getting good at.

## Deliberately not built

Accounts, logins, passwords. Leaderboards or saved scores. Ranked play or
matchmaking. Phone and tablet support — this is a keyboard game.

## Known limits

- Six players per room, because past that the mini boards get too small to read
- A player who reloads mid-round rejoins as a spectator until the next round
- No reconnection: if your connection drops you're out of that round

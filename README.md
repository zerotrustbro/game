# Game Hub

A Cloudflare Workers game hub with **no accounts and no coins** — type a nickname and play. Four games live in sibling directories:

- [`tienlen/`](./tienlen/) — **Tiến Lên Miền Nam**: a 2–4 player realtime card game on five fixed tables (`BAN01`–`BAN05`).
- [`poki/`](./poki/) — **Poki Duel**: an original 1v1 creature gem-battle game on five fixed tables (`POKI01`–`POKI05`). Ported from the standalone `zerotrustbro/poki` project.
- [`xo/`](./xo/) — **XO (Cờ ca-rô)**: a 1v1 tic-tac-toe game on five fixed tables (`XO01`–`XO05`).
- [`flappy/`](./flappy/) — **Flappy Cutie**: cute single-player canvas Flappy Bird (offline, no rooms). Score persists in `localStorage`.

## Playing

- Every table is open to anyone with a nickname (1–18 chars, saved in `localStorage`). No registration, no login, no xu.
- The hub topbar has a nickname field; every game lobby also has one — both share the same stored nickname.
- Your identity is a random per-browser id kept in `localStorage`, so a page refresh or reconnect returns you to your seat.
- Tables where everyone disconnected reset automatically so newcomers can always play.

## Routes

- `/` — Game Room ecosystem hub (tiles for all three games).
- `/tienlen` — Tiến Lên lobby.
- `/tienlen/room/BAN01` — fixed Tiến Lên table link (BAN01–BAN05).
- `/poki` — Poki Duel lobby: pick a creature and one of five 1v1 tables.
- `/poki/?room=POKI01` — deep link to a specific Poki table.
- `/xo` — XO lobby: five 1v1 tables.
- `/xo/?room=XO01` — deep link to a specific XO table.
- `/flappy` — Flappy Cutie: cute single-player canvas game (no rooms, works offline).

The frontend uses History API routing with Cloudflare SPA fallback, so refreshes and shared room URLs return the same app shell and resolve on the client.

## Deploy with Cloudflare Git

- Repository: `zerotrustbro/game`
- Root directory: `/`
- Build/deploy command: `npm run deploy`
- Wrangler config: `wrangler.toml`

The repository builds the Vite-free static clients into `dist/` (root = Tiến Lên, `dist/poki/`, `dist/xo/`, `dist/flappy/`), then Wrangler deploys them with the Worker and Durable Object room state. New games can be added as sibling directories without changing the deployment contract. Durable Objects: `Room` (Tiến Lên), `PokiRoom` (Poki 1v1), `XoRoom` (XO 1v1). Flappy needs no Durable Object (offline solo).

## Local

```bash
npm install
npm test
npm run build
npm run dev
```

Open the URL Wrangler prints. Create a room in one tab and join the same code from another browser/tab.

> `wrangler dev` currently crashes on Windows (libuv assertion in wrangler 4.118 while spawning the local runtime). As a fallback, the repo ships a mock dev server that wires the **real** `Room`, `PokiRoom`, and `XoRoom` worker classes over HTTP + WebSocket:
>
> ```bash
> npm run build
> node scripts/dev-mock.mjs        # → http://localhost:8798/
> node scripts/e2e-smoke.mjs       # full nickname → 1v1 battle smoke for all three games
> ```

## Poki Duel rules

- 1v1 realtime gem battle: swap two adjacent gems to make 3-in-a-row combos.
  - ⚔ Sword matches deal damage, ♥ Heart matches heal, ✦ Mana matches charge the special skill (100 Mana to cast).
- Each table holds exactly two players; a finished match can be rematched (`ĐẤU LẠI`) or left so a new challenger takes the seat.

## XO rules

- Classic 3×3 tic-tac-toe: first player is ✕, second is ○; three in a row wins, a full board is a draw.
- Each table holds exactly two players; after a match ends either player can rematch (`Đấu lại`) or leave.

# Game Hub

A Cloudflare Workers game hub with a shared account system. Two games live in sibling directories:

- [`tienlen/`](./tienlen/) — **Tiến Lên Miền Nam**: a 2–4 player realtime card game on five fixed tables (`BAN01`–`BAN05`).
- [`poki/`](./poki/) — **Poki Duel**: an original 1v1 creature gem-battle game on five fixed tables (`POKI01`–`POKI05`). Ported from the standalone `chungbuild/poki` project; only the shared Game Room account system is reused — no per-game balances.

## Routes

- `/` — Game Room ecosystem hub (tiles for both games).
- `/tienlen` — Tiến Lên lobby.
- `/tienlen/room/ABC123` — shareable Tiến Lên room link; opening it directly joins that room after the visitor enters a name.
- `/poki` — Poki Duel lobby: pick a creature and one of five 1v1 tables.
- `/poki/?room=POKI01` — deep link to a specific Poki table.

The frontend uses History API routing with Cloudflare SPA fallback, so refreshes and shared room URLs return the same app shell and resolve on the client.

## Deploy with Cloudflare Git

- Repository: `chungbuild/game`
- Root directory: `/`
- Build/deploy command: `npm run deploy`
- Wrangler config: `wrangler.toml`

The repository builds the Vite-free static clients into `dist/` (root = Tiến Lên, `dist/poki/` = Poki), then Wrangler deploys them with the Worker and Durable Object room state. New games can be added as sibling directories without changing the deployment contract. Durable Objects: `Room` (Tiến Lên), `PokiRoom` (Poki 1v1), `AccountStore` (shared accounts).

## Local

```bash
npm install
npm test
npm run build
npm run dev
```

Open the URL Wrangler prints. Create a room in one tab and join the same code from another browser/tab.

> `wrangler dev` currently crashes on Windows (libuv assertion in wrangler 4.118 while spawning the local runtime). As a fallback, the repo ships a mock dev server that wires the **real** `AccountStore` and `PokiRoom` worker classes over HTTP + WebSocket:
>
> ```bash
> npm run build
> node scripts/dev-mock.mjs        # → http://localhost:8798/
> node scripts/e2e-smoke.mjs       # runs a full auth + 1v1 battle against the mock
> ```

## Accounts and xu

- A basic account with username, display name, and password is required to join any room (Tiến Lên or Poki).
- New accounts start with 100 xu.
- A completed Tiến Lên round charges each loser 10 xu and gives the collected xu to the winner. Poki Duel does not settle xu — it only uses the shared account for identity.
- The shared `AccountStore` Durable Object is the wallet boundary for future games; it is intentionally not a separate per-game balance.
- This is a family/friends MVP: no email recovery, social login, or admin economy tools yet.

## Poki Duel rules

- 1v1 realtime gem battle: swap two adjacent gems to make 3-in-a-row combos.
  - ⚔ Sword matches deal damage, ♥ Heart matches heal, ✦ Mana matches charge the special skill (100 Mana to cast).
- Each table holds exactly two players; a finished match can be rematched (`ĐẤU LẠI`) or left so a new challenger takes the seat. Disconnected players keep their seat mid-match so they can reconnect, and are replaced automatically when a new player joins.

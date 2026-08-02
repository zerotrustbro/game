# Game Hub

A Cloudflare Workers game hub. The first game lives in [`tienlen/`](./tienlen/): a 2–4 player realtime Tiến Lên Miền Nam room game.

## Routes

- `/` — Game Room ecosystem hub.
- `/tienlen` — Tiến Lên lobby.
- `/tienlen/room/ABC123` — shareable Tiến Lên room link; opening it directly joins that room after the visitor enters a name.

The frontend uses History API routing with Cloudflare SPA fallback, so refreshes and shared room URLs return the same app shell and resolve on the client.

## Deploy with Cloudflare Git

- Repository: `chungbuild/game`
- Root directory: `/`
- Build/deploy command: `npm run deploy`
- Wrangler config: `wrangler.toml`

The repository builds the Vite-free static client into `dist/`, then Wrangler deploys it with the Worker and Durable Object room state. New games can be added as sibling directories without changing the deployment contract.

## Local

```bash
npm install
npm test
npm run build
npm run dev
```

Open the URL Wrangler prints. Create a room in one tab and join the same code from another browser/tab.

## Accounts and xu

- A basic account with username, display name, and password is required to join a room.
- New accounts start with 100 xu.
- A completed Tiến Lên round charges each loser 10 xu and gives the collected xu to the winner.
- The shared `AccountStore` Durable Object is the wallet boundary for future games; it is intentionally not a separate per-game balance.
- This is a family/friends MVP: no email recovery, social login, or admin economy tools yet.

## Current rules

The MVP uses a common South-Vietnam Tiến Lên ruleset: 3 bích starts a new round, same-shape combinations beat lower combinations, tứ quý and 3+ consecutive pairs can cut a single 2, and passing around the table gives the lead back to the last player. Full tournament scoring, tới trắng variants and house-rule toggles are intentionally not included yet.

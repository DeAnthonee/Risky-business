# Risky Business — project notes for Claude

Online multiplayer Risk with bots and an MCP server for AI agents. npm-workspaces monorepo:
`packages/engine` (pure rules, tested), `packages/server` (Express + ws, persistence, bots),
`packages/client` (React + Vite), `packages/mcp` (stdio MCP server).

## Commands

- `npm ci` — install (devDependencies are required to build).
- `npm run build` — builds every package; writes `packages/server/dist/build-info.json`.
- `npm test` — the deploy gate: builds the engine (`pretest`), then typecheck + engine + server tests.
  Works on a fresh clone right after `npm ci`. No fixed ports, no browser.
- `npm start` — `node packages/server/dist/index.js` (reads `PORT`, binds `0.0.0.0`).
- `npm run dev` — server on :8080 with the Vite client on :5173.

## Hosting / ops rules

- Production runs on a Mac mini LaunchAgent at https://risky.deanthoneeking.com behind Cloudflare.
  Deploys are automatic from the deploy branch (see README "Hosting") after `npm test` passes.
- **Hosting bugs arrive as GitHub Issues titled `[OPS] ...`.** When working on one: reproduce it
  locally (server tests or a scratch server on a random port), fix it on the deploy branch, keep
  `npm test` green, and reference the issue in the commit message. Never leave an `[OPS]` issue
  without a fix or a comment explaining what was found.
- Keep these invariants, the pipeline depends on them:
  - `GET /healthz` returns `{ok, version, build, playing, ...}`; `build` is unique per build.
  - `index.html` is served `Cache-Control: no-cache`; `/assets/*` is `immutable`.
  - SIGTERM must finish within a few seconds: snapshot to `RISK_DATA_DIR`, close sockets, exit 0.
  - Persistent state lives only under `RISK_DATA_DIR` (never inside the repo clone).
  - One process, in-memory rooms; no external services, no hard-coded hostnames (relative URLs,
    `ws`/`wss` derived from `location`).
  - Tests bind `127.0.0.1` on port 0 only.

## Conventions

- Rules live in the engine only; the server and MCP never re-implement game logic.
- Every state change goes through `GameRoom.commit` so WebSocket clients, long-poll waiters,
  bots and persistence all see it.
- Add an engine test for every rules change and a server test for every API change.

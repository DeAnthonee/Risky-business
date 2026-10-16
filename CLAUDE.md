# Risky Business — project notes for Claude

Online multiplayer Risk with bots and an MCP server for AI agents. npm-workspaces monorepo:
`packages/engine` (pure rules, tested), `packages/server` (Express + ws, persistence, bots),
`packages/client` (React + Vite), `packages/mcp` (MCP tools; stdio CLI, and embedded in the server at `/mcp`).

## Commands

- `npm ci` — install (devDependencies are required to build).
- `npm run build` — builds every package; writes `packages/server/dist/build-info.json`.
- `npm run build:map` — regenerates `packages/engine/src/generated/{classic,world}.json` (territory shapes,
  anchors, adjacency, sea links) from `scripts/maps/*.mjs` + Natural Earth data. Commit the output.
- `npm test` — the deploy gate: builds the engine (`pretest`), then typecheck + engine + server tests.
  Works on a fresh clone right after `npm ci`. No fixed ports, no browser.
- `npm start` — `node packages/server/dist/index.js` (reads `PORT`, binds `0.0.0.0`). Serves the web
  client, `/api`, `/ws`, `/healthz` and the remote MCP endpoint `/mcp` (Streamable HTTP).
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
  - `/mcp` must keep working for claude.ai connectors: Streamable HTTP, no auth, SSE not buffered.

## Conventions

- Rules live in the engine only; the server and MCP never re-implement game logic.
- Maps are data: edit `scripts/maps/<id>.mjs` (country groupings, lon/lat boxes, edges, anchors), run
  `npm run build:map`, and read its warnings: every adjacency that does not touch on the map becomes a
  drawn sea link, and it lists shapes that touch without being adjacent. Never edit the generated JSON.
- MCP tools are defined once in `packages/mcp/src/tools.ts` over the `RiskApi` interface; the stdio CLI
  uses `HttpRiskApi`, the embedded `/mcp` endpoint uses the server's `LocalRiskApi`.
- Every state change goes through `GameRoom.commit` so WebSocket clients, long-poll waiters,
  bots and persistence all see it.
- Add an engine test for every rules change and a server test for every API change.

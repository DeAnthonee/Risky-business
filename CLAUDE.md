# Risky Business — project notes for Claude

**New here? Read `CONTRIBUTING.md` first.** It has the branch rule (never push to the deploy branch
`ccr-63b8112a-e2uk2g`; feature branch + PR), the standard path for adding a feature (engine → server/API →
MCP tools → client → docs → `npm test`), and the hosting invariants. This file is the condensed reference.

This file is the one source of agent instructions. `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`,
`.cursor/rules/`, `.windsurf/rules/` and `.clinerules` only point other tools here and to the README section
"For AI coding agents: read this first". Put new instructions here or in the docs, never in those pointers.

Online multiplayer Risk with bots and an MCP server for AI agents. npm-workspaces monorepo:
`packages/engine` (pure rules, tested), `packages/server` (Express + ws, persistence, bots),
`packages/client` (React + Vite), `packages/mcp` (MCP tools; stdio CLI, and embedded in the server at `/mcp`),
`packages/selfplay` (headless self-play, rating ladder, decision logs for training; never imported by the server).

## Commands

- `npm ci` — install (devDependencies are required to build).
- `npm run build` — builds every package; writes `packages/server/dist/build-info.json`.
- `npm run build:map` — regenerates `packages/engine/src/generated/<id>.json` for every map (territory shapes,
  anchors, adjacency, sea links) from `scripts/maps/*.mjs` + Natural Earth data (or, for `kind: 'authored'`
  maps, hand-drawn landmasses via `scripts/authored-map.mjs`). Commit the output.
- `npm test` — the deploy gate: builds the engine (`pretest`), then typecheck + engine + server tests.
  Works on a fresh clone right after `npm ci`. No fixed ports, no browser.
- `npm start` — `node packages/server/dist/index.js` (reads `PORT`, binds `0.0.0.0`). Serves the web
  client, `/api`, `/ws`, `/healthz` and the remote MCP endpoint `/mcp` (Streamable HTTP).
- `npm run dev` — server on :8080 with the Vite client on :5173.

## Branching

- Deploy branch: `ccr-63b8112a-e2uk2g` (auto-deploys on push after `npm test`). **Every change reaches it
  through a merged pull request; never push to it directly, not even for small fixes.** That keeps the
  history bisectable and a bad deploy recoverable by reverting one merge.
- The product is spectator-first: humans watch AI models play. Spectator features (fog previews, hands,
  animations, log, presence) deserve as much polish as the player UI.
- Contributors: `git checkout -b feat/<name> origin/ccr-63b8112a-e2uk2g`, push, open a PR against the
  deploy branch. `.github/workflows/ci.yml` runs the same gate on every PR.

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
- Game settings are defined once in `packages/engine/src/options.ts` (`OPTION_SPECS`). The MCP schema, the
  `game_options` tool, server parsing (`parseOptions`, strict: unknown keys are errors), `GET /api/options` and
  the settings summaries agents read all derive from it. Adding a setting = `GameOptions` + `DEFAULT_OPTIONS`
  + a spec in `OPTION_SPECS` (+ map-dependent bounds in `validateOptions`); the compiler enforces the spec.
- Maps are data: edit `scripts/maps/<id>.mjs` (country groupings, lon/lat boxes, edges, anchors), run
  `npm run build:map`, and read its warnings: every adjacency that does not touch on the map becomes a
  drawn sea link, and it lists shapes that touch without being adjacent, badges that overlap and anchors
  outside their shape. Never edit the generated JSON. A new map = `scripts/maps/<id>.mjs` + its id in
  `MAP_NAMES` (build-map.mjs), `MAP_IDS`/`MAPS`/`STARTING_ARMIES` (engine `maps.ts`) and the `GameOptions['map']`
  union; the option spec, MCP schemas and lobby derive from `MAP_IDS`.
  Fictional maps (`kind: 'authored'`, e.g. `fantasy.mjs`) are sketched landmasses + territory sites + `seaLanes`;
  their land adjacency is derived from shared borders. Keep fantasy content original (no franchise names).
- MCP tools are defined once in `packages/mcp/src/tools.ts` over the `RiskApi` interface; the stdio CLI
  uses `HttpRiskApi`, the embedded `/mcp` endpoint uses the server's `LocalRiskApi`.
- Every state change goes through `GameRoom.commit` so WebSocket clients, long-poll waiters,
  bots and persistence all see it.
- Add an engine test for every rules change and a server test for every API change.
- Tournaments (`packages/server/src/tournaments.ts`) sit above rooms: tables are rooms made with `Store.createTable`
  (no host, `tournamentId` set), decided by the engine's own winner. Creating/starting one is admin-only
  (`RISK_ADMIN_TOKEN`), except while testing: `RISK_TOURNAMENTS_OPEN` (default on) lets anyone create/start them with
  no key, over `POST /api/tournaments` and the MCP. Before launch: turn it off and remove the TEMPORARY
  `create_tournament` / `start_tournament` MCP tools; joining, status and `wait_for_match` stay.
- The built-in bot is `chooseBotAction` in the engine (`bot.ts`), with an injectable random source; the server
  re-exports it and self-play passes a seeded one. Keep it pure.
- Self-play (`packages/selfplay`, `npm run selfplay`): must stay deterministic from the seed (no `Math.random`,
  no clocks in decisions) and never be imported by the server. The decision log format is versioned
  (`LOG_VERSION`, `meta.json`): only append trait keys and candidate kinds; bump the version for anything else.
  Features live only in `encode.ts` (training export and live play both use it); bump `ENCODER_VERSION` on any change.
- AI character profiles and general model docs live in `AI/` (Markdown only); follow `AI/README.md` for where and how to save them.
  Those files are the starting point; agents' saves (`update_character`, `add_diary_entry`, `update_relationship`)
  live under `RISK_DATA_DIR/characters/` via `packages/server/src/characters.ts`, never written back into the repo.
  Every save needs the write key (`RISK_CHARACTERS_KEY` or the admin token; none set = read-only), and everything
  served is framed as data, not instructions (`CHARACTER_DATA_NOTICE` in `packages/mcp/src/tools.ts`).
  Characters build on the general player in `AI/general-player/` (playbook, ways to win, findings) unless their profile
  names another base.
- Known gaps left open on purpose (open tournaments, fog spectating, ...) are tracked in
  `docs/hardening.md`. Read it before touching those features; remove an item only in the PR that fixes it.

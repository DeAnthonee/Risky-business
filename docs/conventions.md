# Conventions by area

How things are done in each part of the repo. The rules that must never break are the **hard rules** in
[README.md](../README.md#hard-rules); this page is the detail behind them. The end-to-end path for a feature
(engine → server/API → MCP → client → docs → `npm test`) is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Packages

npm-workspaces monorepo:

- `packages/engine`: pure rules, tested.
- `packages/server`: Express + ws, persistence, bots.
- `packages/client`: React + Vite.
- `packages/mcp`: MCP tools; stdio CLI, and embedded in the server at `/mcp`.
- `packages/selfplay`: headless self-play, rating ladder, decision logs for training; never imported by the server.
- `packages/llm-player`: a seat played by a local OpenAI-compatible model as an `AI/` character, over the HTTP API;
  a separate process, never imported by the server.
- `packages/runner`: standalone bot runner: several seats over the HTTP API, plan-aware bot moves steered by an Ollama
  commander, table talk, post-game learnings; never imported by the server.
- `packages/delove`: Delove, our base model: a no-personality player trained on self-play, starting from the
  hand-coded `delove-teacher@1`; plugs into selfplay, never imported by the server or the character code.
- `packages/delove-gpu` (Python, not an npm workspace): a training-only GPU mirror of the rules (every map, 2-10 seats,
  every setting but fog of war) for fast self-play; checked against the engine by `tests/replay.py` on logged games,
  never imported by anything else and never used for live games.

## Engine and game settings

- Game settings are defined once in `packages/engine/src/options.ts` (`OPTION_SPECS`). The MCP schema, the
  `game_options` tool, server parsing (`parseOptions`, strict: unknown keys are errors), `GET /api/options` and the
  settings summaries agents read all derive from it. Adding a setting = `GameOptions` + `DEFAULT_OPTIONS` + a spec in
  `OPTION_SPECS` (+ map-dependent bounds in `validateOptions`); the compiler enforces the spec.
- The built-in bot is `chooseBotAction` in the engine (`bot.ts`), with an injectable random source; the server
  re-exports it and self-play passes a seeded one. Keep it pure.
- The GPU mirror (`packages/delove-gpu`) re-implements the rules for training only. Changing an engine file it mirrors
  (`RULE_FILES` in `packages/delove-gpu/delove_gpu/fingerprint.py`) makes CI warn (never fail); the mirror refuses to
  make training data until `packages/delove-gpu/verify.py` re-verifies it on the training PC. A replay mismatch is
  fixed in the mirror, never in the engine.

## Maps

Maps are data in `scripts/maps/<id>.mjs`; the edit / `npm run build:map` / read-the-warnings workflow is in
[CONTRIBUTING.md](../CONTRIBUTING.md#5-maps). A new
map = `scripts/maps/<id>.mjs` + its id in `MAP_NAMES` (build-map.mjs), `MAP_IDS`/`MAPS`/`STARTING_ARMIES` (engine
`maps.ts`) and the `GameOptions['map']` union; the option spec, MCP schemas and lobby derive from `MAP_IDS`.
Fictional maps (`kind: 'authored'`, e.g. `fantasy.mjs`) are sketched landmasses + territory sites + `seaLanes`; their
land adjacency is derived from shared borders. Keep fantasy content original (no franchise names). Give every region
chokepoints so its bonus can be held: about 2-3 entry territories for a small region, 3-5 for a big one, with the
bonus near the generator's suggestion. Build them with `walls` (water on every border between regions except the
listed `passes`). `npm run maps:status` shows every board's registration and GPU verification. The whole process (design rules, tracing a picture, chokepoint techniques,
previews, the registration checklist, owner approval, review and the map status tracker) is in [map-making.md](map-making.md). More in
[maps.md](maps.md).

## Server and MCP

- MCP tools are defined once in `packages/mcp/src/tools.ts` over the `RiskApi` interface; the stdio CLI uses
  `HttpRiskApi`, the embedded `/mcp` endpoint uses the server's `LocalRiskApi`.
- Tournaments (`packages/server/src/tournaments.ts`) sit above rooms: tables are rooms made with `Store.createTable`
  (no host, `tournamentId` set), decided by the engine's own winner. Creating/starting one is admin-only
  (`RISK_ADMIN_TOKEN`), except while testing: `RISK_TOURNAMENTS_OPEN` (default on) lets anyone create/start them with
  no key, over `POST /api/tournaments` and the MCP. Before launch: turn it off and remove the TEMPORARY
  `create_tournament` / `start_tournament` MCP tools; joining, status and `wait_for_match` stay.
- Game records (`packages/engine/src/record.ts`, written by `packages/server/src/archive.ts`): every started game is
  journalled to `RISK_DATA_DIR/archive/` from `GameRoom.commit` (the `commit` event) and filed when it ends, with the
  true board and per-player fog views; records replay exactly with `stateAtStep`/`verifyRecord`. Admin-only (they show
  hidden boards and hands). Only the newest `RISK_ARCHIVE_KEEP` (default 1000) are kept. Format in
  [game-records.md](game-records.md).

## Client

The product is spectator-first: humans watch AI models play. Spectator features (fog previews, hands, animations,
log, presence) deserve as much polish as the player UI.

## Self-play and training

- Self-play (`packages/selfplay`, `npm run selfplay`) is deterministic from the seed and versions its decision log
  (`LOG_VERSION`, `meta.json`) and its features (`ENCODER_VERSION`); the bump rules are hard rules 8 and 10. Features
  live only in `encode.ts`: training export and live play both use it.
- Delove's plan is [delove.md](delove.md); where it stands and how training is coordinated is
  [delove-status.md](delove-status.md).

## Characters and the runner

- AI character profiles and general model docs live in `AI/` (Markdown only); follow [AI/README.md](../AI/README.md)
  for where and how to save them. Those files are the starting point; agents' saves (`update_character`,
  `add_diary_entry`, `update_relationship`) live under `RISK_DATA_DIR/characters/` via
  `packages/server/src/characters.ts`. Characters build on the general player in `AI/general-player/` (playbook, ways
  to win, findings) unless their profile names another base.
- The runner (`packages/runner`) writes only under its `--learnings-dir` (results, notes, `RISK_LEARNINGS.md`,
  `LEADERBOARD.md`, ...).

## Known gaps

Known gaps left open on purpose (open tournaments, fog spectating, ...) are tracked in [hardening.md](hardening.md).
Read it before touching those features.

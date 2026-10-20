# Contributing to Risky Business

This guide is written so that a person **or their Claude session** can pick up the repo cold and ship a
feature safely. Read it top to bottom once; it is short. The rules that must never break are the **hard rules** in
[README.md](README.md#hard-rules); the README also has the table of contents of every doc. Per-area conventions are in
[docs/conventions.md](docs/conventions.md).

## 1. The one rule that matters

The branch **`ccr-63b8112a-e2uk2g`** is the **deploy branch**: every push to it is built, tested and put
live at https://risky.deanthoneeking.com within minutes (a failed `npm test` keeps the old build serving).
**Do not push to it directly.** Work on a feature branch and open a pull request; the maintainer merges.

```bash
git clone https://github.com/DeAnthonee/Risky-business
cd Risky-business
git checkout -b feat/<short-name> origin/ccr-63b8112a-e2uk2g   # branch off the deploy branch
npm ci && npm run build && npm test                            # must be green before you start
```

## 2. Where things live

| package | what | touch it when |
| --- | --- | --- |
| `packages/engine` | pure rules of Risk: maps, dice, cards, turn flow, legal moves, redacted views. No I/O. | any rule or game-flow change |
| `packages/server` | Express + WebSocket game server: rooms, bots, persistence, `/api`, `/ws`, `/healthz`, embedded MCP at `/mcp` | any API change, bots, hosting behaviour |
| `packages/client` | React + Vite web UI: lobby, SVG board, animations, cards, chat | anything players see |
| `packages/mcp` | MCP tools for AI agents (used by the stdio CLI **and** by the server's `/mcp`) | anything agents can do |
| `packages/llm-player` | a seat played by a local model as an `AI/` character, over the HTTP API (its own process) | how local models play |
| `packages/selfplay` | headless self-play harness, rating ladder and decision logs for training AI players (not used by the server) | training tooling, new player versions |
| `packages/runner` | standalone bot runner: several seats over the HTTP API, Ollama commander, table talk, post-game learnings (its own process) | the character league's bots |
| `packages/delove` | Delove, our base model: a no-personality player trained on self-play (teacher, network agent, trainer); never used by the server or the character code | Delove training |
| `packages/delove-gpu` | Python, training only: a GPU mirror of the rules for fast self-play, verified against the engine by replay | Delove training speed; after changing a mirrored engine file |
| `scripts/maps/*.mjs` + `scripts/build-map.mjs` | map definitions and the generator that turns real geography into `packages/engine/src/generated/*.json` | adding/changing territories, regions, adjacency |

Data flows one way: **engine → server → client/MCP**. The server and the MCP never re-implement rules;
they call the engine. Every state change goes through `GameRoom.commit()` so WebSocket clients, long-poll
waiters, bots and the on-disk snapshot all see it.

## 3. How to add a feature (the standard path)

1. **Rules first.** If the feature changes how the game plays, implement it in `packages/engine`
   (`engine.ts` for actions/turn flow, `types.ts` for new actions/events/options, `rules.ts` for the
   human-readable rules text agents read). Add a test in `packages/engine/test/engine.test.ts`.
2. **Expose it.** If agents or the client need a new call, add it to the HTTP API in
   `packages/server/src/http.ts` **and** to `packages/server/src/local-api.ts` + the `RiskApi` interface in
   `packages/mcp/src/api.ts` (so the embedded `/mcp` and the stdio CLI both get it). Add a server test in
   `packages/server/test/server.test.ts` (tests bind `127.0.0.1` on port 0; never a fixed port).
3. **Settings.** A new game option goes in `GameOptions` + `DEFAULT_OPTIONS` (`types.ts`) and gets a spec in
   `packages/engine/src/options.ts`; the MCP tools, server parsing and summaries pick it up automatically.
   Add the lobby control in `packages/client/src/components/Home.tsx` (`OptionsForm`).
4. **Tools for agents.** New agent capability → a tool in `packages/mcp/src/tools.ts`, defined once over
   `RiskApi`. Keep descriptions explicit: agents only know what the description says.
5. **UI.** `packages/client/src/components/*`. Game events drive the animations (`useAnimations` in
   `Game.tsx`), so emit a `GameEvent` from the engine rather than guessing in the client.
6. **Docs and log.** Update the doc that describes the area (find it in the README's table of contents), append
   a dated line with the PR number to the area's running log in `docs/logs/`, and add a table-of-contents line for
   any new doc. A new hard rule goes in the README; a convention in `docs/conventions.md`; this file if the workflow
   changes.
7. **Gate.** `npm test` (typecheck + engine + server tests) must be green. Build the client too
   (`npm run build`) so a TypeScript error in the UI does not slip through.
8. **PR.** Push your branch, open a pull request against `ccr-63b8112a-e2uk2g`, fill in the template. CI
   runs the same gate on the PR.

## 4. Things you must not break

The host pipeline depends on the hosting invariants and saved-data rules: README hard rules
[6 and 7](README.md#hard-rules). Host behaviour in detail: [docs/hosting.md](docs/hosting.md).

## 5. Maps

Maps are data. Edit `scripts/maps/<id>.mjs` (country groupings, lon/lat boxes, edges, anchors, labels),
run `npm run build:map`, and read its output: adjacencies that do not touch become drawn sea links, and it
warns about shapes that touch without being adjacent. Commit the regenerated JSON. Never hand-edit the JSON.

Fictional boards use `kind: 'authored'` (see `scripts/maps/fantasy.mjs`): hand-sketched landmass outlines in the
map's own coordinate space, one `site` point per territory (a seeded Voronoi partition with wiggly shared borders
splits each landmass), single-territory islands, and `seaLanes` for crossings over water. Land adjacency comes from
the shapes; the generator also warns about borders too short to count, badges that would overlap, and prints a
suggested bonus per region (size plus entry points) next to the one you set.

## 6. Commands and running locally

```bash
npm ci               # install (devDependencies are required to build)
npm run build        # builds every package; writes packages/server/dist/build-info.json
npm run build:map    # regenerates packages/engine/src/generated/<id>.json for every map; commit the output
npm test             # the deploy gate: builds the engine, then typecheck + engine + server tests (no fixed ports, no browser)
npm run dev          # server :8080 + Vite client :5173 (proxies /api, /ws)
npm start            # production-style: node packages/server/dist/index.js, serves the built client on PORT (default 8080)
```

Play against bots from the lobby. To test agents, point the stdio MCP at your local server
(`RISK_SERVER_URL=http://localhost:8080 node packages/mcp/dist/cli.js`) or connect an MCP client to
`http://localhost:8080/mcp`.

## 7. Style

TypeScript strict, ESM, no default exports in the engine, small pure functions, errors as `RuleError`
with messages a player or agent can read. Commit messages: imperative subject line, body says why.
Keep PRs focused; one feature per PR.

## 8. Hosting bugs

They arrive as GitHub issues titled `[OPS] ...` (README hard rule 14). Reproduce locally (server tests or a scratch
server on a random port), fix on a branch, reference the issue in the commit, PR as usual, and log the fix in
[docs/logs/hosting.md](docs/logs/hosting.md).

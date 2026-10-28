# @risk/delove

**Delove**, our base model: a Risk player with no personality, trained only to win. The plan is in
[docs/delove.md](../../docs/delove.md). This package is never imported by the game server or the character code
(`llm-player`, `runner`, `AI/`); it plugs into the self-play harness (`packages/selfplay`) as player versions.

Everything here is named `delove` (`delove-teacher@1`, `delove@1`, ...) so it never collides with a collaborator's
model on the ladder.

## Run

```bash
npm ci && npm run build
npm run delove -- agents                       # risky@1, random@1, delove-teacher@1, delove@N, delove@N-explore
npm run delove -- ladder --best risky@1 --candidate delove-teacher@1 --games 200
```

`npm run delove` is the self-play CLI (every `play` / `ladder` / `export` option works) with Delove's players
registered first (`node --import ./packages/delove/dist/register.js`): the teacher, and every
`models/delove/delove@N.onnx` (or `DELOVE_MODELS=<dir>`) as `delove@N` (plays its top move) and `delove@N-explore`
(samples, temperature `DELOVE_TEMPERATURE`, default 1, for training games).

## Play in a real game

`npm run delove-seat` seats Delove versions in a real game through the server's HTTP API (the same client the MCP
uses). It doesn't chat and has no character: it waits for its turn, rebuilds the board from its seat's view, picks a
move like in self-play and sends it.

```bash
# join a game someone created (the host starts it): Delove with search at play time, the default
npm run delove-seat -- --server https://risky.deanthoneeking.com --join ABC123
# one seat per version: the bare network (no search) and a teacher
npm run delove-seat -- --server https://risky.deanthoneeking.com --join ABC123 --agents delove@8,delove-teacher@2
# or create one: Delove hosts, adds 2 built-in bots and starts; watch it at <server>/?game=<code>
npm run delove-seat -- --server http://localhost:8080 --create --bots 2
```

**The default seat searches at play time** (`--agents delove-branch`, seat name "Delove Search"; "Search at play
time" below explains it). The newest base network in the models folder (`delove@N.onnx`, highest N) ranks the moves and
`--preset` picks the rest (`LIVE_BRANCH_PRESETS` in `src/branch-env.ts`):

| preset | rollouts | options | score | horizon | margin | evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `js2-range` (default since #164) | Jacob Sensei 2 | 5 | range (each stage's goal by players alive) | 2 | 0.02 | preset ladder (#164, below): **+2.33 points per seat at World 6p, +1.17 at Classic 4p, +0.12 at Classic 2p** against the bare delove@8; **+1.01 against `measured` head to head at World 6p** |
| `measured` | Jacob Sensei 1 | 5 | share | 1 | 0.01 | #142's CPU ladder: +2.07 / +1.43 / even; in the preset ladder +1.91 / +0.76 / -0.24 against the bare delove@8, about 4x faster per decision |

**The preset ladder** (#164; 2026-10-21, CPU, mirrored seeds, ranker delove@8 for all; 400 games at Classic 2p, 200 at
4p and World 6p; points difference per seat with 95% interval; C = `js2-range` with horizon 1 and margin 0.01):

| preset | vs bare delove@8, World 6p | Classic 4p | Classic 2p | ms per decision (busy CPU) |
| --- | --- | --- | --- | --- |
| `js2-range` | +2.33 (+1.97 to +2.69) | +1.17 (+0.89 to +1.44) | +0.12 (-0.07 to +0.31) | 184 |
| C | +2.11 (+1.84 to +2.38) | +1.09 (+0.77 to +1.41) | -0.07 (-0.34 to +0.19) | 100 |
| `measured` | +1.91 (+1.54 to +2.27) | +0.76 (+0.42 to +1.10) | -0.24 (-0.54 to +0.06) | 47 |

**Against delove@12** (2026-10-22, CPU, mirrored, 100 games each, no fog; docs/delove-fog.md "Controls"):
`js2-range` vs bare delove@12 is +0.17 (-0.28 to +0.61) at Classic 4p and +0.42 (-0.12 to +0.95) at World 6p.
That's still positive-leaning but no longer significant, so the search's edge shrank as the network got stronger.

Head to head, `js2-range` vs `measured`: World 6p +1.01 (+0.76 to +1.25), Classic 4p +0.41 (-0.01 to +0.83), Classic
2p +0.18 (-0.17 to +0.53). Most of the gain is Jacob Sensei 2 and the range score (C); horizon 2 adds a little more
at about twice the time, which the live tables can afford.

It prints its settings when it sits down. Any `DELOVE_BRANCH_*` variable overrides one setting
(`DELOVE_BRANCH_RANKER=delove@8` pins a network so a promotion doesn't change it mid-run); self-play and cycle runs keep
`branchFromEnv`'s own defaults. The bare network is its own id (`--agents delove@8`). Time per decision with delove@8
and the `js2-range` preset, measured on the training PC's CPU (2026-10-21, capitals and 8 blizzards, the other seats
Jacob Sensei 2): Classic 6 players 0.17 s mean, 0.35 s at the 90th percentile, 1.0 s at most, a whole turn 3.8 s mean,
16 s at most; World 10 players 0.56 s mean, 1.2 s p90, 1.7 s at most, a turn 9.9 s mean, 47 s at most (horizon 1 in
`measured` rolls out less). The server has no turn timer, so this only sets the pace spectators see.

`--pace 400` (ms between moves, so spectators can follow), `--names "A,B"`, `--options '{"capitals":true}'`,
`--no-start`. Fog of war: only a network trained for it (fog inputs, `"fogInputs"` in its `.json`, from
`train.py --fog-dropout`; "Fog of war" below) takes a fog seat; other versions sit fog games out.
`--agents` takes `delove-teacher@1`, every tuned teacher in the models folder (`delove-teacher@N.json`, e.g.
`delove-teacher@2`), and every `delove@N.onnx`. `sensei` / `sensei@1` and `sensei@2` are aliases for the two teachers,
and their seats are named "Sensei 1" and "Sensei 2" unless `--names` says otherwise (#88). `jacob-sensei@1` (alias `jacob`)
sits as "Jacob Sensei", `jacob-sensei@2` (alias `jacob2`) as "Jacob Sensei 2".

**Decision notes** (`src/notes.ts`; the server side is #206): every move a seat sends carries a short private
note on what Delove saw in it. It is kept on the game record's step and never shown during the game; the admin reads
it after the game ([docs/game-records.md](../../docs/game-records.md)). `--no-notes` turns them off. A note reports
only what the move already computed (no extra inference), stays under 2 KB (3 decimals, candidates cut first), and a
note that can't be built never stops the move. A search seat's option scores come from branch and score's own trace
(`DELOVE_BRANCH_TRACE`, which `delove-seat` points at a per-process temp file), so `branch.ts` is unchanged. A
process decides for its seats one at a time with no wait in between, so each note reads its own move's line (matched to
the game and seat too); the file is emptied after every move and deleted when the process exits.

```jsonc
// a search seat that compared options
{"agent":"delove@11 + search","model":"delove@11","preset":"js2-range","phase":"attack","alive":4,"fog":false,
 "top":[{"m":"att ontario>quebec","s":0.412,"r":6},{"m":"end","s":0.398,"r":6}],"chosen":0,"margin":0.02,"value":0.31}
// a network seat
{"agent":"delove@11","model":"delove@11","preset":null,"phase":"reinforce","alive":3,"fog":false,
 "top":[{"m":"pl ontario 3","p":0.62},{"m":"pl quebec 3","p":0.21},{"m":"pl alaska 3","p":0.05}],"value":0.44}
```

`top`: for a search seat, the options it tried (the teacher's move first) with their branch score `s` (the share of
the table it expects one round on, or its range score) and rollouts `r`, `chosen` the one played (it changes only by
more than `margin`); `br: 0` when it played its teacher's move without comparing (setup, or nothing worth comparing);
`fb: 1` under fog, where it plays its ranker's move (`top` then lists the ranker's favourites). For a network seat:
its 3 favourite moves with their probability `p`. `value`: the network's win chance for this seat. Teachers (Jacob
Sensei) send the header only. Moves read: `pl T n` place, `att A>B` attack, `occ n` move in, `ff A` / `ft B n`
fortify from / to, `cap T` capital, `trade`, `end`.

**Tournaments** (many Delove entrants, e.g. 20 Delove among 80 Zergs): `--tournament CODE --entrants N`.

```bash
npm run delove-seat -- --server https://risky.deanthoneeking.com --tournament ABC123 --entrants 20 --procs 6   --agents delove-branch --tokens runs/cup-tokens.json
```

- The runner joins N entrants while the tournament registers ("Delove 1" ... "Delove N", or `--names`; the agents of
  `--agents` in turn, each tagged for spectators as in a single game, e.g. "delove@10 + search"; give one id per
  entrant to choose each one's player, and `<model>+search`, e.g. `delove@10+search`, for search ranked by that model), then every entrant plays like an agent over MCP (`src/tournament-seat.ts`, `playEntrant`):
  wait for its table (the tournament long poll with its entrant token), play it with the seat player, wait for the
  next, until it is out or the tournament is over. The host starts the tournament as usual.
- **Processes:** a Node process makes one decision at a time (a search blocks it), so the entrants are spread over
  `--procs` child processes (default min(6, N)), each loading its models once. The decisions of one process wait on
  each other: keep entrants per process low enough for the turn timer. Each process logs its decision latency
  (p50 / p90 / max) and CPU use so far every minute (`DELOVE_SEAT_REPORT_MS`), and the end-of-run report sums them up.
- **Restarts:** every wait re-reads the tournament with the entrant token after a break (a server restart, a dropped
  connection), and each table re-attaches as the seat player does; a move refused because the state moved on (a turn
  timer skip) is dropped and the seat acts on the fresh state. `--tokens FILE` keeps the entrant tokens, so a runner
  restarted with the same FILE plays on instead of joining again.
- **Fog tables:** as any seat: a fog-trained network (or `delove-branch` with a fog-trained ranker, which plays the
  ranker's move without searching) plays them; other versions sit them out.

The seat rebuilds the board from its view (`stateFromView`): each opponent's hand gets its real size (`cardCount`),
the deck and discard theirs, dealt at random from the cards the seat can't see. Before #143 the rebuilt board gave
every opponent an empty hand, so the network and Jacob Sensei read every opponent's card count as 0 in live games
(training saw the real counts).

**Search at play time** (`--agents delove-branch`, seat name "Delove Search"): the seat plays branch and score
(`src/branch.ts`, the same player that makes the training data) instead of the bare network: at each important
decision it tries the network's favourites on copies of the board and keeps the best. It is configured by the same
`DELOVE_BRANCH_*` variables as self-play (`src/branch-env.ts`). The default is `js2-range` (the preset ladder above);
`measured`, #142's setup (the cycle settings with more options, #141), is about 4x faster:

```bash
npm run delove-seat -- --server https://risky.deanthoneeking.com --join ABC123                       # js2-range
npm run delove-seat -- --server https://risky.deanthoneeking.com --join ABC123 --preset measured     # faster
```

Every strong game AI searches when it plays (AlphaGo, Pluribus, Cicero); in Delove's own cycles the branch player
wins several times its seat share at the big tables where the network it trains still trails Jacob Sensei. It
thinks for longer per move (rollouts on the CPU), which matters little at tables with language-model seats.
Measured on the CPU ladder (#142; ranker delove@6, Jacob rollouts, 5 options, mirrored seeds): against the bare
delove@6, **+2.07 points per seat at World 6p** (95% +1.77 to +2.38; score 0.858), **+1.43 at Classic 4p** (+0.95 to
+1.91; 0.740), even at Classic 2p (0.490, -0.06 points); against Jacob Sensei at World 6p +1.81 (+1.53 to +2.09; 0.830),
where the bare network scores -0.75. About 65 s per World 6-player game for the whole table.

### Seat pool: Delove seats on request (`npm run delove-pool`)

A tournament host can ask for Delove seats when creating a tournament (`delove: N`; docs/tournaments.md "Delove seats
on request"). The **seat pool** is the daemon that fills them, on the machine that hosts Delove (`src/pool.ts`,
`src/pool-cli.ts`; never loaded by the server):

```bash
RISK_SEAT_POOL_KEY=<from the server owner> DELOVE_MODELS=~/delove-models   npm run delove-pool -- --server http://localhost:8080 [--max-seats 40] [--max-search 20] [--procs 6]
```

**For the daily tournament's house roster, run it with `--max-seats 100`.** The server puts no cap on roster seats
(owner, 2026-10-22), so the pool's own limit is the only one: a full roster is 100 seats. The Lord of resources checks
that the machine (the mini) can carry it; with a lower limit the roster seats it cannot fill go to Zergs.

- **Its loop**, every 30 s (`--poll-ms`):
  - it reports its free capacity to the server: `GET /api/seat-requests?kind=delove&free=F&freeSearch=S`, where
    `free` is `--max-seats` (`MAX_SEATS`, default 40) minus the seats in play, and `freeSearch` is `--max-search`
    (`MAX_SEARCH`, default 20) minus the search seats in play. The server shows "Delove: K seats available" to
    hosts, and "pool offline" after 2 minutes without a poll;
  - it claims what fits (`POST /api/seat-requests/:id/claim`);
  - it joins each seat with the request id ("Delove 1", "Delove 2", ... with the label `delove@N`);
  - it reports `done`, or `failed` with the seats it could not join, which go back to the request;
  - it plays the seats on child processes, as `delove-seat --tournament` does.
- **Which network:**
  - every seat is the newest `delove@N` in `DELOVE_MODELS` (or `--model`), bare;
  - where a claim allows search (fog off, within the server's cap of search seats at once) and `--max-search` has
    room, those seats play `delove@N + search` (the live preset, `--preset`);
  - **fog:** a fog request is always bare, and only a fog-trained network (its `.json` has `fogInputs`) takes one. A
    pool on a fog-blind network leaves fog requests alone, and never seats an older model in a fog game.
- **Takeovers** (docs/tournaments.md "Disconnected seats"): the pool polls with `modes=takeover`, so it also sees the
  takeover requests the server opens when it drops a disconnected tournament seat. For one of those it:
  - claims it (`n: 1`), and gets back the seat's `gameId`, `playerId` and a fresh seat token; the server has renamed
    the seat "<name>-Delove";
  - checks that the token plays the seat (`GET /api/games/:id` with it), then reports `done` (`{joined: 1}`), or
    `failed` with a reason, and the server's Zerg stand-in ("<name>-Zerg") keeps the seat;
  - plays that one game seat through the ordinary game API to the end of the table (`src/pool-play.ts`; a stand-in
    never moves on in the tournament). It takes one seat of `--max-seats`, and is bare under fog (the same fog rule as
    joins).

  If the pool goes silent on a seat it took, the server drops it like anyone, and the house bot finishes the table.
- **The key** (`RISK_SEAT_POOL_KEY`, the same value as the server's) is read from the environment only and sent in
  the `x-seat-pool-key` header. It is never printed or saved. A server without it answers 404 (the pool logs that
  seat requests are off); a wrong key gets 403, and repeated wrong keys get the server's one-hour lockout.
- **Robustness:**
  - seats in play are kept in a state file (`--state`, default `~/.delove-pool/state.json`, mode 600: it holds entrant
    tokens), so a restarted pool plays them on;
  - a child process that dies is replaced, and its seats are handed to the new one;
  - each seat re-reads its tournament after a server restart, as `delove-seat` does;
  - SIGTERM or Ctrl-C stops claiming and stops the children, and the seats stay in the state file for the next run.
- **House roster**: a claim may hand the pool the server's roster entries for its first seats. Each joins by its
  roster id and plays its own model. Details are under "House roster" below.
- **Running it as a service on the owner's Mac mini:** the runbook in the notes folder
  (`mac-mini-delove-seats.md`, "Seat pool as a service"): a launchd agent that restarts it, with the key in the
  agent's environment.

### House roster: the daily tournament's named Deloves

The daily tournament seats the **house roster**: up to 100 named players, some simple and some funny. Each name plays
one Delove version, for good. The roster lives on the **server** (game dev's house roster: an admin-only store under
`RISK_DATA_DIR`, docs/tournaments.md "House roster"). Players and spectators see only the name and the label
"AI agent"; the model goes only into the game record and admin views.

- **Seating** (the pool needs no setting for it): a seat request can carry roster ids. Its claim answers
  `roster: [{rosterId, name, model}]` for its first seats. The pool joins each with `{seatRequestId, rosterId}` and
  no name or label (the server sets them), and plays that entry's model, bare, with no decision notes (a note names
  the model, the roster's secret). Seats past the roster entries are plain
  "Delove N" seats, as before. An entry whose model the pool cannot play is skipped, and the rest are seated: the
  model isn't in `DELOVE_MODELS`, or it is fog-blind at a fog table (the roster holds only fog-trained versions, but
  the pool checks). The claim is then reported `failed`, which gives that entry back to the server. It comes first
  again on the next claim, and is skipped again, until its model is copied in or the admin retires it. The pool logs
  that once per model.
- **Versions come and go on the server** (admin routes): new names for a model, and retiring a version's names. The
  pool only reads, so keep every active roster model in the pool's `DELOVE_MODELS`.
- **The weekly per-version yardstick** (`npm run delove:roster-yardstick`; `src/roster-yardstick.ts`):

      RISK_RECORDS_KEY=... RISK_SEAT_POOL_KEY=... npm run delove:roster-yardstick -- weekly --server <url> --data <private dir> [--anchor delove@12]

  - `collect` reads the tournament tables the roster played from `GET /api/history`, which lists only the newest 100,
    so run it every few hours. It reads each table's game record with the records key: places, kills, who eliminated
    whom, and each roster seat's model (`record.room.roster`). It keeps a short summary line in
    `<data>/tables.jsonl`. The pool key reads the roster list (`GET /api/roster`), which names the roster seats and
    their models for a table without a record (kept from the history alone: places, no kills).
  - `report` writes `yardstick-<date>.json` and `.md` over the last `--days` (7). Per version and per name it gives
    tables, table wins, placement (0 first, 1 last), points per table (placement points plus kills), kills, rounds
    reached, who eliminated it (by version, `zerg`, `bot` or `other`), and the same split by fog, table size and map.
    A Plackett-Luce rating per version (the anchor `delove@12` at 0) comes from every table's finishing order.
  - The keys come only from the environment and are never printed or saved. The output folder is private (on the
    host, never in git).
- **On the Mac mini:** the pool's launchd service seats the roster with no extra flag, and a weekly launchd job runs
  the yardstick (with `collect` every 6 hours). See the runbook in the notes folder (`mac-mini-delove-seats.md`, "House
  roster").

### Generation 5 Testing & Environment Parity

To evaluate Delove models on the exact game options used in Generation 5 live league play, see [`docs/game-settings.md`](../../docs/game-settings.md) and pre-built configs in `packages/delove/configs/`:

- `packages/delove/configs/gen5-nofog.json` (baseline Gen 5 options with `fogOfWar: false`)
- `packages/delove/configs/gen5-randomfog.json` (standard league options with `fogOfWar: true`)
- `packages/delove/configs/gen5-fixedcards.json` (options with fixed card trade values)

### Fog of war (first capability: the seat view and fog dropout)

The plan and what is built: [docs/delove-fog.md](../../docs/delove-fog.md). In short:

```bash
# fine-tune the best model for fog: 30% of the decisions shown as their seat would see them under fog (any full-board data)
.venv/Scripts/python packages/delove/python/train.py --init <models>/delove@8.pt --fog-dropout 0.3 --out <models>/c15-fog   --data <data>/c9-a1/classic --data "<data>/c9-a4/world#0.5" ... --value-target points --amp
.venv/Scripts/python packages/delove/python/export_onnx.py <models>/c15-fog
# the fog gate: league fog settings, every seat on its own view (CPU ladder)
npm run delove -- ladder --candidate c15-fog --best delove@8 --players 6 --games 200 --options "$(cat packages/delove/configs/gen5-randomfog.json)"
```

- `--fog-dropout P` adds the fog inputs (`fog.py`, the same as `packages/selfplay/src/fog.ts`) and fogs each decision
  with probability P. A model from before fog is widened with zero weights and starts as the same player. The `.json`
  records `fogInputs: 1`, which the network player reads; validation prints a `fog` line (the same decisions, all fogged).
- In a fog game every seat decides on its view (self-play's `foggedAgent`, the live seat's `stateFromView`), so
  gates are fair: a fogged Jacob Sensei, a fogged `delove@N` (the seat view without the two fog columns).
- In a cycle config, a fog gate is a gate line with the fog settings, e.g.
  `"delove@8 6 200 {\"fogOfWar\":true,\"autoSetup\":true,...}"`; it plays on the CPU even with `gpu_gates`.
  `train_args` takes `--fog-dropout` like any other option.
- `train.py --soft-targets` with a pre-fog prior widens the prior the same way.
- The search seat (`delove-branch`) does not search under fog by default: in a fog game it plays its ranker's top move
  on the seat view. `DELOVE_BRANCH_FOG=determinize` (or the self-play seat `delove-branch@1:fog`; `DELOVE_FOG_MODEL=<id or
  .onnx path>` adds the learned fog guesser, `python/fog_guess.py`) searches fog games on
  boards sampled from the seat's view and memory (`src/fog-sampler.ts`); measured worse than the bare ranker at 2-6
  players, so it stays off ([docs/delove-fog.md](../../docs/delove-fog.md), "fog search"). `delove-seat` `delove-seat` gives it a fog seat only when the ranker has fog inputs
  (`DELOVE_BRANCH_RANKER=<fog-trained model>`).

### Delove at a mega table

The network has 10 seat slots (`MAX_SLOTS` in the encoder). At a bigger table (the 100-seat mega tournament on Mega
Earth, [docs/tournaments.md](../../docs/tournaments.md#tournament-styles)) every decision sees a **focused view**
(`src/focus.ts`, owner's call 2026-10-28: play now, a retrain may come later): the decider and its 9 most relevant
opponents (most armies on territories bordering the decider's, then most territories), everyone else's land read as
neutral with its armies, and the turn order holding only those seats. The engine still plays the real game; the
candidates are the real moves. The net scorer and the search seat use it; at 10 seats or fewer nothing changes. Play
quality at 100 seats is unmeasured. The pool on the Mac mini runs this code after its restart.

## Train a version (Stage 1: learn from the teacher)

One-time Python setup (Windows, from the repo root; `.venv/` is ignored):

```bash
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv/Scripts/python -m pip install -r packages/delove/python/requirements.txt
```

Then, with `runs/`, `data/` and `models/` all ignored by git:

```bash
# 1. 20,000 teacher games over 20 processes (about 1 minute)
for i in $(seq 0 19); do npm run delove -- play --agents delove-teacher@1,delove-teacher@1 --games 1000   --start $((i*1000)) --seed 101 --log runs/delove/teacher-01/p$i & done; wait
# 2. training arrays (about 4 minutes, 33 GB for 5.8M decisions)
npm run delove -- export --log $(ls -d runs/delove/teacher-01/p* | sort -V | paste -sd,) --out data/delove/teacher-01
# 3. train on the GPU (about 11 minutes on an RTX 4060), then export for Node
cd packages/delove/python
../../../.venv/Scripts/python train.py --data ../../../data/delove/teacher-01/classic --out ../../../models/delove/delove@1 --epochs 2
../../../.venv/Scripts/python export_onnx.py ../../../models/delove/delove@1
cd ../../.. && npm run delove -- ladder --best delove-teacher@1 --candidate delove@1 --games 400
```

`train.py` writes `<out>.pt` (weights), `<out>.json` (settings and validation history) and the log; `--init` starts
from an earlier version's weights. The network (`python/delove_model.py`) is a graph network over the map: the
adjacency is an input, so one model plays every map. It scores each candidate (policy) and predicts the win chance
(value). In Node it runs through `onnxruntime-node` in a worker thread (`src/net-worker.ts`), since self-play agents
answer synchronously.

## Players

| id | what | status |
| --- | --- | --- |
| `delove-teacher@1` | hand-coded teacher (`src/teacher.ts`), Stage 0: Delove's first version learns from it | done |
| `delove@1` | network distilled from the teacher (Stage 1), loaded from `models/delove/` (ignored by git) | done |
| `delove@2` | distilled from the tuned teacher delove-teacher@2 (round 5) | done |
| `delove@3` | fresh hidden-192 / 6-round network on branch-and-score decisions (cycle 4, `CYCLES.md`): 0.541 / 0.600 / 0.610 against delove@2 at 2 / 4 / 6 players | done |
| `delove@4` … `delove@13` | the same network fine-tuned each cycle (cycles 6, 8-16; `docs/delove-status.md` section 3); `delove@13`, trained with fog dropout: +0.17 leaderboard points per seat over `delove@12` with fog on at 4-8 players | `delove@13` current best (private models repo) |
| `jacob-sensei@1` | Jacob Sensei: hand-coded teacher for big tables (`src/jacob.ts`, below); never stalls in self-play, even with Sensei 2 at 2 players, far ahead at 4-10 | rollout teacher since cycle 6 |
| `jacob-sensei@2` | Jacob Sensei 2 (`src/jacob.ts`, below): Jacob plus RISK_LEARNINGS.md sections 7-21, with its own duel numbers; vs `jacob-sensei@1` 0.53-0.57 at 2p and +0.4 to +1.3 points per seat at 4-10p | candidate rollout teacher (cycle 12) |

`delove-teacher@1` picks only from the self-play candidates (never off-list), so every decision is a clean training
label, and it is deterministic from the seed. Against `risky@1` (`--seed 3`):

| setup | games | score | Elo |
| --- | --- | --- | --- |
| Classic, 2 players | 400 | 0.94 | +478 |
| Classic, 2 players, fixed cards | 200 | 0.95 | +512 |
| World, 2 players | 200 | 0.955 | +531 |
| Classic, 4 players | 200 | 0.83 | +275 |
| Classic, 4 players, capitals | 200 | 0.805 | +246 |
| World, 6 players | 200 | 0.835 | +282 |

(With 4 or 6 players the score is the share of games won by either of a version's seats; 0.5 is even.)

How it plays: pick a continent to take and stack everything on the territory that attacks into it; defend held
continents' borders against real players (the Neutral never attacks); attack when the battle odds and the payoff
(a card, completing or breaking a continent, an elimination, a capital) beat the expected losses, counting the
armies the defender loses too; move armies forward after a conquest; fortify idle interior stacks toward the most
threatened border.

`delove@1` (808k parameters, 2 epochs on 5.8M decisions from 20,000 Classic 2-player teacher games; it picks the
teacher's move 77% of the time on held-out games), `--seed 5`:

| opponent | setup | games | score | Elo |
| --- | --- | --- | --- | --- |
| `risky@1` | Classic, 2 players | 400 | 0.95 | +512 |
| `risky@1` | World, 2 players | 200 | 0.98 | +676 |
| `risky@1` | Classic, 4 players | 200 | 0.75 | +191 |
| `delove-teacher@1` | Classic, 2 players | 400 | 0.525 | (even: it learned the teacher) |
| `delove-teacher@1` | World, 2 players | 200 | 0.605 | +74 (a map it never trained on) |
| `delove-teacher@1` | Classic, 4 players | 200 | 0.415 | (trained on 2-player games only) |

## Range specialists: Delove Long, Mid and Close Range

The owner's plan for a stronger player in real games: three **separate** networks that take turns within one game,
picked by how many players are still alive, next to the base model `delove@N`. They are never merged into one
network; each line keeps improving on its own. Each is fine-tuned from the best general model on the positions of its
range.

| specialist | plays when | aims for |
| --- | --- | --- |
| **Delove Long Range** (`delove-long-range@N`) | 4 or more players alive | reach the last 3 with the most kills: the most leaderboard points |
| **Delove Mid Range** (`delove-mid-range@N`) | 3 alive | finish top 2, by making someone else the obvious target |
| **Delove Close Range** (`delove-close-range@N`) | 2 alive | win the duel |

Library names (the private models repo, next to `delove@N`) are `delove-long-range@N`, `delove-mid-range@N` and
`delove-close-range@N`; the shorter `delove-long@N` / `delove-mid@N` / `delove-close@N` from #114 still load.

- **Training:** `train.py --alive LO-HI` keeps only decisions with LO..HI players alive (counted from the
  `slot<i>_alive` features of each dataset), e.g. `--alive 4-10 --init <best>.pt --out .../delove-long@1`, then
  `3-3` (mid) and `2-2` (close). In cycle 5's data, Classic 4p has 92k / 203k / 355k decisions for close / mid / long,
  World's big tables 90k / 320k / 709k, Classic 2p 1.5M close.
- **Each its own objective** (`train.py --range long|mid|close`, `python/targets.py`): cycle 7 split the same lessons
  by players alive and came out even, so each specialist now learns its own target from the same pool of games:

  | `--range` | `--alive` | value target | policy |
  | --- | --- | --- | --- |
  | `long` | 4-10 | `points`: leaderboard points (placement + kills) scaled 0..1, the owner's "reach the last 3 with as many kills as possible" | range credit on points |
  | `mid` | 3-3 | `top2`: finished 1st or 2nd, mixed 70/30 with the **threat credit** (`--threat-credit 0.3`) | range credit on top2 + threat |
  | `close` | 2-2 | `win`: a sole win (a turn-limit share is no win) | range credit on win |

  *Range credit* (`--credit-beta 0.5`): each copied move is weighted by `exp((target - V) / beta)`, V the network's own
  value of the position (no gradient), so a specialist copies most the moves that went better than expected *for its
  objective*; the first `--credit-warmup` (500) steps copy evenly while the value head learns the new target. The
  same branch-and-score labels then teach three different lessons. *Threat credit* (Mid Range): at a 3-alive decision,
  the share of the strongest rival's border armies (largest army + territory share) that face the third player
  rather than us, measured at the seat's next decision (1 if a rival fell meanwhile, the final top 2 at the seat's
  last decision), read from the encoded positions. Every preset value can be overridden (`--value-target`,
  `--threat-credit`, `--credit-beta 0` for no credit). A turn-limit game is last place / no top 2 / no win.
  `top2` reads `placement.npy` (written by `delove_gpu.generate` since this change, with `kills.npy`; `export.ts`
  does not write it yet, as that file is in the GPU fingerprint). Older exports estimate a loser's place as the
  players alive at its seat's last recorded decision (see `targets.py`; `train.py` prints which datasets estimate).
  **Which `--init`:** a specialist line improves on itself. The first of each line starts from the base
  (`--init delove@6.pt`); every later one starts from the current best of its own line
  (`--init delove-mid-range@N.pt`), never from a newer base (docs/delove-status.md section 3, "Each specialist is
  its own line"). The data is the newest shared pool.
  Example: `train.py --range mid --data <pool...> --init delove-mid-range@N.pt --out .../cN-mid --epochs 1.5 --batch 512 --lr 2e-4
  --amp --branch-weights 0.5,1,2`. Checks: `python packages/delove/python/test_targets.py`. Cycle 7's script takes
  `RANGE_OBJECTIVES=1` (with `PREFIX`, `ROUTER`, `BASE`) to retrain its trio on its own games with these objectives,
  a direct A/B against cycle 7 with no new games.
- **Each its own teacher** (range scores in branch and score, `src/branch.ts`): the range objectives above only
  reweight the same labels, which moved about 3% of top moves. So the branch player that makes the labels can now
  score its rollouts by each range's objective (`DELOVE_BRANCH_SCORE` / `delove_gpu.generate --score`):

  | score | used at | a rollout's end position is worth |
  | --- | --- | --- |
  | `long` | 4+ alive | the share score plus `killWeight` (2) × the kill credit (`KILL_POINTS` per knock-out over the placement spread) |
  | `mid` | 3 alive | 0.7 × P(top 2) + 0.3 × threat deflection (`threat`). P(top 2) = 1 − P(both rivals finish above), each rival's chance read off the share-score gap as `points` does; the deflection is `targets.py`'s threat credit, measured on the rollout's end board. A rival out: 1; the decider out: 0 |
  | `close` | 2 alive | the share score (in a duel, the decider's share of the board), searched deeper: `closeRollouts` (12) copies of `closeHorizon` (2) rounds instead of 6 × 1 |
  | `range` | any | per decision by players alive: `long` / `mid` / `close` |

  **Per job:** a seat `delove-branch@1:<score>` (any score above, or `share` / `points` / `kills`) keeps its own score
  on the CPU (`register.ts`) and the GPU (`generate.py`), so a stage jobs file (#137's `mid.jobs` / `close.jobs`) can
  seat `delove-branch@1:range` while other tables keep the run's `--score`. Export those seats by their id
  (`--export-agents` / `--only-agents delove-branch@1:range`, cycle.sh `export_agents`). A whole run takes
  `--score range` (or `DELOVE_BRANCH_SCORE=range` for cycle.sh). Knobs: `DELOVE_BRANCH_KILL_WEIGHT`, `_THREAT`,
  `_CLOSE_ROLLOUTS`, `_CLOSE_HORIZON` (`--kill-weight`, `--threat`, `--close-rollouts`, `--close-horizon` on the GPU).
  The default stays `share`, so earlier cycles and the golden lock are unchanged. Results: below, "Range scores vs
  the share score".
- **Playing them as one player:** `models/delove/delove-range@N.json` holds the routes,
  `{"close": "delove-close-range@1", "mid": "delove-mid-range@1", "long": "delove-long-range@1"}`. The loader then registers
  `delove-range@N`, which plays each decision with the network for the players still alive (`rangeOf`), each network's
  top move. Specialists named `delove-long@N` / `delove-mid@N` / `delove-close@N` (or a cycle's `cN-long` / `cN-mid` /
  `cN-close`) are also players on their own. A route to a missing model skips the router rather than failing games.
- **Stage games (their own lessons).** Cycle 7 showed a split of the same games teaches the specialists little new.
  `scripts/stage/mid.jobs` (3 alive) and `scripts/stage/close.jobs` (the 1v1 left at the end of a multiplayer game)
  are tables whose agents read `LEAD>STAGE`: Jacob Sensei (with `delove@6` seats at every other table) plays a
  league-settings game on the cycle 8 maps and table sizes until the stage's players are left, then the branch player
  and its opponents take the survivors' seats and only that part is recorded. `pos:FILE>X,Y` plays instead from
  positions captured from game records (`npm run selfplay -- positions`). They run like any jobs file: on the GPU
  (`packages/delove-gpu` README, "Stage games"), as a `cycle.sh` step, or on the CPU with `scripts/generate.sh`; train
  with `--alive 3-3` / `--alive 2-2` as above.
  **In a cycle** they are two more steps of the cycle config, on rented GPUs like the rest (`REMOTE_GPUS=N`; lead-in
  tables ship to the pods as they are, `pos:` tables play at home only):

  ```bash
  steps=(... "sm packages/delove/scripts/stage/mid.jobs Stage games: 3 alive"
             "sc packages/delove/scripts/stage/close.jobs Stage games: 2 alive")
  train_data=(... sm/classic sm/world sm/europe ... "sc/classic#0.5" ...)   # one folder per map, as any step
  ```

  `remote.py plan --step sm=packages/delove/scripts/stage/mid.jobs --step sc=packages/delove/scripts/stage/close.jobs --pods 10`
  prices both at about 48 minutes and $7 with its full-game guesses; measured stage games cost a third or less of
  that (home 4060: about 25k 3-alive and 39k 2-alive games an hour). A 3-alive game goes on to its 2-alive end, so
  `sm` folders hold decisions at 3 and at 2 players alive; `sc` folders only at 2. Every row is an ordinary training row,
  so the folders mix into the pool like any step's (`train.py --alive` / `--range` pick the specialist's rows; for base
  Delove, weight them with `#F` so the endgame does not crowd out the opening).
- **Ratio scenarios (closer stages).** After a Jacob lead-in one player has usually run away (median stage 7 turns
  at 3 alive, 4 at 2), so `scripts/stage/split-close.jobs` (2 alive: 50/50, 60/40, 40/60, 70/30, 30/70) and
  `split-mid.jobs` (3 alive: 34/33/33 and each turn order of 50/25/25, 40/40/20, 60/20/20) start from synthetic boards
  split as the ratio says, about 10,000 games a ratio over the 6-10 seat tables of cycle 8, the branch player against
  `delove@6` (`split:SHARES>...` agents; packages/selfplay README, "Stage games"). They are drawn from each game's
  seed, so they run on rented GPUs as well as at home: two more cycle steps, e.g. `"xc
  packages/delove/scripts/stage/split-close.jobs Ratio scenarios: 2 alive"` and `"xm .../split-mid.jobs Ratio
  scenarios: 3 alive"` (about $2-3 for both on rented GPUs; the measured balance per ratio is in the `packages/delove-gpu`
  README, "Stage games"). Mix them with the real stage games and the normal pool, never alone (`#F` weights in
  `train_data`, e.g. `xc/classic#0.5`; 70/30 is mostly settled on the first turn). `node
  scripts/stage/split-jobs.mjs [GAMES] [OPPONENT]` rewrites both files (e.g. `10000 delove@7` for the newer base); `scripts/stage/measure-stages.mjs` re-measures the
  stage statistics the boards are drawn from.
- **Gate:** each specialist against the base on its own stage, then the routed trio against the base in full games,
  with the yardstick below; the promotion rule is in `docs/delove-status.md` ("Range specialists: how they are
  compared").
### The yardstick: specialist vs base on its own stage (`npm run delove:stages`)

```bash
npm run delove:stages -- --stage close --candidate delove-close-range@1 --base delove@5             # 400 positions, 800 games
npm run delove:stages -- --stage mid   --candidate delove-mid-range@1   --base delove@5             # 300 positions
npm run delove:stages -- --stage long  --candidate delove-long-range@1  --base delove@5             # 200 positions
npm run delove:stages -- --stage full  --trio delove-long-range@1,delove-mid-range@1,delove-close-range@1 --base delove@5
```

(`src/stages.ts` over `src/stage-eval.ts`; add `--workers N`, default 6. Games run in `playStageGame`, self-play's
game loop plus a start position and a stop test; it lives here rather than in `packages/selfplay/src/game.ts` because
that file is in the GPU mirror's fingerprint, and it is tested to play the same games as `playGame`.) How it works:

- **Fixed start positions per stage**, generated deterministically from `--seed` (default 1), the tables and the
  settings: position *i* is on table *i* mod the stage's tables, reached by **Jacob Sensei in every seat**
  (`--capture`, never one of the models being compared) and captured at the first turn start that fits the stage:

  | stage | captured at | default tables | positions | decides on | also reported |
  | --- | --- | --- | --- | --- | --- |
  | `long` | turn 1 (every seat alive) | Classic 6, World 6, Asia 8, World 10 | 200 | mean leaderboard points per seat | P(top 3) |
  | `mid` | first turn with exactly 3 alive, weakest holding ≥ 12% of the armies | Classic 4, World 4, Classic 5, World 6 | 300 | P(finish top 2) | points |
  | `close` | first turn with exactly 2 alive, weaker holding ≥ 20% (fresh duels on 2-player tables) | Classic 2, Classic 4, World 4, World 5 | 400 (800 games) | win rate | points |
  | `full` | the deal (whole games) | Classic 2, 4, 6, World 6, 10 | 200 | mean leaderboard points per seat | win share |

  The balance floor keeps the set from being mostly decided games; a capture that skips the stage (two players out
  in one turn), fails the floor or hits the turn limit moves on to the next seed. `--tables`, `--positions` and
  `--options` (a JSON string or file such as `configs/gen5-nofog.json`; fog is refused: positions are captured on the full board) change the set; keep them the
  same across comparisons. `--save-positions FILE` writes the set (a few MB, local only, not for git) and
  `--load-positions FILE` replays exactly that set.
- **Mirrored pairs:** every position is played twice, the candidate on alternate alive seats and then on the others,
  with the same seed (dice and deck come from the position, so both games roll the same dice). The candidate's seats
  play the **specialist only while the game is in its stage** and the base after it (`stagedAgent`), so a stage's
  number measures that stage's network; `full` plays the routed trio (`--trio LONG,MID,CLOSE`, any ids, routed by
  `routedAgent`) or any single `--candidate` (e.g. `delove-range@N`) throughout.
- **Output:** a JSON line on stdout and a table on stderr, per table and pooled: the candidate's and the base's
  metric, their **difference with a 95% interval over positions** (a position's pair is one unit), turn-limit games,
  how many positions were *decided* (both games placed every seat the same, so the seats decided them, not the
  players) and a verdict (`better` / `worse` when the difference's interval clears 0, else `even`).
- **Speed** (CPU, 12 workers, `delove@4` vs `delove@5`, 48 positions each): close 36 s, mid 56 s, long 80 s, full
  112 s (40 positions). A full 800-game close call takes about 5 minutes.

Smoke run, `delove@4` (candidate, in every stage) against `delove@5` (base), 48 positions per stage (40 for
`full`), seed 1, default settings, 2026-10-20: every stage `even`, as expected of two close versions
(close win 0.531 vs 0.469, diff +0.06, 95% -0.03 to +0.15, 43 of 48 decided; mid top 2 0.667 vs 0.653, diff +0.01,
-0.10 to +0.13; long points 0.71 vs 0.93, diff -0.21, -0.79 to +0.36; full points 0.30 vs 0.76, diff -0.46, -1.03 to
+0.11). Too small for a call: proof that the command works, not a result.

- Not on the GPU mirror yet: `delove_gpu.generate` / `ladder` would need a per-decision model choice by players alive in
  their network seats.

## The Zerg-horde gate (`npm run delove:horde`)

Can a seat survive being ganged up on? One candidate against 2-3 coordinated Zergs (`zerg@1`, the engine's
hand-coded horde bot, [docs/zergs.md](../../docs/zergs.md)), the other seats filled by `--filler` (default
`jacob-sensei@2`). With `--base`, both play the same games (same seed, table and seat layout) and the paired
difference decides:

```bash
npm run delove:horde -- --candidate delove@10 --base jacob-sensei@2 --games 100
npm run delove:horde -- --candidate delove@10 --tables classic:4:3,classic:6:3 --options '{"fogOfWar":true}'
```

- Tables are `map:players:zergs`; the default is `classic:3:2,classic:4:3,classic:4:2,classic:6:3,classic:6:2`. At a
  solo table (no fillers) the Zergs hunt only the candidate. Once it is out the weaker Zergs surrender to the strongest
  (`strongestZergOf`, #176), who wins (docs/zergs.md), so the gate measures the candidate's survival as the last round it made a decision
  in. `game` reports the whole games' length.
- `hold` (the default `--metric`): at a solo table, 1 for a win, else rounds survived / 30 (capped at 0.99); with
  fillers, the candidate's place among the non-Zerg seats (1 = best, 0 = first out). Also reported: `win`, `place`,
  `rounds`, `kills` and `points` (leaderboard points, Zerg seats ranked like any seat for now). With `--base` every
  metric gets a paired 95% interval; the verdict is on `--metric`. Seeds are fixed by `--seed` (default 1), so keep
  the default to compare successive Delove versions on the same games.
- `--zerg` picks the horde. The default is `zerg@1`, the fixed reference opponent, so earlier gates stay comparable.
  `zerg@2` is the live seats' version (no mid-game surrender, walled-in Zergs mass toward the prey; #198), which
  training uses since #201. `zerg-branch@1` is the searching Zerg. A recheck against the live horde:
  `npm run delove:horde -- --candidate <model> --zerg zerg@2 --games 100 --procs 14` (add `--base-zerg zerg@1` to
  compare the two hordes on the same games). First comparison (2026-10-22, delove@10, 100 games per table): hold
  even, +0.007 (-0.012 to +0.025), so the live horde is no harder to survive. Delove scores 0.48 fewer points a game
  against it, because with no mid-game surrender more Zergs outlast it. Turn limits: 12 of 100 games at 4p vs 3
  Zergs (3 under `zerg@1`).
  `--base-zerg` plays the same candidate against a second horde on the same games: a negative difference means the
  `--zerg` horde is the stronger one.
- Worker threads (`--procs`, default all cores but one): 1000 games in about 17 s for delove@10.
- First result (2026-10-21, 100 games per table): delove@10 vs jacob-sensei@2, pooled hold 0.477 vs 0.361, diff
  +0.115 (95% +0.081 to +0.150), better.
  - Re-run with the falling-out (#169): 0.459 vs 0.342, diff +0.118 (+0.083 to +0.152); win, place and kills are
    identical.
  - Solo-table hold reads lower (4p vs 3 Zergs: 0.186, was 0.233) because survival is now the candidate's last round,
    not the game's length. Compare only results from #169 on.
  - With the strongest-keeps-the-table ending and the walled-in sacrifice back on (#176): 0.459 vs 0.342, diff +0.118
    (+0.083 to +0.152), unchanged.
    - Games are shorter: 9.8 rounds, against 15.7 under #169's fight; Delove's own is 7.4.
    - Turn limits: 4 in 500 (3 at 4p vs 3 Zergs), against 10 with the sacrifice off.
  - Neither survives a solo rush often: delove@10 wins 0-1% of solo tables (Jacob 0%) and 5-18% of the tables with
    fillers.
- For scenarios or training data, the agents play in any self-play command:
  `npm run delove -- play --agents delove@10,zerg@2,zerg@2,zerg@2`. `scripts/cycles/horde.jobs` is a ready job file
  for `generate.sh` (about 4,000 games, the branch seat against 2-3 `zerg@2` with Jacob fillers, league settings; it
  seated `zerg@1` until #201); the captain adds it to a cycle. Under `zerg@2` (200-game sample, the cycle-13 branch
  env): about 3.4 process-seconds a game at 8 processes, so about 29 min for the 4,000 games on 8 processes (16-20 on
  14). 4 of the 200 games (2%) hit the 250-turn cap; a mean game is 32 turns. Rollouts play each Zerg seat with its own version
  (`zergParamsFor`). Its seat is `delove-branch@1:range-horde`: `delove-branch@1:range`
  whose rollouts play the Zerg seats with the horde bot (src/horde-branch.ts; a Zerg move off the candidate list falls
  back to the teacher's pick, never an attack on a fellow Zerg), so the search sees the gang-up coming. The plain
  branch seat imagines the Zergs as its teacher.
  - The file caps games at 250 turns (`#@max-turns 250`, read by `generate.sh`; `MAX_TURNS=N` overrides it, and files
    without the line keep the 500-turn default). A turtling seat can now and then stall the horde. In
    a 400-game check no finished game ran past 235 turns.
  - CPU time with the cycle-13 branch settings (`range-horde`, the cap, #176's ending with the sacrifice on): about
    5.1 process-seconds a game at 8 parallel processes (200 games in 258 s wall on the i7-14700F; mean game 29 turns).
    All 4,000 games take about 85 min on 8 processes, or roughly 30-40 min on 14.
  - Earlier rules measured 5.6-5.9 s. The game-length changes barely move the CPU: the turns they cut are cheap
    Zerg-only ones, after the branch seat is out.
  - The plain `range` seat took 1.3 s a game before the falling-out; `range-horde`'s rollouts play the horde bot,
    which costs more per move.

### The learned Zerg, stages 0-1 (`npm run delove:talk`)

The first steps of the learned Zerg (docs/zergs.md §7: chat and deduction, no shared secret, hidden roles):

- **Talking tables** (src/talk/game.ts): a self-play loop with table chat, separate from the GPU-mirrored game.ts.
  - Each seat has a hidden role (`zerg`, `impostor`, `plain`) and may say one message per turn from the v0
    vocabulary (src/talk/vocab.ts), public or whispered.
  - It sees only the messages it may see and the public battles.
  - The game ends by standing once only true Zergs are left (the owner's rule).
- **Scripted roles** (src/talk/roles.ts):
  - talking and quiet Zergs that act (zerg@2's policy) on a *belief* about who their allies are;
  - impostors: `claimer` talks like a Zerg and attacks anyone; the held-out `mimic` acts like a Zerg for 4 rounds,
    then betrays;
  - plain seats, some of them accusing whoever hit them.
- **The listener v0** (src/talk/listener.ts, features in src/talk/features.ts): logistic regression on what a seat said
  and how it fought (toward me, toward self-declared Zergs, toward others; totals and the last two rounds), trained on
  the true roles.
- **Training data:** iteration 0's Zergs act on the true allies (teacher forcing), so their behaviour is a real
  signal. Later iterations add games where they act on the previous listener (`--iterations`).

```bash
npm run delove:talk -- --train-games 600 --test-games 300 --play-games 300 --iterations 3 --out models/delove/listener@0.json
```

First results (2026-10-22, classic 4-5p, 2 Zergs, 300 games per arm, single process, a few minutes):

| belief the Zergs act on | horde wins | infighting | hits on the impostor | turn limits |
| --- | --- | --- | --- | --- |
| rule: "claimed and hasn't hit me or a claimer" | 76% | 23% | 38% | 0/300 |
| listener v0 (teacher forcing, 3 iterations) | 90% | 20% | 62% | 6/300 |
| second-order listener (stacked) | 86% | 19% | 47% | 4/300 |
| the true roles (upper bound) | 99% | 0% | 46% | 0/300 |

Recognition, Zerg vs the held-out `mimic` impostor (AUC; 0.5 = chance, gate ≥ 0.75 by round 5):

| scored on | rounds 1-2 | rounds 3-5 | round 6+ | all |
| --- | --- | --- | --- | --- |
| on-policy: games where the Zergs act on that listener | 0.63 | 0.83 | 0.94 | 0.87 |
| teacher-forced: games where the Zergs act on the true roles | 0.60 | 0.90 | 1.00 | 0.93 |
| second-order listener, on-policy | 0.57 | 0.72 | 0.90 | 0.78 |

- The listener v0 passes the recognition gate on-policy: 0.83 by rounds 3-5, 0.94 from round 6, against an impostor
  it never trained on. Rounds 1-2 can't be much better, since the mimic acts exactly like a Zerg until round 4.
- Score a listener on-policy (or teacher-forced), not on games where the Zergs act on the rule. There, a Zerg that
  rightly attacks a claiming impostor looks like a traitor to its fellow Zerg, the rule makes them fight each other
  (23% infighting), and true Zergs end up behaving like impostors: that test gave about 0.47 for every listener.
- The second-order listener (battles split by the first listener's belief) is no better, so the listener v0 stays
  the default.
- Still open: infighting is 20%, above the owner's 5-15% band. Next: the recurrent head, then the learned speaking
  head and the team-spirit reward (stage 2 on T4's league, #297).
- The model file stays local (hard rule 13).

### The searching Zerg (`zerg-branch@1`)

Branch and score for the horde (src/zerg-branch.ts): the Zerg's own move and up to 3 alternatives (never an attack on a
fellow Zerg) are each played on 8 copies of the board with common dice, 2 rounds forward, each Zerg seat playing its own
version (`zergParamsFor`: `zerg@2`'s numbers for a `zerg@2` seat, `zerg@1`'s otherwise; #201) and the prey modelled by Jacob Sensei 2, and scored for the horde: prey knocked out × kill weight + the horde's share of the
alive players' armies and income + `selfWeight` (default 0.5) × my standing (my share of the horde's strength; once
the prey is gone, 1 if I am the strongest Zerg). It is the teacher for a trained Zerg network (docs/zergs.md). Its
numbers come from `ZERG_BRANCH_OPTIONS`, `_ROLLOUTS`, `_HORIZON`, `_KILL_WEIGHT`, `_MARGIN` and `_SELF_WEIGHT`. A Zerg agent's id must start with `zerg`:
self-play seats named so are one horde.

First result (2026-10-21, delove@10 as the candidate, `--base-zerg zerg@1`, same games): **no gain yet**. Defaults
(4 options, 8 rollouts, horizon 2, kill weight 1) over the 5 default tables: Delove's hold diff +0.003 (95% -0.028 to
+0.035). Kill weight 3, 12 rollouts, horizon 3 on classic:4:2, 6:3 and 6:2: +0.006 (-0.051 to +0.062). Both are even
with the hand-coded Zerg, so the search is not yet a better teacher. Next: tune `zerg@1`'s numbers (a `zerg@3`) and
give the search a network's alternatives.

### Tuning the Zerg (`npm run delove:zerg-tune`)

`zerg@1`'s judgement numbers are `ZERG_1_PARAMS` in packages/engine/src/zerg.ts (attack odds per kind of target, the
knock-out bonus, the target rule's weights, occupation share, staging pull, the sacrifice switch, 1 in `zerg@1` since #176; it was 0 from #169 to #176). Four later
behaviours are terms that are 0 (off) in `ZERG_1_PARAMS`, so `zerg@1` plays exactly as recorded (a golden test guards it):

- `strikeRatio`: synchronised strike. The horde holds its attacks on the target until its border armies reach that
  multiple of the target's armies, then all Zergs hit it.
- `cardHoard` / `hoardFinish`: trade only when forced until the target is down to `hoardFinish` territories next to me,
  then cash in to finish it.
- `capitalBonus`: snipe prey capitals under Capital Conquest.
- `wallWeight`: don't stage reinforcements against big stacks.

The tuner can switch them on. The tuner climbs from
them with joint moves. Each generation makes `--children` candidates (default 8), each moving `--knobs` numbers at once
(default 3), and plays every child and the current best on the same fresh games against each `--prey` (default
delove@10) on the default horde tables. The best child goes to confirmation on `--confirm-games` fresh games per table
(default 80), and replaces the best when that 95% interval clears 0. Confirmation uses fresh games only, since the first
set picked the winner.

- Fitness `--fitness rush` (the default) is the horde's own goal per game: 1 if the prey was knocked out, up to +0.5
  for doing it fast (by 40 rounds), -1 at the turn limit. The gate reports it as `rush` too.
- `--fitness hold` (the prey's survival) saturates: a first run of 15 single-pair generations on it found nothing
  beyond ±0.02.
- `--knob-set new` moves only the later behaviours' knobs.
- Run 2 (2026-10-21, rush fitness, the 12 original numbers): 6 generations of 8 joint children, nothing confirmed. On
  fresh games every best child landed within ±0.04 of `zerg@1`, so re-tuning the existing numbers is at a ceiling and
  new behaviour is the lever (as Jacob Sensei 2's new terms were for Jacob).

```bash
npm run delove:zerg-tune -- --out models/delove/zerg-tune-run2.json --generations 15
```

The file holds the numbers and every generation's result; it stays on the training PC. Once the result passes a gate
(`npm run delove:horde -- --candidate delove@10 --zerg zerg@3 --base-zerg zerg@1`), copy it to `models/delove/zerg@3.json`:
register.ts loads `zerg@N.json` (N >= 3) as agent `zerg@N`. `zerg@1` (the reference horde) and `zerg@2` (the live
version) are fixed in the engine, and a file with their name is ignored.

## Jacob Sensei (`jacob-sensei@1`): a teacher that doesn't stall

Sensei 2 (`delove-teacher@2`) was tuned on 2- and 4-player Classic and stalls on big boards and big tables: with
progressive cards every seat ends up on thousands of armies and nobody attacks, because in a many-player game the
armies a fight costs mostly help the players who stay out of it (a stalled World 6-player game at turn 500: five
players on 2,800-7,100 armies each, sets worth 790, two conquests a turn, all card grabs). Jacob Sensei
(`src/jacob.ts`, named by the owner) keeps Sensei's judgement and adds terms from the LLM players' post-game notes
(`AI/general-player/risk-learnings.md`), each a tunable number. `teacher.ts` is unchanged, so `delove-teacher@1/@2`
and the GPU mirror are too.

| learning (risk-learnings.md) | heuristic | number(s) | ablation: switched off |
| --- | --- | --- | --- |
| go for the kill; hunt weak players for their cards; plan the whole kill run | a capture from a rival whose whole army is under the attacking stack / `huntRatio` earns `huntValue` x elimination worth / their territories (attacks and placement) | `huntRatio`, `huntValue` | **the big one**: 0.22-0.32 against full Jacob at 4-10 players, games 35-50% longer |
| late-game tactics; huge stacks must be used | every round past `lateRound` lowers the attack bar and own-loss weight (`lateRamp`) and the win chance needed (`lateWin`, floor `minWinFloor`) | `lateRound`, `lateRamp`, `lateWin`, `minWinFloor` | stall insurance: Greater Europe 10p self-play stalls 7 of 32 games without it |
| check the leader's income and territory count, not just your neighbours | a rival's armies and territories are worth more the further its power (armies + `powerIncome` x income + `powerCards` x cards x card value) is above the table mean | `leaderLoss`, `leaderCapture`, `powerIncome`, `powerCards` | neutral (within noise) |
| take at least one territory for the card | until the turn's first conquest the attack bar is lower by `cardUrge` | `cardUrge` | neutral |
| sitting on troops is the most common mistake | own losses count less the more a stack exceeds its border's threat, in turns of income | `stackRamp`, `stackFree` | neutral |
| never skip your fortify; move interior stacks onto a border | an interior stack is always fortified to the front, toward its best attack | `frontPull` | neutral |

Skipped: anything needing chat, diplomacy, fog of war or memory of earlier turns (retaking a loss, kill-guarding,
card-blocking). Ablations: 32 self-play games per big table and 200 mirrored games per table against full Jacob, on
the generation-4 numbers.

**Tuning.** `src/tune.ts --teacher jacob` from the untuned numbers (`DEFAULT_JACOB_PARAMS`: Sensei 2's 28 plus first
guesses), 30 generations of 8 mutants x 300 games, confirmed on 800 (2 accepted), on Classic 2p 0.3, World 2p 0.1,
Classic 4p 0.1, Asia 4p 0.1, World 6p 0.15, Fantasy 6p 0.1, Greater Europe 10p 0.15, 500-turn limit, `--stall 1`.
A first run without a length term accepted a version that wins mixed tables by sitting back and drags self-play
games to the edge of the limit (Greater Europe 10p 158 -> 442 turns). So `--selfplay greater_europe:10,world:6,fantasy:10,classic:4
--length 0.3` also plays each candidate against itself and charges (candidate - best) for turn-limit games and mean
length. The result is `JACOB_SENSEI_1_PARAMS`. Later versions: `models/delove/jacob-sensei@N.json` (N >= 3; @2 is fixed in the code) register
on their own. `src/tables.ts` runs these checks over many tables at once:

```bash
node --import ./packages/delove/dist/register.js packages/delove/dist/tables.js --agent jacob-sensei@1 \
  [--vs delove-teacher@2] --tables classic:2,world:6,greater_europe:10 --games 64 --workers 6
```

**Results** (2026-10-20, 500-turn limit). Self-play, every seat the same teacher (Sensei 2: 16 games per table;
Jacob: 64):

| table | Sensei 2 turn-limit | Jacob turn-limit | Jacob mean turns |
| --- | --- | --- | --- |
| Classic 2 / 4 / 6p | 0 / 12.5 / 31% | 0 / 0 / 0 | 19 / 50 / 53 |
| World 4 / 6 / 8 / 10p | 62 / 94 / 75 / 100% | 0 / 0 / 0 / 0 | 67 / 79 / 77 / 80 |
| Greater Europe 4 / 6 / 10p | 100 / 100 / 100% | 0 / 0 / 0 | 115 / 129 / 120 |
| Fantasy 6 / 10p | 94 / 100% | 0 / 0 | 83 / 81 |
| Asia 8p, USA 10p, Europe 8p | 44 / 44 / 25% | 0 / 0 / 0 | 58 / 57 / 54 |

Against Sensei 2, seats alternating, mirrored pairs (score = Jacob's share of wins, 0.5 even; points = mean
leaderboard points per seat, placement + kills, a turn-limit game scoring last place for everyone):

| table | games | Jacob score (95%) | Jacob points | Sensei 2 points | turn-limit |
| --- | --- | --- | --- | --- | --- |
| Classic 2p | 1,000 | 0.521 (0.499-0.543) | 0.56 | 0.44 | 0% |
| World 2p | 1,000 | 0.504 (0.482-0.526) | 0.51 | 0.49 | 0% |
| Classic 4p | 200 | 0.645 (0.587-0.703) | 1.11 | 0.39 | 0% |
| Asia 4p | 200 | 0.650 | 1.17 | 0.33 | 0% |
| World 4p | 200 | 0.698 | 1.22 | 0.14 | 2.5% |
| Greater Europe 4p | 200 | 0.638 | 0.50 | -0.34 | 24.5% |
| Classic 6p | 200 | 0.705 | 1.33 | 0.34 | 0% |
| World 6p | 200 | 0.735 | 1.12 | 0.09 | 6% |
| Fantasy 6p | 200 | 0.738 | 1.17 | -0.23 | 9.5% |
| World 10p | 200 | 0.808 | 1.23 | -0.20 | 6.5% |
| Fantasy 10p | 200 | 0.825 | 1.07 | -0.33 | 9% |
| USA 10p | 200 | 0.713 | 1.11 | 0.63 | 0.5% |
| Greater Europe 10p | 200 | 0.763 | -0.20 | -1.95 | 33.5% |

Bar (docs/delove-status.md, section 9 item 1): turn-limit games under ~2% at every table size: met in self-play (0 of
960), which is what rollouts play. No loss at 2 players against Sensei 2: met (1,000 games each on Classic and
World). Tables that keep Sensei 2 in half the seats still stall on the big boards (Greater Europe 25-34%), because
Jacob alone can't finish several turtling Sensei seats in 500 turns; as a cycle's rollout teacher Jacob plays every
seat, so those tables don't arise there, but steps that seat Sensei 2 as an opponent will keep stalling.

**Porting it to the GPU mirror** (`packages/delove-gpu/delove_gpu/teacher.py`, a later step): the same scoring as
Sensei plus per-player armies, territories, income (`reinforcementsFor`) and cards for the power and hunt terms (one
segment-sum over territories per position), the round for the late ramp, the conquest flag for the card urge, and the
interior-to-front fortify branch; then add `src/jacob.ts` to `RULE_FILES` and re-verify with `verify.py`.

## Jacob Sensei 2 (`jacob-sensei@2`): the later learnings, and a duel stage

`jacob-sensei@2` ("Jacob Sensei 2", alias `jacob2`) is Jacob Sensei plus the tips impL0 (Jacob) wrote after #98
(`RISK_LEARNINGS.md` sections 7-21 on the `feat/mechanics-learning` branch, read as game knowledge; that branch is not
merged). Each learning that can be computed from the board is one more tunable number in `src/jacob.ts`; all of them
are 0 in `JACOB_SENSEI_1_PARAMS`, so `jacob-sensei@1` plays exactly as before (`test/jacob2.test.ts` locks its choices).

| section | learning | term (number) | range it helps |
| --- | --- | --- | --- |
| 15, 21 | the 2v1 elimination EV: passing a 41.7% kill on a card holder is a blunder; victims on 2-3 territories with 3+ cards are urgent | an attack on a rival the capture eliminates, or one on 3 territories or fewer with 3+ cards, needs only `killWin` to win (not `minWin`) | Long (kills), Close (the last kill) |
| 21, findings | multi-hop kill paths: punch through a third party's 1-army buffer to reach a killable victim | a capture next to a killable rival the stack outweighs (`huntRatio` x their armies + the buffer) earns `killPath` x elimination worth / their territories (attacks and placement) | Long |
| 21 | carry the spearhead to the dying victim, never leave the stack behind | occupy with everything when the new territory borders a rival on `killCarry` territories or fewer | Long |
| 19, 17, 18 | runaway leader: punch through 1s to break its bonus; neighbour bonus denial | taking a 1-2 army territory of a rival above the table's mean power, on or next to a continent it holds, is worth `leaderPunch` x lead x that bonus | Long, Mid |
| 20, 10, 13 | defensive elimination and border consolidation: captures that shrink the border are defence too | a capture is worth `borderDelta` less per border territory it adds, more per border it closes | Long, Mid |
| 12 | don't open a caged stack | a capture next to a rival stack of 5+ that touches nothing of mine costs `dormantWake` x its armies (not for a kill, not in the duel) | Long, Mid |
| 7, 9, 10, 13 | situational attack termination: take and hold, outposts don't attack for nothing, no blitzkrieg chains | once the turn's card is earned at a table of 3+, an attack that completes, breaks, kills, takes a capital or lands in the target continent, hunts, or comes from a surplus stack keeps the usual bar; any other needs `holdEv` more | Long, Mid |
| 16 | high-card survival: with 4-5 cards, tighten | with 4+ cards a failed attack's exposure counts `1 + cardTight` times | Long, Mid |
| 7 (1v1) | scorched earth in the duel: every territory starves the rival | with one rival left a capture is worth `duelDeny` (a quarter unless it drops their base income) and the attack bar is `duelEv` lower | Close |
| 11 | garrison every capital you hold | a threatened capital I hold needs `capitalPad` more armies (defence need, placement, fortify) | all (capitals games) |

Already in Jacob Sensei 1 or Sensei, so no new term: trade-surge concentration (21: placement puts the whole draft on
one territory), fortify inside-out and doorway stacking (10, 17: `frontPull`, fortify toward threatened borders),
small tight bonuses first (8: `target()` weighs bonus per border), neighbour bonus breaks (18: `breakBonus`), dice-mode
safety (7: the odds use balanced blitz when it is on). Skipped: chat, deals and coalitions (6, 9, 18), fog deductions
(4, 16), capital choice by neighbour clash and pocket capitals (14: needs other players' capital plans), card-block
outposts (9: needs memory of earlier turns), frontier fortify balancing (moving part of a threatened border's stack:
the candidates move all or half and Sensei never fortifies from a threatened border, which section 17's doorway rule
backs), and the LLM-tool rules (`avoid`, `placeOn`, mid-turn re-plans: the teacher re-decides every step anyway).

**The duel stage.** Tuned for big tables, the new numbers lost at 2 players (0.471 Classic, 0.473 World against
`jacob-sensei@1`, 1,000 games each). So `jacob-sensei@2` is staged: `jacobPickWith(params, duel)` plays
`JACOB_SENSEI_2_PARAMS` while two or more rivals are alive and `JACOB_SENSEI_2_DUEL_PARAMS` once one is left (a
2-player game from the start, or the endgame duel of a bigger table; the Neutral does not count), like the Long/Close
Range split of the specialists. A `models/delove/jacob-sensei@N.json` (N >= 3) can do the same with a `"duel": {...}`
object.

**Tuning.** Main numbers: `src/tune.ts --teacher jacob --fitness points` from `JACOB_SENSEI_1_PARAMS` with the new
terms at first guesses, 40 generations of 10 mutants x 300 games, confirmed on 800 (3 accepted), on Classic 2p 0.25,
World 2p 0.05, Classic / Asia 4p 0.1 / 0.05, World / Fantasy / Nine Realms 6p 0.15 / 0.1 / 0.05, USA 8p 0.05, Greater
Europe / World 10p 0.1 / 0.1, 500-turn limit, `--stall 1`, `--selfplay greater_europe:10,world:6,fantasy:10,classic:4
--length 0.3`. `--fitness points` (new) judges tables of 3+ on leaderboard points per seat (0.5 + difference / 6)
instead of wins. Duel numbers: the same tuner from `JACOB_SENSEI_1_PARAMS` with `killWin`, `killCarry`,
`borderDelta`, `cardTight`, `duelDeny`, `duelEv`, `capitalPad` at first guesses, 30 generations on 2-player tables
only (Classic 0.35, World 0.2, Greater Europe 0.15, Fantasy / Europe / Asia 0.1), win share (1 accepted). About 1.5
hours on the training PC's CPU.

**Results** (2026-10-21, mirrored seed pairs, 500-turn limit; points = mean leaderboard points per seat, difference
with a 95% interval over seed pairs; `src/tables.ts`, which now reports that interval and takes `--options`).

Against `jacob-sensei@1`:

| table | games | score (95%) | points difference (95%) |
| --- | --- | --- | --- |
| Classic 2p | 2,000 | 0.532 (0.514-0.550) | +0.19 (+0.08..+0.30) |
| World 2p | 2,000 | 0.544 (0.526-0.561) | +0.26 (+0.16..+0.37) |
| Fantasy 2p | 2,000 | 0.534 (0.517-0.552) | +0.20 (+0.10..+0.31) |
| Asia 2p | 2,000 | 0.566 (0.547-0.586) | +0.40 (+0.28..+0.51) |
| Classic 3p | 400 | 0.528 | +0.12 (-0.10..+0.33) |
| Classic 4p | 400 | 0.593 | +0.42 (+0.13..+0.70) |
| Asia 4p | 400 | 0.583 | +0.47 (+0.21..+0.73) |
| World 5p | 400 | 0.608 | +0.56 (+0.32..+0.79) |
| Classic 6p | 400 | 0.630 | +0.80 (+0.53..+1.08) |
| World 6p | 400 | 0.610 | +0.57 (+0.30..+0.84) |
| Fantasy 6p | 400 | 0.643 | +0.78 (+0.49..+1.08) |
| Bohemia 6p | 400 | 0.630 | +0.67 (+0.39..+0.95) |
| Nine Realms 6p | 400 | 0.658 | +0.74 (+0.49..+0.99) |
| USA 8p | 400 | 0.650 | +1.00 (+0.73..+1.28) |
| Asia 8p | 400 | 0.685 | +0.93 (+0.69..+1.17) |
| World 10p | 400 | 0.675 | +1.09 (+0.83..+1.36) |
| Greater Europe 10p | 400 | 0.718 | +1.09 (+0.80..+1.37) |
| Fantasy 10p | 400 | 0.738 | +1.33 (+1.07..+1.59) |
| league, progressive (`configs/gen5-nofog.json`): Classic 2p / World 2p | 400 each | 0.530 / 0.490 | +0.12 (-0.04..+0.27) / -0.04 (-0.18..+0.10) |
| league, progressive: Classic 4p / World 6p / Fantasy 6p / World 10p | 400 each | 0.545-0.650 | +0.34 / +0.78 / +0.83 / +1.00 (all above 0) |
| league, fixed cards (`configs/gen5-fixedcards.json`): Classic 2p / World 2p | 400 each | 0.520 / 0.508 | +0.09 / +0.04 (both cross 0) |
| league, fixed cards: Classic 4p / World 6p / Fantasy 6p / World 10p | 400 each | 0.543-0.600 | +0.52 / +0.46 / +0.32 / +0.87 (all above 0) |

Against `delove@6`, each Jacob on the same seeds (2p: 800 games, 4-10p: 200):

| table | `jacob-sensei@2` score | its points difference | `jacob-sensei@1` score | its points difference |
| --- | --- | --- | --- | --- |
| Classic 2p | 0.413 (0.384-0.442) | -0.52 (-0.70..-0.35) | 0.403 (0.373-0.433) | -0.58 (-0.76..-0.41) |
| World 2p | 0.376 (0.347-0.406) | -0.74 (-0.92..-0.57) | 0.354 (0.324-0.384) | -0.88 (-1.06..-0.70) |
| Classic 4p | 0.550 | +0.35 (+0.02..+0.68) | 0.495 | -0.18 (-0.56..+0.19) |
| World 6p | 0.685 | +1.01 (+0.64..+1.38) | 0.615 | +0.92 (+0.56..+1.28) |
| Fantasy 6p | 0.745 | +1.40 (+1.06..+1.75) | 0.675 | +1.08 (+0.72..+1.44) |
| Nine Realms 8p | 0.845 | +2.04 (+1.72..+2.36) | 0.655 | +0.99 (+0.61..+1.37) |
| World 10p | 0.845 | +1.84 (+1.52..+2.16) | 0.630 | +0.53 (+0.12..+0.94) |
| league: Classic 4p | 0.315 | -0.45 (-0.75..-0.15) | 0.308 | -0.60 (-0.85..-0.35) |
| league: World 6p | 0.560 | +0.48 (+0.14..+0.81) | 0.455 | -0.20 (-0.55..+0.16) |
| league: World 10p | 0.570 | +0.09 (-0.26..+0.44) | 0.495 | -0.56 (-0.99..-0.12) |

Self-play (every seat `jacob-sensei@2`, 64 games per table): 0 of 960 games hit the turn limit on Classic 2/4/6p,
World 4/6/10p, Greater Europe 4/10p, Fantasy 6/10p, Asia 8p, USA 10p, Europe 8p, Bohemia 6p, Nine Realms 8p; games are
shorter than Jacob Sensei 1's (World 6p 69 turns against 79, Greater Europe 10p 96 against 120).

**As the rollout teacher** (what a cycle uses it for): branch and score (`delove-branch@1`, 5 options, ranker
`delove@6`, horizon 1, margin 0.01) with `jacob-sensei@2` rollouts against the same with `jacob-sensei@1` rollouts,
the same jobs and seeds (`generate.py --teacher`, paired game by game; 4-10p: `bench/rollout_compare.py`'s league
tables with `jacob-sensei@1` in the other seats; 2p: against `jacob-sensei@1`, both seat orders), 600 games per
table on a cloud RTX 4090 (2026-10-21). The branch seat's points per game, `@1` -> `@2`:

| table | `@1` rollouts | `@2` rollouts | paired difference (95%) |
| --- | --- | --- | --- |
| Classic 2p | 0.725 | 0.800 | +0.08 (-0.05..+0.20); win share 0.575 -> 0.600 |
| Classic 4p | 1.730 | 1.797 | +0.07 (-0.11..+0.24) |
| World 6p | 3.358 | 3.610 | +0.25 (-0.17..+0.67) |
| Fantasy 10p | 3.750 | 4.318 | +0.57 (-0.12..+1.25) |
| pooled 4-10p (1,800 pairs) | | | **+0.30 (+0.02..+0.57)** |

On the GPU mirror it is the same kernel (`packages/delove-gpu` README, "Jacob Sensei 2"), so `generate.py --teacher
jacob-sensei@2` (`DELOVE_BRANCH_TEACHER=jacob-sensei@2` in `cycle.sh`) makes it a cycle's rollout teacher.

## A/B scorecard (`npm run delove:abtest`)

One command scores a candidate against a base version (default `delove@13`) on a frozen gate pool and prints one
scorecard. Every change in the overhaul is judged this way, with the fog tables deciding.

    npm run delove:abtest -- <candidate> [--promotion] [--base delove@13] [--workers 6] [--scale 1] [--tables a,b] [--out <dir>]

`<candidate>` is an agent id (`c19-candidate`, `delove@14`, `delove-branch@1`, ...) or a path to a `.onnx` network.
`--out` writes `scorecard.json` (with every deal) and `scorecard.md`. `--scale 0.25` is a quick look; the verdict
needs the full pool. It runs on the CPU (worker threads), so it can run on the home PC or on a pod.

**The frozen pool** (`configs/abtest-pool-2.json`, `abtest-pool@2`, the default; `--pool configs/abtest-pool-1.json`
plays `abtest-pool@1`). Its seeds come from the pool's own `seed`, and no jobs file plays it, so no training run ever
sees these deals. A changed table is a new pool with a new file and name, because scorecards compare only within one pool
(the scorecard prints the pool file's hash). @2 keeps @1's seed, so the tables it did not change play the same deals.
The tables:

| table | players | field (the other seats) | settings | deals | decides |
| --- | --- | --- | --- | --- | --- |
| fog-classic-4 | 4 | delove@13, @12, @10 | league fog (`gen5-randomfog`) | 40 + SPRT | yes |
| fog-classic-6 | 6 | delove@13, @12, @13, @10, @8 | league fog | 40 + SPRT | yes |
| fog-hexworld-6 | 6 | delove@13, @12, jacob-sensei@2, @13, @10 | league fog, Hex Earth | 40 + SPRT | yes |
| fog-europe-8 | 8 | delove@13, @12, @13, jacob-sensei@1, @10, @13, @12 | league fog, Europe | 40 + SPRT | yes |
| fog-duel-2 | 2 | delove@13 | league fog without capitals | 100 | 2p rule |
| zerg-horde-4 | 4 | zerg@2, delove@13, zerg@2 | live tournament settings, a generated 20-territory board per deal; @2: 200 turns at most | 100 | |
| zerg-mixed-3 | 3 | zerg@2, delove@13 | live tournament settings, a generated 15-territory board per deal | 100 | |
| nofog-classic-6 | 6 | delove@13, jacob-sensei@2, @12, jacob-sensei@1, @13 | league settings without fog | 60 | |

The duel plays without capitals: with capitals, 2-player fog games end on turn 2 more often than not (the first capital
taken), so both versions get the same result on almost every deal and the table measures nothing.

**Duplicate deals.** Deal k of a table is played twice with the same seed (same board, dice and turn order): once with
the candidate in seat r and once with the base there, every other seat the table's field. The unit is the candidate's
leaderboard points in that seat minus the base's, so the luck of the deal and the field cancel. The seat rotates with
the deal (r = k mod players), so every seat and turn position is played. The base against itself scores exactly 0 on
every deal (a test checks it).

**The verdict** is the sequential test of `scripts/sprt.mjs` over the deciding (fog) tables, pooled with equal weight
per table: H0 "no gain" against H1 "a gain of at least h1 points per seat", at 5% error each way. Every table plays
its deals; then the deciding tables go on, a few chunks at a time, until the test decides or they reach `maxDeals`.
The verdict is **better**, **not better** or **undecided**, and 2-player tables must not be significantly worse (the
owner's rule). Every table also reports its paired 95% interval, mean place in the seat and wins. Two tests (pool@2):

- **Quick check** (the default): h1 = 0.25, up to 400 deals per deciding table, about 40 minutes on 6 home CPU threads.
- **Promotion call** (`--promotion`): h1 = 0.15, up to 1,200 deals per deciding table, about 30 minutes on a pod (with
  the Lord of resources' OK). Each fog table's paired interval is about +/-0.3 points per seat at 400 deals (fog
  makes the two games of a deal drift apart quickly), so a 0.15 gain needs about 1,000-1,200 deals per table.

**Ratings.** A Plackett-Luce fit over the finishing order of every game played (Hunter's MM algorithm, with one
virtual win and loss against the base as a weak prior) puts the candidate, the base and the whole field on one scale
(Elo-like, the base at 0), with a bootstrap 95% interval over deals. The league takes its ratings from here.

**Baseline (2026-10-22, `abtest-pool@1`): `delove@13` against `delove@12`**, 3,920 games in 39 minutes on 6 home CPU
threads. Undecided: the fog tables pooled +0.06 points per seat (se 0.08) after 400 deals each. Classic 4p -0.06,
Classic 6p 0.00, Hex Earth 6p -0.13, Europe 8p +0.43 (+0.01 to +0.85, the only one clear of 0). The duel was even, the
Zerg tables +0.15 / +0.13 (not significant), no fog Classic 6p -0.28 (wide). Ratings (`delove@12` = 0): zerg@2 +118,
`delove@13` +3 (-6 to +11), Jacob Sensei 2 -34, Jacob Sensei 1 -98, `delove@10` -108, `delove@8` -112. Cycle 16
promoted `delove@13` on +0.17 (+0.04 to +0.31) with fog on against `delove@12` (CYCLES.md, "c16: the deciding gate, fog
on"); that gain did not reproduce here (+0.06, not significant), so a single gate can mislead. On pool@1 the
zerg-horde-4 table hit the 500-turn limit in 112 of its 200 games; pool@2 stops it at 200 turns.

## League (`npm run delove:league`)

A cycle's jobs file can seat league opponents instead of a fixed list. A seat written `@league` samples a past version
(kind `snapshot`), or the exploiter for its share; `@league:<kind>` samples a member of that kind (`zerg` today;
`impostor` or any other seat type later, for the learned Zerg). The league is `configs/league.json`:

- `members`: `{id, kind, elo?, active?}`. `delove@13`, `@12`, `@10` and `@8` are snapshots. `delove-exploit@1` is the
  exploiter slot, off until one is trained (a version trained to beat the main). `zerg@2` is kind `zerg`.
- `pfsp`: how opponents are weighted (prioritized fictitious self-play, as in AlphaStar). p is the main's chance of
  finishing above a member, from the ratings. `hard` weighs (1 - p)^power, so the opponents the main still loses to
  come up most; `variance` weighs p (1 - p), the even matches; `even` weighs all alike. Every member keeps at least 2%
  of the top weight, so an old version still comes up now and then.
- `exploiterShare` (0.15): the share of `@league` seats an active exploiter takes.
- `splitGames` (250): each league line is split into sub-lines of this many games. Each sub-line has its own opponents
  and its own game numbers, so no two play the same games.

Members without a rating count as even with the main. `rate` takes the ratings from an A/B scorecard:

    npm run delove:league -- rate --league packages/delove/configs/league.json --scorecard <dir>/scorecard.json --out <league.json>
    npm run delove:league -- weights --league <league.json>
    npm run delove:league -- expand --league <league.json> --jobs <file.jobs> --seed 318 [--out <file>]

In a cycle config, `league=<league.json>` makes `cycle.sh` expand every step whose jobs file has `@league` seats into
`OUT/<step>.league.jobs` (seeded by the cycle's seed, kept on a resumed run). The steps then play those files, an
ordinary jobs file for the CPU and GPU generators alike. A GPU step can only seat networks the mirror loads, so check
that every snapshot in the league loads there before a GPU cycle uses it.

## Stage 2: self-play rounds

A round: generate games with a jobs file, export the groups, train from the current best with `--init`, then gate
the candidate on the ladder against the current best (promoted only at >= 0.55 over >= 200 games with the 95%
interval above 0.5).

```bash
bash packages/delove/scripts/generate.sh packages/delove/scripts/round-02.jobs runs/delove/r02 202   # ~14 min
npm run delove -- export --log $(ls -d runs/delove/r02/t*/c* | paste -sd,) --out data/delove/r02-teacher
npm run delove -- export --log $(ls -d runs/delove/r02/x*/c* | paste -sd,) --out data/delove/r02-self
cd packages/delove/python
../../../.venv/Scripts/python train.py --data ../../../data/delove/teacher-01/classic   --data ../../../data/delove/r02-teacher/classic --data ../../../data/delove/r02-self/classic:winners   --init ../../../models/delove/delove@1.pt --out ../../../models/delove/delove@2 --epochs 1 --lr 5e-4   # ~22 min
../../../.venv/Scripts/python export_onnx.py ../../../models/delove/delove@2
cd ../../.. && npm run delove -- ladder --best delove@1 --candidate delove@2 --games 400
```

### A whole cycle in one command

`scripts/cycle.sh` runs a training cycle from a config (`scripts/cycles/c2.cycle` is cycle 2): every step's games go
into one pool of small chunks over all CPU threads (the most expensive step first, so the pool ends on short chunks),
each step is exported as soon as its last chunk is done while the others keep generating, then it trains on the GPU,
plays every ladder gate at once (each split into chunks) and writes the step tables, the gate table and the time of
each phase to `runs/delove/<name>/cycle.md`. Re-running resumes where it stopped.

```bash
DELOVE_MODELS=models/delove PYTHON=.venv/Scripts/python bash packages/delove/scripts/cycle.sh packages/delove/scripts/cycles/c2.cycle
```

Each invocation writes its phase times to `times.tsv` and a copy to `times-<YYYYmmdd-HHMMSS>.tsv` (its start), so a
cycle stopped and resumed keeps every invocation's times.

**Splitting a cycle between home and the cloud.** `GENERATE_ONLY=1` stops `cycle.sh` after generation. Cycle 8 played
its small and medium boards at home that way (steps `a1`-`a4`, `GPU_LANES=4`), played its huge boards on 8 rented
GPUs with `packages/delove-gpu/cloud/remote.py run --name c8 --step b=...` into the same `DATA` and `OUT`, then ran the
full config (every step listed): finished steps are skipped, so it went straight to training and gates. With
`REMOTE_GPUS=N` a single `cycle.sh` run sends every GPU step to the cloud instead.

**GPU lanes and league settings.** `GPU_LANES=N` runs N GPU processes at once and deals the config's GPU steps to them
in turn: split a long step (the big tables) into several so every lane stays busy (cycle 6's second lane idled 5 hours
behind a single big-tables step). Cycle 6's jobs files show the league settings every table now uses (auto setup,
balanced blitz, chosen capitals, and four card/capitals/blizzard variants: `docs/game-settings.md`); cycles 1-5 trained
on the defaults only, and that blind spot was the largest gain of cycle 6.

**Watching a cycle, its history and where the time went.** `scripts/dashboard.mjs` is a local, read-only page over the
run folders (binds 127.0.0.1 only, no external scripts):

```bash
node packages/delove/scripts/dashboard.mjs [--runs runs/delove] [--port 8790] [--no-record]
```

`--runs` is the folder holding the run folders (cycle.sh's `OUT` parent; on the training PC, the stage2 worktree's
`runs/delove`); open `http://127.0.0.1:8790`, `?run=<name>` picks a run (default: the newest).

- **Live**: the phase and pipeline of a cycle, each step's games per map and table size with turn-limit counts, games
  per minute and the time left (from `delove_gpu.generate`'s progress lines), branch-and-score statistics, training
  curves and validation by dataset, the gates with score and points intervals, and the machine's GPU and CPU load over
  the last 2 hours.
- **History**: any run, finished or not. While it runs, the dashboard appends a compact sample every 30 s (phase,
  games, turn-limit games, games/min, GPU load, memory and temperature, CPU load, training step and losses, gate
  games) to `<run>/dashboard/samples.jsonl` for the active run (the newest one written to in the last 10 minutes),
  and the machine's load to `<runs>/_machine/samples-<date>.jsonl`; a sample is skipped when nothing moved (one every
  5 minutes at most then), so a cycle's file stays around 100 KB. The tab charts those samples and, for every run,
  shows its phases on the clock, GPU and CPU busy time, generation per step and map / table size (with the last 5% of
  each configuration's games) and a bottleneck list, worked out from the run's files when it has no samples (cycle 5
  and older). One dashboard records at a time: a second one sees the first's heartbeat (`_machine/recorder.json`) and
  only reads; `--no-record` never writes.
- **Compare cycles**: every run with phase stamps, a bar per phase (CPU pool, each GPU step, training, gates, time
  between invocations) in minutes, games and decisions per hour of generation, training samples/s, GPU and CPU busy
  share, idle time and each cycle's top bottlenecks.

`scripts/timing-report.mjs <run dir> [...more] [--batch N] [--out file.md]` writes the same as Markdown: time per
invocation, phase, step and map / table size; GPU vs CPU share and the idle gaps; throughput (games/min, decisions/s,
training samples/s, from the training batch in the cycle config next to the jobs files, or `--batch`); the slowest tail
(the last 5% of each GPU configuration's games, the CPU and gate pools' tails and slowest chunks); and a short
bottleneck list. It needs only `times*.tsv`, the chunk and gate files, `gpu.json` / `gpu.log` and `train.log`
(`runs/delove/c5` works: its generation and its training and gates ran as two invocations, `times-generation.tsv` and
`times-train-gates.tsv`); with the dashboard's samples it adds measured load and idle stretches. Chunk times come from
the files' creation and last-write times. `scripts/run-timing.mjs` holds the reading both share.

**A step on the GPU.** A config can list steps to play on the GPU instead, `gpu_steps=(classic2)`, or every step,
`gpu_steps=(all)` (`GPU_STEPS="micro classic4"` or `GPU_STEPS=all` overrides the config): that step's tables
go to `python -m delove_gpu.generate` (`packages/delove-gpu`), in the background while the CPU pool plays the other
steps, with the same seed, tables and `DELOVE_BRANCH_*` settings the pool would use. It writes the training arrays to
`DATA/<name>-<step>` itself (no export) and its per-table results and branch stats to `OUT/<step>/gpu.json`, which
`scripts/summary.mjs` reads in place of the chunk results, so `cycle.md` has the step's tables as before. Any map, table
size (2-10 seats) and game setting but fog of war qualifies, with branch, teacher and network seats; the generator
refuses fog of war, `risky@1` and `-explore` seats, and cycle.sh refuses `DELOVE_BRANCH_VALUE`. Before the pool starts,
cycle.sh checks the mirror's fingerprint: if the engine changed since the last verification, run
`packages/delove-gpu/verify.py --models <models dir>` first. Games in flight are sized per table configuration to
`GPU_GB` of game state (default 3, fits the RTX 4060's 8 GB with the networks); `GPU_BATCH` fixes the number.

**GPU steps on rented cloud GPUs.** `REMOTE_GPUS=N` hands every GPU step to `packages/delove-gpu/cloud/remote.py`
instead: the steps' configurations are split over N RunPod GPUs (RTX 4090 by default) by their cost in earlier
`gpu.log` files (`REMOTE_TIMINGS`), played with the same generate arguments, downloaded and merged into the same
`DATA/<name>-<step>/<map>` and `OUT/<step>/gpu.json`. `RUNPOD_API_KEY` must be in the environment; the estimated cost
is printed first, `REMOTE_MAX_GPU_HOURS` (default 4) caps it (each pod's share counted from its creation), and every
pod is terminated at the end. RunPod's stock is read first (`REMOTE_CAPACITY_WAIT`, minutes, default 30). A step whose
configurations did not all come back is not merged: the finished ones are kept, `OUT/<step>/gpu.partial.json` lists
the missing ones, and running cycle.sh again plays only those (`REMOTE_ACCEPT_PARTIAL=1` merges what came back
instead). Progress goes to `OUT/remote.log`. See [packages/delove-gpu, Cloud workers](../delove-gpu/README.md#cloud-workers).

**Training on a rented cloud GPU.** `REMOTE_TRAIN=1 REMOTE_VOLUME=<RunPod network volume id>` trains the candidate on
one rented GPU instead (`remote.py train`): with `REMOTE_GPUS` the generation pods run in the volume's data center and
leave their arrays on it, the training pod is rented `REMOTE_TRAIN_LEAD` minutes (default 12) before generation's
estimated end, merges the cycle's arrays there, trains with the same `train_data` and `train_args`, and sends back only
the candidate's `.pt`, `.json`, `.onnx` and `.value.onnx` and `train.log` (progress in `OUT/remote-train.log`). Every
`train_data` entry must be a step of the cycle or `<dataset>/<map>` under `DATA`. A dataset not on the volume trains
the candidate at home instead (exit 3), unless `REMOTE_TRAIN_PUSH=cycle` (this cycle's, e.g. CPU steps) or `all`
(earlier cycles' too, once) pushes it from `DATA`; home training needs the arrays at home (`REMOTE_HOME_COPY=1`).
`REMOTE_TRAIN_MAX_GPU_HOURS` (default 1.5) caps it. See
[packages/delove-gpu, Cloud training](../delove-gpu/README.md#cloud-training).

**Gates on the GPU.** `gpu_gates=(all)` in the config, or a list of gate indices (`gpu_gates=(4 6 7)`, 0-based in
`gates=(...)`), plays those gates on the GPU (`python -m delove_gpu.ladder`, [packages/delove-gpu](../delove-gpu/README.md#ladder-gates-on-the-gpu))
and the rest on the CPU, at the same time; `GPU_GATES=1` (all), `GPU_GATES="4 6"` or `GPU_GATES=0` (none) overrides
the config. CPU gates stay the default. The GPU plays the same chunks with the same seeds and writes the same
`OUT/gates/g<i>-<k>.json` (byte for byte, but for rare ONNX vs PyTorch near-ties), so the gate table and a resumed run
cannot tell them apart; its log is `OUT/gates/gpu.log`. One Python process takes every GPU gate chunk, one engine per
table configuration, one configuration after another (`GPU_GATE_PROCS=N` runs N processes, each with whole
configurations; `GPU_GATE_GB`, default 1, sizes each configuration's games in flight; `GPU_BATCH` fixes it). Before it
starts, cycle.sh checks the mirror's fingerprint and stops on a stale mirror unless `GPU_GATES_ALLOW_UNVERIFIED=1`.
Network and tuned-teacher opponents (and Jacob Sensei where the mirror has it) play on the GPU; it refuses fog of war
and `delove-branch@1`, `risky@1` or `-explore` seats, so leave those gates on the CPU. To re-run gates only (after
training), run cycle.sh again with the same config: finished generation, exports and the trained model are kept.

Which gates to move: a GPU configuration takes about as long as its longest game, whatever the number of games, while
the CPU plays a gate's chunks side by side. So the GPU wins on the big boards and loses on the small ones (200 games:
Greater Europe 6p 541 s on the GPU against 878 s for the CPU's longest chunk with 6 busy processes; Greater Europe 10p
took 1,572 s in cycle 5's full pool; World 10p 213 s against 166-415 s; Classic 2p 34 s against 21-40 s; Four Crowns 2p 71 s
against 12-22 s). Put the big-board gates on the GPU and keep 2-4 player Classic and Four Crowns on the CPU; the gate
phase then ends with the slower side. Measurements and the reasons:
[packages/delove-gpu](../delove-gpu/README.md#speed-of-a-gate).

The games are the CPU's: cycle 3's Classic 2-player step played this way (`c3.cycle` with `gpu_steps=(classic2)`,
same environment as cycle 3) gives a `cycle.md` step table identical to cycle 3's CPU one, every number of it: wins
per table, mean turns, decisions, and all branch-and-score statistics.

**The gate table** reports, for each ladder match, the score (win share, 95% interval, Elo) and the leaderboard view:
mean points per seat for the candidate and the opponent, their difference with a 95% interval (from the spread of the
gate's chunks), the candidate's mean place and kills per seat, and the games that hit the turn limit. Since cycle 5
promotions are judged mainly on the points difference at 4-10 players (`docs/delove-status.md` section 3).

**Gates: paired statistics and SPRT** (`scripts/sprt.mjs`, #160). Every ladder match is played in mirrored pairs (same
seed, seats swapped), and each result now lists every pair's points difference per seat (`pairPointsDiff`, from
`runMatch` and `delove_gpu.ladder` alike). The summary's second table uses them:
- Each gate's paired 95% interval: one unit per pair rather than per 20-game chunk. Gate files from before #160 fall
  back to chunks, marked "(chunks)".
- A sequential probability ratio test on the owner's promotion rule, the way Stockfish's fishtest decides patches.
  The statistic is the pooled points difference at 4-10 players against the first gate's opponent, each table weighted
  equally. It is tested as H0 "no better than 0" against H1 "at least `GATE_SPRT_H1` better" (default 0.15 points per
  seat), at 5% error each way. 2-player tables are checked for "not significantly worse".

With `GATE_SPRT=1`, `cycle.sh` keeps adding 2 chunks to each pooled table (and to any 2-player table still in doubt)
until the test decides, up to `GATE_SPRT_MAX` games per table (default 800). Clear results stop at the planned games;
close calls get more games automatically instead of a recheck by hand. On cycle 13's gate files (chunk fallback) it
reproduces the gate table and accepts H1 (pooled +0.16, LLR 3.52 against a bound of 2.94), the call the cycle made after
its manual recheck.

`PANEL=1` adds the **fixed reference panel** to the gates, so every cycle plays the same opponents and progress reads
off one table: `delove@6` (World 6p, 2p), `delove@3` (World 6p), `jacob-sensei@1` and `@2` (World 6p; `@2` also 2p) and
Sensei 2 (2p). Panel gates are reported, never pooled into the SPRT. Copy each cycle's panel row into
`docs/delove-status.md`, "Progress, measured directly".

    node packages/delove/scripts/sprt.mjs runs/delove/<cycle>/gates [--h1 0.15] [--alpha 0.05] [--beta 0.05] [--base delove@N] [--json]

**Training options** (`python/train.py`, through `train_args` and `train_data`):
- `--amp`: the network in bfloat16 mixed precision (losses, optimizer and weights stay float32). On the RTX 4060 it
  gives the same validation loss as float32 (0.9455 vs 0.9449 on cycle 5 data) at 1.9x the speed, and less memory.
- `<dataset>#F` (in `train_data`, or `--data <path>#F`): each epoch trains on a fresh random fraction F of that
  dataset's training decisions, so older cycles keep their influence at a fraction of their cost.
- `<dataset>:value` (mode): the value head learns from those positions and outcomes, the policy ignores their moves
  (weight 0): for data whose moves shouldn't be copied, e.g. cycle 5's big tables, whose moves were mostly Sensei 2's.
- `--branch-weights W0,W1,W2`: weights the policy by what branch and score did at each decision (`branch_tag.npy`,
  written by `delove_gpu.generate`): 0 the teacher's move without comparing, 1 compared and kept, 2 changed. Cycle 6
  used `0.5,1,2`. Datasets without `branch_tag.npy` (CPU exports, older cycles) keep weight 1.
- `--soft-targets C` (with `--soft-prior P.pt`, default the `--init` weights, or `uniform`): at every branched
  decision the policy learns branch and score's whole comparison instead of only the played move, Gumbel
  AlphaZero's "completed Q" target: softmax(prior logit + C x the compared options' mean scores scaled 0..1 within the
  decision), where the options never compared get the prior-weighted mean of the compared ones, so they keep the
  prior's order (`python/soft.py`; checks `python packages/delove/python/test_soft.py`). The prior is a frozen
  network, never the one being trained. The scores come from `branch_q.npy` (one float32 per candidate, NaN where not
  compared): `delove_gpu.generate` writes it; for a CPU export run the games with `DELOVE_BRANCH_TRACE` and then
  `python packages/delove/python/branch_q.py --export <export> --log <log dir> <trace file> [--log ...] --agents
  delove-branch@1` (logs in export's order). Decisions with fewer than two compared options, and datasets without the
  array, keep the played move; `--branch-weights`, range credit and `:modes` weight soft and hard decisions alike.
  `--soft-scale S` scales the scores by an absolute gap instead of min-max within each decision: q_hat = clip((q - the
  lowest compared score) / S, 0, 1), so two options 0.002 apart (rollout noise at 6 copies) stay 0.2 logits apart at
  C=5 with S=0.05, where min-max would make them 0 vs 1, as sharp as a hard label (Gumbel MuZero keeps its value
  bounds fixed for the same reason). Min-max stays the default, so the two can be compared.
  Smoke run (150 Classic 2p branch games with Jacob rollouts, CPU, from `delove@3`, 1 epoch, `--range close
  --branch-weights 0.5,1,2`): trains; whether it beats hard labels is cycle 12's A/B.
- `--confidence TAU[,FLOOR]`: scales a branched decision's policy weight by clip(gap / TAU, FLOOR, 1), the gap being
  the best minus the second-best compared score in `branch_q.npy` (`python/confidence.py`; checks
  `python packages/delove/python/test_confidence.py`). A near-tie label is mostly rollout noise: the architecture review
  (2026-10-22) measured the cycle teacher picking the same move under fresh rollout seeds only about half the time,
  with 62-70% of searched decisions in cycle 17's data under a gap of 0.01. Decisions with fewer than two compared
  options keep weight 1; combine with `--soft-targets` so ties teach "these are equal" and clear wins count fully.
- `--aux-rollout W`: adds a rollout head that learns each branched decision's 1-round result, the played option's
  mean branch score from `branch_q.npy` (0..1), with weight W on a squared-error loss (KataGo-style auxiliary target:
  a one-round outcome is far less noisy than the final points). Starting from a network without the head adds a fresh
  one; the policy, the value head and the ONNX export are unchanged (`forward(..., aux=True)` returns the head;
  checks `python packages/delove/python/test_aux.py`). Measured (#150; 1,200 CPU steps from `delove@8` on cycle 11's
  Classic, World, Fantasy and Nine Realms, held-out games): the head predicts the 1-round score with **R² 0.89**
  (0.81 at 4 players to 0.93 at 10; the value head only correlates 0.75 with it), while top-1 (0.627 vs 0.626) and the
  value's R² on final points (0.372 both) don't move in a short fine-tune. So it is a sharp, cheap position signal
  for later uses (a low-noise baseline for credit, or an after-move evaluator to cut rollouts) rather than a gain on
  its own; it reads the board before the move, so it can't rank one decision's options yet.
- `--grow-rounds N` (with `--init`): network surgery. The network grows to N message-passing rounds; the new rounds
  are added after the old ones with their last layer at zero, so each passes its input through and the grown network
  starts as exactly the same player (outputs bit-identical, `python packages/delove/python/test_grow.py`), then
  learns. OpenAI Five changed its architecture about 20 times in ten months this way without restarting. Adding rounds
  is exact; widening `--hidden` is not (LayerNorm's statistics change with the width). 6 to 8 rounds adds about 25%
  parameters and training time; checkpoints, ONNX export and the GPU mirror's network read the round count from the
  config, so nothing else changes. Cycle 14 trains it as a second candidate next to the plain fine-tune (#161).
- `--device cpu|cuda`: where to train (default cuda when available).
- `--alive LO-HI` (range specialists): only decisions with LO..HI players alive.
- Keep a batch within the card: on big maps (Greater Europe, Fantasy) batch 1024 spilled past the RTX 4060's 8 GB into
  shared memory and ran 5x slower; batch 512 fits.

A cycle-2-sized run (2,000 micro games, 3,000 Classic 2-player and 600 Classic 4-player branch games, training,
1,800 gate games) takes **20 minutes**, where cycle 1's way took about 80 minutes before its gates:

| phase | before (cycle 1/2 logs) | `cycle.sh` |
| --- | --- | --- |
| micro games | 6.8 min | (in the pool) |
| Classic 2-player games | 32.5 min | (in the pool) |
| Classic 4-player games | 26.3 min | (in the pool) |
| all games | 65.6 min | 11.0 min |
| exports | ~5 min after the games | done 5 s after the last game |
| training (GPU) | ~10 min | 8.1 min |
| gates | one match at a time | 1.2 min, all at once |

Where it comes from: the engine copies a state by shape instead of `structuredClone` (most of a simulated move's
time) and lists connected fortify targets with one indexed search per position; the teacher works out each
per-territory answer once per position (together 4.6x on branch games, same moves); branch and score compares 3
options instead of 4 and lets the teacher play `occupy` decisions (1.6x more on 2-player games, 1.75x on 4-player).
Branch settings measured with `scripts/branch-variant.sh`, 2,000 two-player Classic games each against Sensei 2
(both seat orders, same seeds; paired difference against today's setting):

| options / rollouts / skip | score | paired difference | s per game |
| --- | --- | --- | --- |
| 4 / 6 / - (before) | 0.530 | - | 4.69 |
| 3 / 6 / - | 0.562 | +0.032 ± 0.025 | 3.94 |
| 4 / 4 / - | 0.488 | -0.043 ± 0.027 | 3.38 |
| 3 / 4 / - | 0.508 | -0.022 ± 0.025 | 2.73 |
| 4 / 6 / occupy | 0.548 | +0.018 ± 0.023 | 3.51 |
| 3 / 4 / occupy | 0.532 | +0.002 ± 0.026 | 1.99 |
| 3 / 4 / occupy, trade | 0.539 | +0.009 ± 0.026 | 1.91 |
| **3 / 6 / occupy (now)** | **0.574** | **+0.043 ± 0.025** | **2.88** |
| 3 / 6 / occupy, trade | 0.568 | +0.037 ± 0.025 | 2.84 |

Across these runs 4 rollouts cost about 0.035 against 6 (8,000 games a side), so rollouts stay at 6; fewer options
and skipping `occupy` cost nothing measurable. On 4-player Classic (800 games, Sensei 2, `delove@2` and `risky@1` at
the table) the branch player's share of wins was 0.688 before and 0.659 now (paired -0.029 ± 0.043; 0.25 is even) at
10.1 instead of 17.7 s per game. (The 0.688 two-player figure from 96 games earlier was luck or an older setting:
2,000 games put today's setting at 0.53, and cycle 1's own Classic games at 0.549.) `occupy` moves in the logs are now
Sensei 2's own; set `DELOVE_BRANCH_SKIP=` to branch on them again.

Every step can also run on the GPU (`packages/delove-gpu`, `python -m delove_gpu.generate`): the same games, the same
decisions and bit-identical training arrays (checked by replay), on every map and table size; 4.6x faster than this
pool for cycle 3's 6,000 Classic 2-player games (other steps: packages/delove-gpu/README.md, "Speed"). `DELOVE_BRANCH_TRACE=<file>` makes the branch player write each branched decision's options and mean
scores, which the GPU's replay test compares option by option.

### Scoring rollouts by leaderboard points (`DELOVE_BRANCH_SCORE`): tried, not better

The default branch score (`positionScore`, `score: 'share'`) is won 1, lost 0, otherwise the weighted share of
armies, income, territories, cards and continents. It aims at the leaderboard (placement points plus `KILL_POINTS`
per elimination) only indirectly: it gives nothing for a kill made inside the horizon, for the decider's standing
among the players left, or for how early a knock-out comes in a big game. Two opt-in scores (the `score` field of the
branch settings, `DELOVE_BRANCH_SCORE`, `--score` on the GPU) aim at the leaderboard directly:

- **`points`** (`pointsScore`): the decider's expected place among the players still alive (1 plus, for each rival,
  its chance of finishing above, read off the gap in share score: `clamp(0.5 + 0.5 * n * (mine - theirs), 0, 1)` with
  n players alive), turned into the table's placement points (`placementPoints`, interpolated between whole places;
  the place just below the players still alive when the decider is out, first when it won), plus `KILL_POINTS` per
  player the decider has eliminated, scaled so last place is 0 and first place 1;
- **`kills`**: the share score plus the kill credit alone (`killCredit`: `KILL_POINTS` per player eliminated over the
  placement spread, so 0.5 at 2 players, 0.25 at 4, 0.17 at 6, 0.1 at 10).

Both are cheap, deterministic functions of the board, mirrored bit for bit on the GPU. Share stays the default, so the
golden lock and every earlier result are unchanged.

Measured on the GPU (horizon 1, margin 0.01, ranker `delove@3`, Sensei 2 rollouts; `packages/delove-gpu/scripts/
score_compare.py`). 2 players: the share and points runs on the same 1,000 Classic seeds against `delove@3` and Sensei
2 in both seat orders. 4+ players: head to head, both scores at the same table (GPU-only seats
`delove-branch@1:share` / `:points` / `:kills`, spread round it in every order and from every seat; the other seats
`delove@3` and one Sensei 2), so each game is a pair. Leaderboard points per game (placement + kills; a turn-limit game
scores last place for everyone), 95% intervals:

| table | games | share | points | kills | points - share | kills - share | wins share / points / kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Classic 2p (separate runs, same seeds) | 1,000 | +0.722 | +0.680 | | -0.042 ± 0.074 | | 0.574 / 0.560 / | 0% / 0% |
| World 4p (share vs points) | 520 | +1.413 | +0.906 | | **-0.508 ± 0.387** | | 0.400 / 0.290 / | 14.6% |
| Classic 4p (share vs kills) | 520 | +1.558 | | +1.521 | | -0.037 ± 0.398 | 0.385 / / 0.363 | 1.0% |
| 6 and 10 players (share vs points vs kills) | | | | | | | | deferred (below) |

The 6- and 10-player rows are deferred (the GPU was booked for cycles 6 and 7); they suit a cloud GPU. To run them,
from `packages/delove-gpu` (about an hour of GPU per map and size; results per group, so a run can stop and resume):

```bash
python scripts/score_compare.py h2h-jobs h3.jobs --variants share,points,kills --sizes 6:528,10:510
python -m delove_gpu.generate --jobs h3.jobs --seed 7 --models <models dir> --ranker delove@3 --teacher delove-teacher@2 --horizon 1 --margin 0.01 --gpu-gb 1 --results h3.jsonl
python scripts/score_compare.py h2h-report h3.jsonl
```

The points score loses: it turns small share gaps into whole places, at about twice the share score's slope, so the
same `margin` lets rollout noise change more moves, and it pays for pulling level with the nearest rival rather than
for growing. The kill credit alone makes no measurable difference. **Cycle 7 should keep the share score.** Kills and
placements are already in the value target (cycle 5, points), which is where the leaderboard reaches the network.

### Range scores vs the share score (`--score range`): first measurement

Head to head on the GPU (`scripts/score_compare.py h2h-jobs --variants share,range --net delove@6 --other
jacob-sensei@1`; ranker `delove@6`, Jacob Sensei rollouts, horizon 1, margin 0.01, seed 7; RunPod RTX 4090,
2026-10-21): a `delove-branch@1:range` and a `delove-branch@1:share` seat at the same table, rotated round it in every
order (at 2 players a duel between them; at 3 the third seat `delove@6`; at 6 the field `delove@6` and one Jacob
Sensei). Games start from the deal, so a 3-player game is Mid Range's objective until a player falls, then Close
Range's; a 6-player game is Long Range's until 3 are left. Leaderboard points per game (placement + kills), 95%
intervals, paired by game; 2,228 games:

| table | games | metric that decides it | range | share | range − share (95%) | also |
| --- | --- | --- | --- | --- | --- | --- |
| 2 players (Close: P(win), 12 × 2 search) | 800 | win share | 0.507 | 0.491 | +0.016 (points +0.05 ± 0.21) | Classic 0.515, World 0.500: even |
| 3 players (Mid: P(top 2) + threat) | 900 | top 2 | 0.716 | 0.672 | **+0.043 ± 0.051** | Classic **+0.109 ± 0.072**, World −0.022 ± 0.072; fewer wins (0.323 vs 0.400), so points −0.20 ± 0.19 |
| 6 players (Long: share + 2 × kills) | 528 | points | +2.63 | +2.17 | **+0.46 ± 0.58** | World **+0.99 ± 0.83**, Classic −0.08 ± 0.79; kills 1.81 vs 1.53 per game |

So each range score moves its own metric in the intended direction, with a significant result on one map per range
for Mid and Long. The duel search is even: 12 copies of 2 rounds did not beat 6 of 1 at 2 players. Mid trades wins
for second places, which is its objective (the Mid Range stage decides on top 2, not points). Turn-limit games: 0.1%
to 0.2%. These are teacher-vs-teacher numbers; whether a specialist trained on these labels beats `delove@6` on its
stage is the next cycle's gate (`npm run delove:stages`). The per-game results stay on the training PC.
Pod spend for the verification and both runs: about $3.60.

### Gumbel root (`DELOVE_BRANCH_ROOT=gumbel`): more candidates for the same copies

#141 showed that more options pay (+0.23 points at 4, +0.28 at 5), but every option costs `rollouts` copies. The Gumbel
root (Danihelka et al. 2022, "Policy improvement by planning with Gumbel"; `branch.ts` `gumbelRoot`) searches more
candidates within the same budget, and explores moves the ranker under-rates:

1. **Candidates:** the teacher's move, plus the `DELOVE_BRANCH_K - 1` (default 7) candidates with the highest
   g + logit. Here g is a Gumbel(0, 1) draw per candidate, `-Math.log(-Math.log(u))` with u from the seat's stream
   (one draw per candidate in candidate order, after the teacher's pick, before the fortify completions and the
   seeds), and the logit is the ranker's. That is sampling without replacement from softmax(logits); self-play stays
   deterministic from the seed.
2. **Copies:** `DELOVE_BRANCH_COPIES`, default 0 = options × the decision's rollouts (the `top` root's budget: 5 × 6 =
   30 at cycle settings), spent by **sequential halving** (`gumbelSchedule`): each round every candidate still in gets
   max(1, ⌊budget / (rounds × candidates)⌋) more copies, then the others are halved (rounded up) by
   g + logit + σ(q), with σ(q) = (50 + the most copies any candidate has) × q, q the candidate's mean score so far.
   With 8 candidates and 30 copies that's 8 × 1, 5 × 1, 3 × 2, 2 × 3: 25 copies, and the teacher's move and the
   finalist 7 each. Copy j of every candidate plays seed j (common random numbers), and later rounds add copies on
   top of the earlier ones (the sums carry over).
3. **Pick:** the higher g + logit + σ(q) of the teacher's move and the finalist. The teacher's move is never halved
   away, so the margin rule still compares the pick with it on the same copies.

`DELOVE_BRANCH_ROOT=top` (the default) is the old search, unchanged. Every branch score works with either root; the
value blend (`DELOVE_BRANCH_VALUE`) does not work with gumbel. GPU: `delove_gpu.generate --root gumbel --gumbel-k 8
--copies 0`, or seats `delove-branch@1:gumbel` (with `:k<N>`, `:o<N>` and score tokens, e.g.
`delove-branch@1:range:gumbel`). The trace lists every searched candidate with its mean and copies, and
`branch_q.npy` keeps every searched candidate's mean.

**Measured** (2026-10-21; RunPod RTX 4090, 0.96 pod-hours, $0.85): head to head at the same tables, a
`delove-branch@1:range:gumbel` seat (8 candidates) against a `delove-branch@1:range:o5` seat (the teacher's move
plus the ranker's top 4). Both use 30 copies per decision (Gumbel: 25 in its 8-candidate plan), the range score,
ranker `delove@10`, Jacob Sensei 2 rollouts, horizon 1, margin 0.01, seed 16 (`scripts/score_compare.py h2h-jobs
--variants range:o5,range:gumbel --net delove@10 --other jacob-sensei@2`, run with `--options 5`). The field is
`delove@10` plus one Jacob Sensei 2; both seats rotate through every seat. Leaderboard points per game, Gumbel minus
5 options, 95% intervals, paired by game; 1,892 games:

| table | games | Gumbel − 5 options | wins Gumbel / 5 options | kills per game |
| --- | --- | --- | --- | --- |
| Classic 2p | 400 | **+0.33 ± 0.29** | 0.555 / 0.445 | 0.56 / 0.45 |
| Classic 4p | 296 | +0.03 ± 0.52 | 0.341 / 0.318 | 1.06 / 1.02 |
| World 4p | 296 | **+0.64 ± 0.53** | 0.429 / 0.291 | 1.23 / 0.94 |
| Classic 6p | 300 | −0.20 ± 0.72 | 0.293 / 0.280 | 1.41 / 1.47 |
| World 6p | 300 | −0.41 ± 0.80 | 0.333 / 0.343 | 1.65 / 1.79 |
| World 10p | 300 | +0.38 ± 1.19 | 0.317 / 0.260 | 2.60 / 2.28 |
| **4-10p pooled** | 1,492 | +0.09 ± 0.36 | | +0.09 ± 0.18 kills |

The Gumbel root wins clearly in the duel and at World 4p, and is even pooled over 4-10p, where 6p leans the other
way. So it is at least as good as 5 options for the same copies, and better at 2 players, which is where Close
Range lives. The first cycle to try it is 16 (`DELOVE_BRANCH_ROOT=gumbel`, or `:gumbel` seats on Close Range's
stage jobs). One failed launch before this run cost $0.12 (a branch_q column bug, fixed and covered by
`tests/gumbel_check.py`).

### T2, the bootstrapped teacher: network incumbent and opponent styles (M1, opt-in)

The overhaul's track T2: the search improves on the current network instead of on Jacob alone (Expert Iteration),
against a mix of opponents. Both parts are off by default, so the defaults and the golden lock are unchanged:

- **`DELOVE_BRANCH_INCUMBENT=net`** (`BranchOptions.incumbent`): the move the margin rule protects is the ranker's top
  move (ties to the first candidate), then the teacher's move, then the ranker's next favourites. Without a ranker,
  under fog search, or with the Gumbel root, it is the teacher's move as before.
- **`DELOVE_BRANCH_STYLES=net:0.4,aggr:0.2,turtle:0.2,zerg:0.2`** (`BranchOptions.styles`, `src/styles.ts`): in each
  rollout copy the decider plays the rollout network (`DELOVE_BRANCH_ROLLOUT=<model>`, required; its `:self` / `:all`
  is ignored) and every other seat one style, drawn from the copy's seed (never from the seat's stream):
  - `net`, the rollout network;
  - `aggr` and `turtle`, the rollout teacher with some numbers scaled (`STYLE_SCALES`: attack bar, own-loss weight,
    capture and defence weights);
  - `zerg`, a rush set standing in for the Zerg horde, which the GPU mirror doesn't play.

  Every option sees the same styles on the same copy (common random numbers). The trace lists each copy's styles.
  The Gumbel root does not take styles.

The GPU mirror plays both, replay-verified (`tests/branch_replay.py --incumbent --styles`, verify.py log `branch-t2`,
`tests/styles_check.py`). Next (M2): truncated rollouts with the value head (`valueWeight` on the GPU). Then (M3) the
measurement against T1's labels, with a small sweep of the mix and λ. The design is in the overhaul notes
(`t2-bootstrapped-teacher-design.md`).

### Rollouts played by Delove (`DELOVE_BRANCH_ROLLOUT`): tried, not better; more options are

The plan's top lever after cycle 8 (`docs/delove-status.md` section 9 item 1) was a stronger teacher: Delove itself
playing the branch rollouts instead of the hand-coded teacher, and more options per decision. Both are in now, opt-in
(the defaults are unchanged: golden lock 57/57 identical):

- `DELOVE_BRANCH_ROLLOUT=<model>` (or `<model>:all`): that network's top move in **every** seat of every rollout copy
  (ties to the first candidate, as `delove@N` plays; deterministic). `<model>:self`: the network plays only the
  **decider's** seat, and the rollout teacher (`DELOVE_BRANCH_TEACHER`) the others. Branch.ts `rolloutNet`; the GPU
  mirror's `--rollout` (`cycle.sh` passes the variable to GPU steps), proved against TypeScript traces
  (`packages/delove-gpu/README.md`: 109,522 of 109,524 rollout copies identical, the other 2 reported network near-ties).
- `DELOVE_BRANCH_OPTIONS=4` or `5`: more options (the teacher's move plus 3 or 4 of the ranker's favourites).

**Every seat or the decider's?** Both were built and measured, because the argument cuts both ways: the network models
the decider's own continuation better than Jacob at 2 players (Delove beats Jacob there), but Jacob is the stronger
multiplayer player (it beats `delove@5` 0.685 at World 6p) and the cycle's tables are mostly Jacob seats, so it models
the opponents better. The numbers settle it: at 4-10 players the network makes the search **worse** in every seat
(-0.52 points per game pooled) and still worse in the decider's seat only (-0.43; even at 4 players, worst at 10); at
2 players both are even to slightly ahead (World 0.52-0.53). Of the two, the decider's seat only loses less and costs
less, so it is the one to use if network rollouts are used at all; the measured gain is in more options instead.

Measured on rented RTX 4090s (`packages/delove-gpu/bench/rollout_compare.py`, 2026-10-20; ranker `delove@5`, Jacob
Sensei the rollout teacher, horizon 1, margin 0.01, league settings in two variants per table). 4-10 players: one branch
seat moving round the table among Jacob Sensei seats, every variant on the **same** games (seed, seats, settings), so the
difference is paired game by game; mean leaderboard points of the branch seat per game, 95% intervals. 2 players: each
variant head to head with the Jacob-rollout branch player, both seat orders.

| players | tables (games per variant) | Jacob rollouts (baseline) | network, every seat | network, decider's seat | Jacob, 4 options | Jacob, 5 options |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | Classic, Fantasy (1,000) | +1.48 | **-0.23 ± 0.20** (Classic, 500) | +0.06 ± 0.13 | **+0.24 ± 0.13** | **+0.16 ± 0.13** |
| 6 | World, Greater Europe (1,000) | +3.27 | **-0.81 ± 0.45** (World, 500) | **-0.38 ± 0.35** (750) | +0.18 ± 0.32 | **+0.40 ± 0.32** |
| 10 | World, Fantasy (1,000) | +3.35 | not run (cost) | **-0.95 ± 0.47** | +0.27 ± 0.48 | +0.28 ± 0.50 |
| **4-10 pooled** | | | **-0.52 ± 0.25** (1,000) | **-0.43 ± 0.20** (2,750) | **+0.23 ± 0.20** (3,000) | **+0.28 ± 0.20** (3,000) |
| 2 | Classic (1,000, win share vs baseline) | 0.5 | 0.511 ± 0.031 | 0.507 ± 0.031 | **0.534 ± 0.031** | 0.511 ± 0.031 |
| 2 | World (1,000, win share vs baseline) | 0.5 | 0.528 ± 0.031 | 0.524 ± 0.031 | 0.506 ± 0.031 | 0.505 ± 0.031 |

Points are the branch seat's mean leaderboard points per game (placement + kills; the baseline column) and the paired
difference to the baseline on the same games. Not run: the network in every seat at 10 players (the costliest variant,
after it lost at 4 and 6), and 250 of the Greater Europe games with the network in the decider's seat (cut by the run's
time limit). Data: `<training PC>\Risky-business-stage2\runs\delove\netroll\` (`compare-report.md` and the runs'
`results.jsonl`).

**Cost per decision.** A network rollout is a lockstep loop: every copy whose network seat is to move gets one batched
forward pass (encoder plus network, about 15-20 ms of kernel latency, mostly the encoder's small PyTorch operations),
and a rollout lasts as many steps as its longest copy has network moves. Wall time per branched decision on an RTX 4090
shared by three processes (a group's seconds over its branched decisions; the 2-player rows hold both branch players):

| table | Jacob rollouts | network, decider's seat | network, every seat | Jacob, 4 / 5 options |
| --- | --- | --- | --- | --- |
| Classic 2p (head to head, 1,000 games) | 0.6 ms | 3.3 ms | 4.4 ms | 0.6 / 0.6 ms |
| World 2p | 0.9 ms | 7.3 ms | 7.6 ms | 0.9 / 1.0 ms |
| Classic 4p (250 games) | 0.5-0.9 ms | 10-12 ms | 16-21 ms | 0.7-1.4 / 0.6-0.7 ms |
| World 6p (250 games) | 2.5-2.8 ms | 26-44 ms | 40-63 ms | 2.5-4.9 / 2.6-4.6 ms |
| Fantasy 4p | 0.8-1.5 ms | 28-39 ms | | 1.3-1.7 / 1.0-1.2 ms |
| Greater Europe 6p | 5.0-5.4 ms | 55 ms | | 2.9-4.8 / 3.7-7.5 ms |
| World 10p | 1.6-2.0 ms | 55-104 ms | | 1.9-3.4 / 2.2-2.5 ms |
| Fantasy 10p | 3.1-7.3 ms | 71-134 ms | | 3.6-6.3 / 3.2-5.0 ms |

So network rollouts cost 10-30x Jacob's (more on bigger tables: a round is longer), while 4 or 5 options cost about the
same as 3 on the GPU (the rollout copies run side by side; the step is latency-bound). On the CPU pool every option plays
its rollouts one after another (5 options play 5/3 of the rollouts of 3; not timed here).

**For the next cycle:** keep Jacob rollouts and set `DELOVE_BRANCH_OPTIONS=4` (4 and 5 gain the same at 4-10 players;
4 also wins at Classic 2p and costs less on the CPU pool). Network rollouts stay opt-in;
they would need a stronger network than the teacher in multiplayer first (the bar: beating Jacob-rollout branch play at
4-10 players on points, which `delove@5` does not).

Speed work has two guards. `scripts/golden.mjs record|check <file>` replays ~60 seeded games across maps, player
counts, settings and players (teachers, `risky@1`, the network, the branch player) and fails if any logged decision,
its features or a result changes: record before touching the engine, self-play or Delove code, check after.
`scripts/branch-variant.sh` measures one branch-and-score setting against Sensei 2 in both seat orders on the same
seeds, with the time per game.

`:winners` data teaches the policy mostly from the side that won (`--loser-weight`, default 0.1); imitation data
counts every move.

**Round 2 (not promoted).** 22,000 games (Sensei with 3-6 players; `delove@1-explore` at temperature 0.7 against
itself, Sensei and `risky@1` with 2-6 players), 19.6M decisions with the original 2-player set, 1 epoch from
`delove@1`. `delove@2` against `delove@1` (`--seed 7`): 0.465 (2p, 400 games), 0.55 (4p, interval reaches 0.48),
0.535 (6p), 0.51 (World). Against Sensei: 0.523 (2p), 0.45 (4p, was 0.415), 0.44 (6p); against `risky@1` 4p: 0.79
(was 0.75). Better with more players, slightly worse head to head: imitation still dominates the data (14M of 19.6M
decisions) and the win/loss signal of a whole game is too noisy to say which moves won it. Next: learn from the
value head's judgement of each move (advantage weighting) and a value-guided lookahead at decision time, which can
play better than the policy alone and gives better training targets than copying.

# @risk/selfplay

Headless self-play for training AI players: plays Risk on `@risk/engine` directly (no server, no sockets, no
timers), rates player versions against each other, and logs every decision for a Python trainer. The game server
never imports this package, so training load never touches live games. Training runs on the training PC, not the
Mac mini.

```bash
npm ci && npm run build        # builds the engine and this package (dist/cli.js)
npm run selfplay -- agents     # risky@1 (the live server's bot), random@1
```

## Play (step 1) and log (step 3)

```bash
npm run selfplay -- play --agents risky@1,risky@1 --games 5000 --seed 1 --log runs/night-01
```

- Game `i` is seeded from `(seed, i)`: the deal, the dice and every agent's randomness. Same command, same
  games, byte for byte. Split a run over processes with `--start`: `--games 2500 --start 0` and
  `--games 2500 --start 2500` (same `--seed`) play exactly the games of `--games 5000`.
- Options: `--map world`, `--options '{"capitals":true}'` (any game setting, validated like the server does),
  `--traits '{"aggression":0.8}'`, `--max-turns 500` (then the game is a draw).
- Speed on one core: about 12 two-player classic games a second (9 with logging), a 6-player World game in about
  a second.

### Stage games: starting where 3 or 2 players are left

For the Delove range specialists (Mid Range at 3 alive, Close Range in the 1v1), whose stages are a short tail of a
normal game. `src/positions.ts`; the GPU mirror plays the same games (`packages/delove-gpu` README, "Stage games").

```bash
# a lead-in: six Jacob Senseis play World until 3 are left, then X, Y, Z take the survivors' seats
npm run selfplay -- play --agents "jacob-sensei@1,jacob-sensei@1,jacob-sensei@1,jacob-sensei@1,jacob-sensei@1,jacob-sensei@1>X,Y,Z" \
  --map world --games 1000 --seed 1 --log runs/stage-mid
# starting positions from game records (single files or an archive's games/ folder): the moment each record's players
# alive dropped to 3 and to 2, fog switched off, seats renamed s0..sN-1
npm run selfplay -- positions --records archive/games --out data/positions.jsonl --alive 3,2
# play from the file's 2-alive moments: game i plays position i mod count with its own dice
npm run selfplay -- play --agents "pos:data/positions.jsonl>X,Y" --games 1000 --seed 1 --log runs/stage-close
```

- **Agents `LEAD>STAGE`.** The number of stage agents is the stage (3 or 2 players alive). The lead-in agents play an
  ordinary game (game i seeded as any game i); after each action, once that many real players or fewer are alive, the
  stage agents take the survivors' seats: survivors in turn order from the player to move get stage agent
  `(r + i) % k`, so every role moves round the table over a run. Dead seats keep their agent (they never move again).
  Each seat keeps its own random stream, so a stage game is the same game as the lead-in alone up to the switch.
- **Only the stage is logged.** Decision records start at the switch (`i` stays the step number in the whole game) and
  have the usual format (no `LOG_VERSION` change); outcomes are the whole game's, scored over every seat at the table
  (placement points over all seats, kills including the lead-in's). The game summary gains `stage: {turn, step,
  alive, agents}` (`null` when the game ended before the stage, e.g. a capitals win).
- **Positions** (`StartPosition`: source, map, seats, alive, players already out in order, the full engine state):
  `positionsFromRecord` replays a record to the step after the elimination that left 3 (or 2) players. A position whose
  Neutral a fresh game would not have (a surrender's) is left out, as is a moment after the game was won. Playing one
  (`startState`) reseeds it: `rngState` = the game seed and the undrawn deck reshuffled with
  mulberry32(seed ^ 0x5bd1e995), as branch and score reseeds its copies, so one position gives many different games.
  A positions table takes no `--options` / `--map`: each position carries its own settings.

## Ladder (step 2)

```bash
npm run selfplay -- ladder --file runs/ladder.json --best risky@1 --candidate risky@1   # first run sets the anchor
npm run selfplay -- ladder --file runs/ladder.json --candidate net@2 --games 200
```

Games are played in mirrored pairs (same seed, seats swapped), which cancels most of the luck of the deal. The
result is the candidate's score (win 1, draw 0.5, loss 0), its 95% interval (computed over pair averages, since
the two games of a pair are correlated) and the Elo difference. A candidate
is **promoted** only when it has played at least `--min-games` (200), scores at least `--threshold` (0.55, about
+35 Elo) **and** the lower end of the 95% interval is above 0.5. The ladder file keeps the current best, every
version's rating (anchored at 1000 for the first best) and the match history. `--players 4` plays 4-player games
with the two versions in alternating seats (even counts only); the score is then the share of games won by either of
a version's seats, so its Elo is an approximation of 1v1 strength.

Ladder results also carry the leaderboard view, which suits games with more players better than win share:
`points` and `bestPoints` (mean leaderboard points per seat per game for each version), `pointsDiff`,
`meanPlacement` and `killsPerGame` (the candidate's).

## Decision log format (v3)

A log directory holds:

| file | contents |
| --- | --- |
| `meta.json` | format version, trait keys, phase, card-kind, candidate-kind and rule-flag names, and per map: `territoryIds` (the territory order every array uses), `adjacency` (indexes) and `continents` (bonus, territory indexes) |
| `decisions-<first>-<last>.jsonl.gz` | one JSON object per decision step |
| `games-<first>-<last>.jsonl` | one summary per game: seats' agents, winner, reason, turns, decisions, steps, turn order, territories held |

A decision record (one per step: a fortify is two steps, everything else one):

| field | meaning |
| --- | --- |
| `v`, `game`, `seed`, `map`, `players`, `i` | format version, game id, game seed, map id, seats, step number in the game |
| `turn`, `round`, `phase` | engine turn counter, completed rounds, phase index into `meta.phases` |
| `seat`, `agent`, `traits` | who decided (seats are numbered in seating order), its version id, its traits in `meta.traitKeys` order |
| `rules` | 0/1 flags in `meta.ruleKeys` order (capitals, fixed cards, adjacent fortify, fog of war, balanced blitz) |
| `state.owner`, `state.armies` | per territory: owner (seat, `-1` nobody/blizzard, `-2` the Neutral) and armies |
| `state.seats` | per seat: `[alive, cards held, armies to place, income]` (income: the engine's reinforcements next turn, before cards) |
| `state.order` | seats in turn order |
| `state.hand` | the decider's cards: `[card id, kind index, territory index or -1]` |
| `state.tradeCount`, `state.pending`, `state.capitals`, `state.blizzards`, `state.conquered`, `state.fortified` | sets traded so far, pending occupy `[from, to, min, max]`, capital per seat, blocked territories, conquered/fortified this turn |
| `state.fortifyFrom` | on a `fortify_to` step, the source the step before picked; `-1` otherwise |
| `cands` | the legal choices, broken into small decisions (below) |
| `choice` | index into `cands` (`-1` and an `action` field when an agent played outside the list) |
| `outcome` | `{winner, z, turns, reason, placement, kills, points}`; `z` is 1 for the winner, 0 for losers (at the turn limit survivors share 1). v3: `placement`, `kills` and `points` are the decider's final place, players eliminated and leaderboard points, scored by the engine's `finalPlacements` / `gamePoints` (the server's ranking rule: placement points + 1 per kill). A turn-limit game counts for nothing on the leaderboard, so every seat gets last place's points there: stalling is never worth it |

Candidates use territory indexes: `["place", t, n]` (n = all, half or 1), `["trade", [card ids]]`,
`["capital", t]`, `["attack", from, to]` (a blitz; the move-in is the next decision), `["occupy", n]`
(min, half or max), `["fortify_from", from]` then, as the next step on the same board, `["fortify_to", to, n]`
(all or half), `["end_turn"]`. Splitting the fortify keeps lists short: about 18 candidates per step on Classic and 20
on World, where one-step fortify pairs averaged 117 and 300 and peaked near 15,000 on Greater Europe.
v2 logs (no placement / kills / points) still export, with `points` NaN. v1 logs (one-step `["fortify", from, to, n]`, no `order`/`fortifyFrom`/income/`rules`) still read with
`risky_log.py`, but `export` needs v2: re-run the games.

The full game state is logged (no fog): fog-of-war games are left for later. `python/risky_log.py` is a
standard-library reader (`iter_decisions`, `iter_games`, `load_meta`); `python3 python/risky_log.py runs/night-01`
prints a summary.

## Dataset export (board encoder)

```bash
npm run selfplay -- export --log runs/night-01,runs/night-02 --out data/export-01 [--maps classic]
python3 packages/selfplay/python/risky_dataset.py data/export-01/classic     # checks and a summary (needs numpy)
```

`export` runs every logged step through the board encoder (`src/encode.ts`) and writes NumPy arrays, one folder
per map, loadable with `np.load(..., mmap_mode='r')`. It refuses a non-empty `--out` (add `--force` to overwrite),
unknown `--maps` ids and any record in another log format, and it leaves out fog-of-war games (counted as
`fogSkipped`): the encoder sees the whole board, so training on them would learn from hidden information.

| array | shape | contents |
| --- | --- | --- |
| `territory.npy` | `[N, T, 27]` float32 | per territory: owner slot one-hot (10 seat slots, Neutral, nobody), armies, blizzard, capitals, continent bonus / my share / held whole, border, enemy and own armies next door, card in hand, pending occupy, fortify source |
| `global.npy` | `[N, 94]` float32 | phase, traits, per seat slot (present, alive, cards, territory and army share, income), armies to place, hand, card set values, trade count, turn, round, map size, rule flags |
| `cand.npy` | `[M, 13]` float32 | per candidate: kind one-hot, amount (share of its pool, log), attack odds (log army ratio), trade cards on own territories |
| `cand_from.npy`, `cand_to.npy` | `[M]` int32 | territory a candidate moves from / targets (`-1` none): gather the territory embeddings it is about |
| `cand_offset.npy` | `[N + 1]` int64 | decision k's candidates are rows `cand_offset[k]` to `cand_offset[k+1] - 1` |
| `choice.npy`, `z.npy`, `game.npy`, `seat.npy` | `[N]` | chosen candidate (index within the decision), final result, game number (split by game), seat |
| `points.npy`, `points01.npy` | `[N]` float32 | the decider's leaderboard points, and the same scaled to 0..1 (last place .. first with every rival eliminated); NaN for v2 logs |

`features.json` names every column and carries the map's territory order and adjacency. Everything is from the
decider's point of view: seat slots are renumbered by turn order starting with the decider, so one network plays
every seat. Unbounded counts (armies, escalating card values, income) are log-scaled. The encoder is the only
feature code: live play builds the same input with `decisionInput(state, ...)` and `encodeDecision`, so the
network sees in play exactly what it trained on. Bump `ENCODER_VERSION` when a feature changes.

Size: about 4.5 KB per step on Classic (most of it `territory.npy`), so 1,000 two-player games are about 1.7 GB.
`risky_dataset.py` gives `load_dataset(folder)`, `ds.decision(k)` and `ds.split_by_game(0.1)`.

## Adding a player version

An agent is `{ id: 'name@version', choose(ctx) }`; `ctx` has the full state, the engine's legal moves, the
candidates, the seat's traits and a seeded `random()`. It must be deterministic given `ctx`. A learning player is
easiest as `stepAgent(id, pick)`: `pick(ctx)` returns an index into `ctx.candidates` and is asked again (with
`ctx.fortifyFrom` set) for the destination after a `fortify_from`. Register it with `registerAgent` so the CLI can
find it by id.

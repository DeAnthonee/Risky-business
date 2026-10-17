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

## Ladder (step 2)

```bash
npm run selfplay -- ladder --file runs/ladder.json --best risky@1 --candidate risky@1   # first run sets the anchor
npm run selfplay -- ladder --file runs/ladder.json --candidate net@2 --games 200
```

Games are played in mirrored pairs (same seed, seats swapped), which cancels most of the luck of the deal. The
result is the candidate's score (win 1, draw 0.5, loss 0), its 95% interval and the Elo difference. A candidate
is **promoted** only when it has played at least `--min-games` (200), scores at least `--threshold` (0.55, about
+35 Elo) **and** the lower end of the 95% interval is above 0.5. The ladder file keeps the current best, every
version's rating (anchored at 1000 for the first best) and the match history. `--players 4` plays 4-player games
with the two versions in alternating seats.

## Decision log format (v1)

A log directory holds:

| file | contents |
| --- | --- |
| `meta.json` | format version, trait keys, phase and card-kind names, and per map: `territoryIds` (the territory order every array uses), `adjacency` (indexes) and `continents` (bonus, territory indexes) |
| `decisions-<first>-<last>.jsonl.gz` | one JSON object per decision |
| `games-<first>-<last>.jsonl` | one summary per game: seats' agents, winner, reason, turns, decisions, turn order, territories held |

A decision record:

| field | meaning |
| --- | --- |
| `v`, `game`, `seed`, `map`, `players`, `i` | format version, game id, game seed, map id, seats, decision number in the game |
| `turn`, `round`, `phase` | engine turn counter, completed rounds, phase index into `meta.phases` |
| `seat`, `agent`, `traits` | who decided (seats are numbered in seating order), its version id, its traits in `meta.traitKeys` order |
| `state.owner`, `state.armies` | per territory: owner (seat, `-1` nobody/blizzard, `-2` the Neutral) and armies |
| `state.seats` | per seat: `[alive, cards held, armies to place]` |
| `state.hand` | the decider's cards: `[card id, kind index, territory index or -1]` |
| `state.tradeCount`, `state.pending`, `state.capitals`, `state.blizzards`, `state.conquered`, `state.fortified` | sets traded so far, pending occupy `[from, to, min, max]`, capital per seat, blocked territories, conquered/fortified this turn |
| `cands` | the legal choices, broken into small decisions (below) |
| `choice` | index into `cands` (`-1` and an `action` field when an agent played outside the list) |
| `outcome` | `{winner, z, turns, reason}`; `z` is 1 for the winner, 0 for losers; at the turn limit survivors share 1 |

Candidates use territory indexes: `["place", t, n]` (n = all, half or 1), `["trade", [card ids]]`,
`["capital", t]`, `["attack", from, to]` (a blitz; the move-in is the next decision), `["occupy", n]`
(min, half or max), `["fortify", from, to, n]` (all or half), `["end_turn"]`.

The full game state is logged (no fog): fog-of-war games are left for later. `python/risky_log.py` is a
standard-library reader (`iter_decisions`, `iter_games`, `load_meta`); `python3 python/risky_log.py runs/night-01`
prints a summary.

## Adding a player version

An agent is `{ id: 'name@version', choose(ctx) }`; `ctx` has the full state, the engine's legal moves, the
candidates, the seat's traits and a seeded `random()`. It must be deterministic given `ctx`. Register it with
`registerAgent` so the CLI can find it by id.

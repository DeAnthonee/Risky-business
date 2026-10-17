# Tournament mode: one world, many tables

Design notes for the 100-player mode. Agreed with the maintainer before building; change this file
when the design changes.

## The idea

A tournament is one big map played as a bracket. Players are AI agents only: each person's own AI
plays through MCP; people watch.

1. **Round 1.** The map is cut into *arenas* (about 25 on a 100-player map, 13-21 territories each).
   Each arena is an ordinary game of 4 players (5 when the numbers do not divide) with a random turn
   order. All arenas play at the same time.
2. **Round cutoff.** A round closes when `cutoffPercent` of its games have finished (default 51%) or
   after `roundMinutes` (default 15), whichever comes first. A game still running at the cutoff is
   won by whoever holds the most territories; ties go to most armies, then a sudden-death dice roll.
3. **Exactly one player per game advances.** Cards never carry over.
4. **Zoom out.** The next round's games join neighbouring arenas. With `advanceMode: 'keep'`
   (default) a winner starts the round owning every territory of the arena(s) they won, so the old
   map is one section of the new one. With `advanceMode: 'collapse'` each won arena becomes a single
   territory on the new board.
5. **Armies between rounds.** `armies: 'reset'` (default) puts 1 army on every territory and gives
   every player the same armies to place, so a fast winner does not snowball. `armies: 'carry'`
   keeps the armies as they were.
6. **Grouping.** While more than `finalSize` (default 12) players are alive, the next round splits
   them into as many games as possible of at least 4 players, each a contiguous group of their
   arenas. 15 players: 3 games of 5.
7. **Fusion.** The moment the number of players still alive in the whole tournament (waiting
   winners plus players still in a game) drops to `finalSize` or fewer, every running game stops
   after the current attack and all of them merge into the final on one map.
   `fusionMode: 'keep'` (default): everyone keeps what they hold, the maps just join.
   `fusionMode: 'fresh'`: each player keeps one territory (their capital) and everything else is
   neutral.
   Turn order in the final: players who had already won their game, in the order they finished,
   then the others ranked by the cutoff rule.
8. **Final.** A regular game on the merged board, capped at `finalMinutes` (default 90); at the cap
   the cutoff rule decides.
9. **Turn timer.** Every turn has a limit (`turnSeconds`, default 60); when it runs out the server
   finishes the turn (places the armies, ends the turn) so no table stalls.
10. **Fewer players.** The bracket shrinks: N players use ceil(N/4) arenas, a contiguous block of
    the map. 12 or fewer players at the start play the final directly.
11. **Spectators** see the whole map live (every table at once), the bracket, and each zoom-out.
    Eliminated players stay as spectators.

## How it is built

- **Maps** (`scripts/maps/earth.mjs`, the custom world): regions are grouped into `arenas`; the
  generator writes each arena's territories and outline. Arena adjacency comes from the map edges.
- **Engine**: a game can run on a *board*, a subset of a map (`state.board.arenas`), optionally with
  arenas collapsed into single territories. All rules go through `mapOf(state)`, so they do not
  change. `startFromPositions` starts a game from given owners and armies (rounds 2+, the final).
- **Server**: a `Tournament` owns its rounds and their `GameRoom`s, listens to their commits,
  enforces the turn timer and the cutoffs, ranks, groups and fuses. It is persisted under
  `RISK_DATA_DIR` with the rooms.
- **MCP**: agents join a tournament once and keep one token; `wait_for_turn`, `get_state` and `act`
  follow their seat from table to table (a tournament id works wherever a game id does).
- **Client**: a tournament page with the whole map (every table live), the bracket, per-table
  zoom, and the zoom-out animation between rounds.

## Stages (one PR each)

1. Maps with arenas (Earth, then the custom world) and engine boards.
2. Engine: `startFromPositions`, collapsed boards, ranking helper; turn timer in the server.
3. Server tournament orchestration + HTTP API + persistence + tests.
4. MCP tools for tournaments.
5. Spectator UI.

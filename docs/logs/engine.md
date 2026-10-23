# Engine rules: running log

Covers `packages/engine/src` and its tests: rules, turn flow, settings (`options.ts`), views and fog, the built-in
bot, ranking and the game-record format. Map data has its own log ([maps.md](maps.md)).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the commit
hash instead. **In the same PR** as any change to this area, write your line to a fragment in
[pending/](pending/README.md), not to this file (README hard rule 12; folded in by `npm run logs:fold`).

- 2026-10-22 #313 record header room.roster (optional, RECORD_VERSION unchanged): each house roster seat's roster id and model, in the full record only
- 2026-10-22 #312 records gain the `aborted` outcome (`reason: "aborted"`, `outcome.aborted` with the standing so far, no winner); additive, RECORD_VERSION stays 1
- 2026-10-22 #301 renameStandIn (seats.ts, not mirrored): rename a seat in a game in progress
- 2026-10-22 #296 `zerg.test.ts`: the "never attacks a fellow Zerg while a non-Zerg is alive" check counted `attack` events, which don't exist (the fight event is `battle`), so it could never fail; it now counts `battle` events and still passes
- 2026-10-22 #294 the storm's texts say it hits "all big stacks" (the lord's option b: no idle exemption); the off test covers all three stall options, and a capture is recorded with only stallEnd on
- 2026-10-22 #293 stall reliever step 2 and the end, all in `stall.ts` (no mirrored file touched, fingerprint green): `stallStorm` (from N stalled rounds, every round start, each player stack of more than STORM_MIN 10 armies loses STORM_SHARE 20%, at least 8 stay; `storm` event, losses fogged per viewer) and `stallEnd` (stallEnd more stalled rounds after the last enabled reliever, `stalemateDue`; `endInStalemate` ends the game on standing with the game's own seeded dice: `stalemate` event, `game_over` reason `stalemate`, `stall.stalemate`); options, state and events declared in stall.ts (module augmentation, `AnyGameEvent`), all absent when off; records give a stalemate `reason: "stalemate"` with its standing as `decided`
- 2026-10-22 #292 stall breaker, bit-identical when off (training's condition, follow-up to #291): `stallFogLift` is optional and absent by default; the counter moves to the new stall.ts (not mirrored) and to one optional `stall {lastCaptureRound, fogLiftedRound}` kept only while a reliever is on, so with the option off the options and state carry no new keys and engine.ts only calls stall.ts; one counter for the later relievers (storms, stalemate end)
- 2026-10-22 #291 stall breaker, step 1 (owner's request): option `stallFogLift` (0 = off, up to 20); the engine counts full rounds since the last territory captured (`lastCaptureRound`), and in a fog game at N it sets the sticky `fogLifted` and emits `fog_lifted {rounds}`; viewFor stops fogging; rules text and options summary; engine.ts and types.ts changed (GPU verify needed)
- 2026-10-22 #269 the startOnSpots seed sweep also covers 8 and 10 seats (the final sizes) with the server's rng seeding, plus Reviewer A's gen1-s427-p8-t40 and gen1-s1072-p10-t50 (follow-up to #265)
- 2026-10-22 #267 records: optional top-level `coach` notes (`RecordCoachNote`); `RECORD_VERSION` stays 1
- 2026-10-22 #265 `startOnSpots` (fixes #264): when a blizzard on a spot can't move alone, the whole set is drawn again away from the spots, as many as before where pickBlizzards could put them, and each freezing territory hands its holder and armies to a thawing one, so a parent table keeps its blizzard count (never 0 by accident) and an even deal, and the start never throws (a player holding only other players' spots trades one not settled yet); an engine seed sweep (3-6 seats x 400 seeds) checks all three
- 2026-10-22 #244 `startOnSpots` throws a RuleError instead of looping if no blizzard borders a cut-off spot (review nit on #241; only a board that is not one network could reach it, and the nested start then falls back to a normal start)
- 2026-10-22 #242 records: optional `outcome.decided` and reason `"standing"` (`assembleRecord(..., decided)`); additive, `RECORD_VERSION` stays 1
- 2026-10-22 #241 `startOnSpots`: a spot thawed because its blizzard had nowhere to move no longer ends up cut off; the blizzards next to it thaw too until the open territories are one network (found by a new max-blizzards test over every generated nested board shape)
- 2026-10-22 #227 nest tests: a nested final on Hex Earth (`hexworld`) puts one portal per region at every final size (6-10), Hex Earth seats 2-10 portals, and works as an inner board
- 2026-10-22 #220 `hexworld` in `MapId`, `MAP_IDS`, `MAPS`, `STARTING_ARMIES` (classic scaled), the map option texts and the rules text; engine tests: size, bonuses paid per region, chokepoints, sea links both ways, connectivity, bot games played to the end at 2-10 seats
- 2026-10-22 #215 `zerg.ts`: a Zerg that takes the last prey territory occupies it before the "no prey left" surrender (zerg@1 and zerg@2); before, it could surrender with its conquest unoccupied at 0 armies (27 of 60 test games under zerg@1, 30 under zerg@2). Golden test updated on purpose: alliance phase unchanged, whole games 555 moves (554)
- 2026-10-22 #206 `record.ts`: optional `note` on a record step (`recordStep` takes `{note}`); optional field, so `RECORD_VERSION` stays 1 and old records load and verify unchanged
- 2026-10-22 #205 `standing.ts`: `onlySideLeft(state, side)` decides whether only one side is left (in progress, not mid-conquest, every living player on the side); `endByStanding` refuses a pending conquest
- 2026-10-22 #205 `standing.ts`: `endByStanding(state, side)` ends a game as it stands, the strongest of the side winning (`strongestZergOf` order), with the usual `game_over`; not mirrored, called by the server only
- 2026-10-22 #204 rules text: a SWARM GAMES section (how to play against the Zergs)
- 2026-10-22 #185 `nest.ts`: `planToNest` also returns the resolved board list (`nodes`) and each planned table's index in it, for the tournament bracket's board tree
- 2026-10-22 #198 `zerg.ts` (urgent): `ZERG_2_PARAMS` (zerg@2) = zerg@1 with `sacrifice: 0` and the new `walledInMass: 1`: no Zerg surrenders while any prey is alive, and a Zerg walled in by its allies reinforces and fortifies toward its territory nearest the prey (6 of 8 Zergs surrendered mid-game in a live 10-player game; the owner called it a bug). zerg@1 is unchanged (`walledInMass: 0`, golden test untouched); new test: 8 Zergs at 10p under zerg@2, zero mid-game surrenders
- 2026-10-22 #177 `nest-start.ts` (new, not mirrored): `startOnSpots(lobby, spots, random)` starts a game with each player on a fixed territory (a nested tournament's parent table): `startGame` with a random deal, then owner+army swaps (and a blizzard moved off a spot) only to a territory where pickBlizzards could have put it, else it thaws; with `autoSetup` the rest is placed through ordinary setup moves
- 2026-10-22 #180 types only: `PlayerView.agent?` (never set by `viewFor`; the server adds it for spectators) and `RecordHeader.room.agents?` (written when a game is filed); no rule change, `RECORD_VERSION` unchanged
- 2026-10-22 #175 `standing.ts` (new, not mirrored): `rankByStanding(state, random, eliminated)` orders an unfinished game for a nested tournament's round end: territories, then armies, then dice (re-rolled among the still tied), then players out (last out first); returns the dice rolled
- 2026-10-21 #181 new unmirrored `nest.ts` exported from the engine: the nested-tournament planner and nested board specs, with engine tests (worked examples, every field 2-400 players, trees of existing and generated boards)
- 2026-10-21 #178 `GameOptions.map` and `parseOptions` accept generated board ids (`gen1-...`, procgen.ts); `getMap`/`isMapId` resolve them (64-board cache); `describeOptions` names a generated board; engine tests for the generator (determinism, golden hashes, quality over 3-10 seats, full bot games, fog)
- 2026-10-21 #174 turn timer settings `turnTimer` (off/move/turn, default off) and `turnTimerSeconds` (5-600, default 15) in OPTION_SPECS + `GameOptions`/`DEFAULT_OPTIONS`; new `timeout` GameEvent; new unmirrored `timeout.ts` (`timeoutSteps`: the skip as ordinary actions, `timerOf`); rules text section; `parseOptions` also rejects ints above their largest value; record steps may carry `timeout: true` (optional, no `RECORD_VERSION` bump). Mirrored `types.ts` changed (behaviour-neutral when off): the GPU fingerprint needs a re-verify
- 2026-10-21 #176 `zerg.ts`: once no non-Zerg is left the strongest Zerg (`strongestZergOf`: most territories, then armies, then the lowest seat index) keeps the table and the others surrender at once, replacing #169's fight to one winner, and `sacrifice` back to 1 (the walled-in Zerg feeds the swarm; owner's decisions); golden test updated on purpose, the alliance phase back to the original recording
- 2026-10-21 #169 `zerg.ts`: `sacrifice` is 0 in `ZERG_1_PARAMS` (no surrenders at all, as the live Zerg seat plays); the parameter stays for tests; golden test updated on purpose
- 2026-10-21 #169 `zerg.ts`: the alliance ends with the prey: once no non-Zerg is left the Zergs fight each other to one winner, no surrenders (owner's rule). Golden test updated on purpose; the alliance-phase moves are pinned unchanged
- 2026-10-21 #167 `zerg.ts`: the Zerg's numbers in `ZergParams` (`ZERG_1_PARAMS` = zerg@1, pinned by a golden test) and four later behaviours off by default (synchronised strike, card hoarding, capital sniping, wall avoidance)
- 2026-10-21 #165 `zerg.ts`: `chooseZergAction` and `zergTarget`, the hand-coded Zerg horde bot (docs/zergs.md). The horde is passed in, not a rule yet; no mirrored file changed
- 2026-10-20 #138 game records: optional `room.board: "training"` on `RecordHeader` for training-leaderboard games (optional field, no `RECORD_VERSION` bump)
- 2026-10-20 #124 `record.ts`: `outcome.placings` holds real seats only; a neutral created by a mid-game surrender no longer gets a place (#123)
- 2026-10-20 #107 `uniqueBoardNames` (board-names.ts): no two leaderboard rows share a display name ("Darius", "Darius2", ...)
- 2026-10-20 #102 `nine_realms` map registered (MapId, MAP_IDS, starting armies, rules text, option descriptions)
- 2026-10-20 #100 `bohemia` map registered (MapId, MAP_IDS, starting armies, rules text, option descriptions)
- 2026-10-19 #79 `ranking.ts` changes so Delove can train on leaderboard points (placement + kills)
- 2026-10-19 #71 engine fast paths that make self-play cycles about 4x faster
- 2026-10-19 #69 `record.ts`: rebuild any recorded moment so it can be played out again as a scenario
- 2026-10-19 #67 game records (`record.ts`, `RECORD_VERSION` 1): every move, the true board and each player's fog view
- 2026-10-19 #64 leaderboard rewards kills and tracks who eliminated whom (`ranking.ts`)
- 2026-10-18 #58 rules text: each player's total reinforcement income is public under fog
- 2026-10-18 #56 reinforcement income visible under fog of war, for leader/threat assessment
- 2026-10-18 #53 exponential card values (`cardValues: exponential`); placement ranking (`ranking.ts`)
- 2026-10-17 #47 built-in bot moved into the engine as `chooseBotAction` with an injectable random source
- 2026-10-17 #46 blitz with a commitment (`stopAt`) and a win chance next to each attack in the legal moves
- 2026-10-17 #42 one log event per attack (start and end armies, losses) instead of one per roll
- 2026-10-17 #41 fog of war: a conquest reveals its neighbours (capitals tagged) before the occupy decision
- 2026-10-17 #40 Four Crowns (`skirmish`) board and the options knockout tournaments use
- 2026-10-17 #37 `balancedBlitz` setting
- 2026-10-17 #35 automatic card trade at 5+ cards (turn start and after a kill)
- 2026-10-17 #33 Europe Advanced (`europe_classic`) registered
- 2026-10-17 #32 `europe_advanced` becomes a legacy map; Greater Europe (`greater_europe`) at 116 territories
- 2026-10-17 #31 fog of war: players learn nothing about opponents beyond what they can see
- 2026-10-17 #30 Greater Europe registered
- 2026-10-17 #21 capitals get +3 armies when set; up to 8 blizzards
- 2026-10-17 #20 starting armies scaled from the classic numbers; round-1 late-turn bonus (`firstRoundBonus`)
- 2026-10-17 #19 players can choose their capital (`chooseCapitals`)
- 2026-10-17 #18 Realms of Halvaren (`fantasy`) registered
- 2026-10-17 #17 Capital Conquest: keep playing after losing your capital; holding every capital wins
- 2026-10-17 #12 Grand World, Europe, USA and Asia registered
- 2026-10-17 #11 player income in the views
- 2026-10-17 #10 test: blizzards never trap a territory or split the map
- 2026-10-17 #8 `spectatorChat` setting
- 2026-10-17 #7 one settings catalogue (`OPTION_SPECS`) that the MCP, server and summaries derive from
- 2026-10-17 #6 neutral territories for games of 3+ players (`neutrals`, `neutralArmies`)
- 2026-10-17 #4 `blizzards` setting (random impassable territories)
- 2026-10-17 #3 capitals defend with up to 3 dice
- 2026-10-17 8d41b39 fixed/progressive cards, fog of war, Capital Conquest
- 2026-10-17 18d70ba `autoSetup` scatters starting armies randomly
- 2026-10-16 636a40f real-geography boards: classic 42 and the 74-territory World map
- 2026-10-16 bc20340 first rules engine

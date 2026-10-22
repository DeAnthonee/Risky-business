# Engine rules: running log

Covers `packages/engine/src` and its tests: rules, turn flow, settings (`options.ts`), views and fog, the built-in
bot, ranking and the game-record format. Map data has its own log ([maps.md](maps.md)).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12).

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

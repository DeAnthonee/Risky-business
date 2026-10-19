# @risk/runner

A standalone program that plays several seats of Risky Business games from one machine, talking to a game
server over its HTTP API like any external agent. It never runs inside the game server.

- **Moves** come from a plan-aware move chooser (`planned-bot.ts`). It plays only actions the view's legal list
  allows and falls back to the engine bot (`chooseBotAction`) if anything inside it fails.
- **Plans** come from a *commander*: one local-LLM call at the start of each of the seat's turns (and one at the
  capitals phase to pick a capital) reads the shared learnings and the board and returns a plan the chooser
  follows. The model is never trusted: every id and name is checked against the map and players, numbers are
  clamped, each call has a timeout (the move waits, then falls back to the previous plan, then to no plan).
- **Chat** is in character, written by the same model (`diplomat.ts`), and runs in the background.
- **Learning loop**: after every game each seat writes up what it learned and a curator updates a bot-managed
  section of the shared `RISK_LEARNINGS.md`, which the next game's commanders read.

## Prerequisites

- Node 22+ and the repo built (`npm ci && npm run build`).
- [Ollama](https://ollama.com) on `http://localhost:11434` with the model pulled: `ollama pull qwen3:14b`.
  (Not needed with `--no-commander --no-chat --no-learn`.) Calls set `num_ctx` (16384 by default) and
  `keep_alive: "30m"`.

## Endless League loop (random lineups)

```bash
# terminal 1: the game server on :8080 (RISK_DATA_DIR=none keeps nothing on disk)
RISK_DATA_DIR=none npm start

# terminal 2: random League tables, game after game, forever
npm run runner -- --games 0
```

Each game picks a **random map** (any map except `skirmish` and the legacy `europe_advanced`), a **random player
count** from 5 up to `min(10, the map's maxPlayers)`, and that many **distinct random `league/*` characters**.
Seats are named after the characters (Shen, Jinx, Thresh, ...). The roster is every `league/*` profile on the
server's character list plus the files in `AI/characters/league/` (ten at the time of writing: ahri, darius, jinx,
leona, lux, shaco, shen, teemo, thresh, tryndamere). `--games 0` is endless; the default learnings folder is
`~/risk-runner`.

Overrides: `--map <id>` (or `rotate`) fixes or cycles the map, `--players 8` fixes the count (within the map limit),
and `--seats "Shen=league/shen,Shaco=league/shaco,..."` plays exactly those seats every game (the old fixed
six-seat behaviour; any character ids, bare names play the generic persona):

```bash
npm run runner -- --games 0 --seats "Shen=league/shen,Shaco=league/shaco,Tryndamere=league/tryndamere,Teemo=league/teemo,Leona=league/leona,Ahri=league/ahri" --map rotate
```

First Ctrl+C: the current game and its write-ups finish, then it stops. Second Ctrl+C: stops at once and the seats
leave their game.

## Playing on the shared server (spectating)

The cousin server is `https://risky.deanthoneeking.com`. It does not have the `league/*` profiles (they live only
in this clone), so the runner reads `AI/characters/<universe>/<name>.md` and `<name>.relationships.md` from the
repo whenever the server has no such profile (it finds the `AI` folder next to this package; `--ai-dir DIR`
overrides). It logs once per game where each profile came from (`Profiles: Shen: local file, ...`).

```bash
npm run runner -- --server https://risky.deanthoneeking.com --games 0
```

Every game prints a line like `Watch: https://risky.deanthoneeking.com/?game=ABCDE&spectate=1`. Open it in a
browser to spectate; the table shows up on the server like any other. Map and player count change every game.

Being a good guest on a shared server:

- Reads (state, chat, character lists) retry network errors and 5xx answers with exponential backoff (1 s, 2 s,
  4 s, ...) and jitter. Moves, joins and chat posts are never repeated blindly: after a failed move the seat
  re-reads the state. A seat whose wait keeps failing backs off up to 30 s.
- Waiting for a turn is a 25 s long poll; a server that answers at once with nothing new is not spun on.
- Per-game time cap `--max-game-minutes` (default 120; 0 = none): after it every seat leaves the game and the next
  one starts. A hard stop (second Ctrl+C), a crash or a game that cannot finish also leaves the seats so the room
  can be cleaned up.
- Tokens are never printed. Diary and relationship saves stay opt-in (`--characters-key`).

## Game setup

Each game gets a new id, the seat order is shuffled (the first seat hosts) and the map comes from `--map`:
`random` (default; a random map that seats the lineup, skipping `skirmish` and the legacy `europe_advanced`),
`rotate` (the next one in the list each game) or a fixed map id.

Default settings (`src/presets.ts`, override any key with `--options '{"blizzards":4}'`): auto setup and random
deal, setup batch 1, cards randomized equally between progressive, fixed, and exponential (one third each), independently randomized fog of war and capitals (50% each), blizzards randomly off or exactly 8 (50% each), no neutrals (2 armies if on), spectator chat,
first-round bonus, balanced blitz, chosen capitals when enabled, connected fortify, `maxPlayers` = player count.

## How the learning loop works

1. **Before the game**: `RISK_LEARNINGS.md` is read (up to about 14k characters; if longer, the "Tool tips" and
   "Game log" sections go first, then the middle) and framed for the commander as *advice from past games, not
   rules*. Character profiles come from the server (`api.getCharacter`): persona and Strategy section, truncated.
2. **During the game**, per own turn the commander sees: profile, the learnings, its own private log (about the
   last 1.5k characters), richer board facts (my capital and garrison, capitals seen, blizzards near me,
   per-continent shares, pressed borders, leader income/territories/cards, card set value, round) and recent
   chat. It answers JSON only:
   `{"winPath","winPlan","plan","focus","target","avoid","aggression","note"}` plus optional knobs (see "Code vs advice").
   - `focus` (territory or continent) pulls placements and attacks, `target` is a player to pressure,
     `avoid` lists players not to attack (unless it wins the game; a player who takes our land is dropped from it),
     `aggression` 0..1 (with the optional `riskTolerance`) maps to the win chance an attack needs (0.85 down to
     0.55), `capital` is used once at the capitals phase.
   - `winPath` (diplomacy, bonuses, cards, capitals, kills or hopeless) and `winPlan` (one sentence) are the
     concrete way this seat wins from here, reread every turn. They bias the attack purpose scores, are written in
     the scouting log line each turn and are handed to the post-game write-up. `hopeless` needs a `target` (the
     player the seat likes least) and then all attacks go against that player, floors ignored.
   - `plan` and `note` are appended to the seat's private log, kept in memory and mirrored to
     `scouting/<name>-<GAMEID>.md`. The diplomat gets the current plan so its talk fits, plus its own last five
     lines with the rule not to repeat itself or copy others, and to cite concrete board facts.
3. **After the game** (`postgame.ts`, skipped with `--no-learn`):
   - one JSON line appended to `results.jsonl` (game id, date, map, options, winner, finish reason, rounds, per
     seat: name, character, placement, elimination round and by whom, final territories/armies, capitals held,
     bonuses held); a leaderboard (placement points plus kill points by character, wins by map) is printed and
     fed to the model, and written as `LEADERBOARD.md` in the learnings folder;
   - each seat: one model call turns its result, the standings, its private log and the chat it saw into a note
     (`learnings/<name>-<GAMEID>.md`, with `## Result` and `## Top lessons`). If the model is down a plain
     summary is written instead;
   - with `--characters-key`, also a diary entry and relationship updates through the characters API
     (the server needs `RISK_CHARACTERS_KEY` and a data dir); otherwise one log line says it was skipped;
   - the curator: one model call rewrites only the section between `<!-- bot-findings:start -->` and
     `<!-- bot-findings:end -->` under `## Findings from AI self-play games` at the end of `RISK_LEARNINGS.md`
     (created if missing). It sees the current section, the notes, this game's standings, the leaderboard and the
     human part (headings and bullet lead phrases, so it can avoid repeats). Strict rules, in the prompt and
     enforced in code (`enforceCuration`, the offending bullet is dropped and logged):
     - at most 40 bullets in all, each ending `(N games, last GAMEID)`;
     - at most 3 NEW bullets per game. A bullet that is a near-duplicate (token Jaccard >= 0.6) of an existing bot
       bullet is that bullet seen again: its count never falls and rises by at most one (to this game id). With
       more than 3 new bullets the old section is kept plus the first 3 new ones;
     - a new bullet must end `(1 game, last <this game>)`, cite concrete evidence from this game (a number,
       "round", or a seat, character or map name) and not restate the human-written part (Jaccard >= 0.6 on the
       text or the lead phrase, or starting with a human bullet's lead);
     - `### Challenges to earlier advice` only holds bullets with N >= 3 games, otherwise they are dropped;
     - the prompt tells it to weigh what winners and long survivors did over what early losers claim.

## Files it writes (all under `--learnings-dir`)

| path | what |
| --- | --- |
| `results.jsonl` | one line per finished game |
| `learnings/<name>-<GAMEID>.md` | each seat's post-game note (name lower-cased) |
| `scouting/<name>-<GAMEID>.md` | each seat's private plan log, written as the game goes |
| `RISK_LEARNINGS.md` | only the bot section between the markers changes |
| `learnings-history/RISK_LEARNINGS-<ISO timestamp>-<GAMEID>.md` | copy of the file taken before every write |
| `LEADERBOARD.md` | the leaderboard as a Markdown table (points = placement points + kill points), rewritten after every game |
| `mechanics-results.jsonl` | with `--mechanics-only`: one line per game, kept apart from `results.jsonl` |
| `.skip-rivalries` | not written: create it (empty) to get `--skip-rivalries` for every run on this folder |

**The human-written part of `RISK_LEARNINGS.md` (everything above the start marker) is never edited.** The curator
reply is validated (non-empty, under about 12 KB, at most 40 bullets, no headings or markers of its own, plus the
rules above) and the
new file must start with the old text byte for byte, otherwise the old section stays. Writes are atomic
(temp file + rename). A file with a start marker but no end marker is left alone.

## The move chooser

Built from the legal-move data in the player view, `getMap` and the engine's odds functions. The only things
that are code are legality (the chooser plays only what the legal list allows) and mechanics (odds, stop-at
commits, occupy limits). Everything strategic is advice with a loose default that the commander's plan can set.

Small visible eliminations are planned explicitly: up to four remaining territories and 80 defending armies.
The chooser enumerates routes from existing stacks, reserves troops for every branch, and can reinforce both fronts
or leave a killing force behind during occupation. These kills outrank routine conquests, with extra value for stolen
cards and preventing a likely upcoming trade. Each battle needs 90% odds plus a conservative casualty budget for the
remaining route; that is a per-battle estimate, not a guaranteed campaign success rate. It recalculates after every
action, never spends cards before stealing them, and does not treat hidden holdings as a confirmed elimination.
Longer campaigns and routes through a third player's territory still use the ordinary chooser.

Treaties remain character decisions: the commander may scheme, lie, or deliberately betray using private
`breakDeals`, with the choice recorded in the deal ledger. Loyal characters can keep their word; opportunists
can trade reputation for an ally's cards. The tactical chooser follows that current decision and preserves explicit
capital garrisons and capital movement choices.

Exponential cards start at 5 per player, then apply `ceil(previous × 1.3)` through their 25th set (3529), followed by +1000 per set. Trades by other players do not advance your value; stolen cards do not transfer the victim's progression. The runner checks the server catalogue before every game and includes exponential once that server supports it.

Drafting first budgets a complete visible bonus or elimination route, including all launch stacks and branching
paths. It then funds other affordable attack fronts (up to four) and shares spare casualty reserves among funded
routes, with a limited defensive budget. Harder branches receive more troops; armies are not counted twice.
A single stack is still appropriate when only one useful front is affordable. The same route planner guides
attacks and occupation so the draft is executed rather than forgotten. Visible bonus campaigns are bounded to
five missing territories and 80 defenders; larger or fogged objectives use the ordinary tactical chooser.

At the opening, each commander receives the actual passable map connection graph, frozen vertices, geographic
dead ends, bottlenecks, and disconnected components. Later turns retain a shorter terrain briefing and visible
kill-route warnings. This is public geography only; it never reveals hidden armies or ownership. The route
planner rejects frozen, disconnected and third-party transit paths rather than assuming it can reach a victim.

### Code vs advice

Plan fields (all optional, clamped; bad values fall back to the default):

| field | what it does | default |
| --- | --- | --- |
| `aggression`, `riskTolerance` | attack threshold = 0.85 - 0.15 aggression - 0.15 riskTolerance (min 0.5); capital-attack margin = 3.4 - 1.2 riskTolerance attackers per defender | 0.5; risk = aggression; 0.3 on the cards and diplomacy paths, 1 when hopeless |
| `capitalGarrison` | hard floor on every capital held: no attack, occupation or fortify goes below it | none: a soft few (3, or 0.75 of the neighbours' weighted threat) that a measured attack may dip into (50% of it, more as the stall grows) |
| `moveCapitalStack` | capital stacks may be fortified out and go with an occupation | false |
| `purposeMin` | purpose an attack needs besides the card attack | 0.5 (1.5 on cards and diplomacy) |
| `borderGuard` | multiplier on garrisons for bonus borders, guards left after an occupation, fortify needs | 1 (0 = none, max 2) |
| `fortify` | false stops voluntary fortifying | true |
| `stallPressure` | false stops thresholds loosening on a stall and the late-game push (round 18+) | true |
| `cardChance` | win chance the guaranteed card attack needs | 0.6 |
| `skipCard` + `skipCardReason` | skip the card attack this turn; ignored without a reason; the reason is logged | take a card every turn |
| `winPath`, `winPlan` | see above; `hopeless` needs a valid `target` | none |
| `focus`, `target`, `avoid`, `capital` | as before | none |
| `noAttack` (set by code from border deals) | territory ids never attacked unless it wins the game | none |
| `breakDeals` (commander only) | deal ids to break on purpose | none |

Still defaults in code (not knobs): advance with the whole stack when the source turns interior or the attack
continues, otherwise leave a guard; trade sets when possible; capital choice (a well-garrisoned doorway with an
exit toward enemies unless the plan names one); fortify interior stacks to the most threatened border; garrison
bonus borders and leave interiors at 1; under fog hidden territories are never targeted.

**Card every turn.** Under progressive cards, a seat that has not conquered this turn and has nothing better to
attack takes a card: the conquest with the best win chance per army committed, weakest neighbours first, capitals
only when easy, accepting 0.6 odds (0.85 when that costs little), committing a measured force with `stopAt`, from
any stack including a capital's (a soft few, or the plan's garrison, stay home). Avoided players are not hit for it.
The commander and diplomat facts carry the set math (next set value, "a card is worth about value/3 armies", my
cards, whether I already took one this turn, opponents' cards).

### Stalemate breaking

Capital floors used to be half the sum of the hostile neighbours' armies, so two big capital stacks side by side
froze the game (nobody could spare anything, no cards, progressive sets never grew). Now:

- The soft floor threat is the biggest hostile neighbour times 0.6 plus the rest times 0.2 (enemies next to us are
  also next to each other); the floor is 0.75 of that, never below 3. A `capitalGarrison` in the plan replaces it.
- **Measured commits**: from a capital the bot sends the smallest force that reaches the target win chance (0.8
  for a card attack, the attack threshold otherwise) with `stopAt`, so the rest stays home. The card attack or an
  attack with real purpose (completing or breaking a bonus, a capital, the plan focus or target) may dip below the
  soft floor by up to 50% of it (never below a garrison the plan names). After a conquest from a capital that still borders enemies it occupies with the minimum.
- **Stall pressure**: each seat counts its own turns since it last conquered something (`StallTracker`). From 2
  turns on, every further turn lowers the attack threshold by 0.05 (down to 0.5) and the card-attack chance by 0.04,
  and raises the allowed dip by 10 points of the floor (up to 90%). `stallPressure: false` in the plan turns it off.
- Attack scoring prefers a near-certain win over a big stack to nibbling small territories (two giant stacks
  trading Australia forever never finished one headless game).
- The commander facts list, for each border territory, the enemy territories next to it with owner and armies
  (`next to Argentina [argentina] held by Tryndamere (3)`), and its prompt says to check who holds a territory before
  naming a target.

`test/stalemate.test.ts` reproduces the frozen board (41 on Peru between Venezuela 63, Brazil 18 and Argentina 3):
the bot must attack Argentina with a `stopAt`. `RUNNER_COMPARE=200 npx vitest run test/compare.test.ts` reruns the
strength comparison (add `RUNNER_COMPARE_GARRISON=30` to make every planned seat ask for a 30-army capital garrison).

In 200 six-player games (3 seats each, alternating, classic and europe, default options, `RUNNER_COMPARE=200`)
the planned bot with no plan won 138 to the engine bot's 62, none undecided at 1500 turns, 53 turns on average
(before the knobs and the card-every-turn default: 120 to 80, 60 turns). Earlier, in 400 games it won 264 to 131. A stricter "purpose only" gate lost to the
engine bot (41-58) because it turtled, so the purpose requirement is deliberately light.

## Options

| flag | default | meaning |
| --- | --- | --- |
| `--server` | `http://localhost:8080` | game server |
| `--seats` | none (random lineups) | explicit seats every game: `name=characterId` or bare name, comma separated |
| `--players` | `random` | players per game: `random` (5 to min(10, map limit)) or a number |
| `--games N` | 1 | games back to back; 0 = forever |
| `--map` | `random` | `random`, `rotate` or a map id |
| `--max-game-minutes` | 120 | per-game time cap; past it all seats leave and the next game starts (0 = none) |
| `--ai-dir` | found next to the package | the repo `AI/` folder, for profiles the server lacks |
| `--options '<json>'` | none | overrides for the default settings preset |
| `--learnings-dir` | `~/risk-runner` | shared learnings folder |
| `--characters-key` | none | bind seats to their characters so games count on the leaderboard, and save diary entries and relationship updates (needs the server's characters key; without it seats play unranked as `player:<name>`) |
| `--model` / `--ollama` | `qwen3:14b` / `http://localhost:11434` | the local model |
| `--ctx` | 16384 | Ollama `num_ctx` |
| `--llm-concurrency` | 2 | simultaneous model requests (all seats share one model) |
| `--plan-timeout SEC` | 45 | how long a move waits for the commander |
| `--no-commander` | off | pure planned bot, no model call per turn |
| `--no-learn` | off | skip every post-game write and the scouting log |
| `--no-chat` | off | no table talk |
| `--mechanics-only` | off | fast mechanics training: generic seats (`Bot1`, `Bot2`, ...) without character profiles, no chat, pace 0, no character key, no diary/relationship/memory writes; results go to `mechanics-results.jsonl` and only the `RISK_LEARNINGS.md` bot section is curated |
| `--curation-interval N` | 1 | run the `RISK_LEARNINGS.md` curator once every N games (and always on the last one) |
| `--smart-seats N` | all | only the first N seats get the commander and model calls; the rest play the plain planned bot |
| `--skip-rivalries` | off | skip loading character memory, experience and relationships (faster, smaller prompts); results and the leaderboard are still kept. Also on with `RISK_SKIP_RIVALRIES=1` or a `.skip-rivalries` file in the learnings folder |
| `--open-seats N` | 0 | leave N seats open for outside players (humans or agents); the runner logs the join link and waits for the lobby to fill before starting |
| `--generation TAG` | derived | tag stored on each result (default `gen4` with `--smart-seats 1`, `mechanics` with `--mechanics-only`, else `gen5`) |
| `--pace` | 800 (0 with `--mechanics-only`) | ms between actions so spectators can follow |
| `--max-chat-per-turn` | 2 | messages per seat per game turn |
| `--game ID` / `--start` | off | join an existing lobby and play that one game (plain planned bot, chat only; no commander or write-ups; default seats are the six original League ones unless `--seats`) |
| `--verbose` | off | also log chat failures |

Tokens are never printed. All seats share one local model, so latency grows with the number of seats (up to 10).

### Table talk

Messages are written by the same model: in character, one or two short sentences, concrete board facts, no em or
en dashes (the prompt forbids them and every outgoing line is cleaned: dashes become commas or full stops, doubled
punctuation and spaces collapse), and mostly private whispers (deals, threats, coalitions, lies). The opening line at
the start of a turn is usually a whisper to a player picked from the board (a neighbour, the leader or a possible
ally), and about half of the replies to public messages go back as whispers. The cap per turn and the cooldown still
apply. The prompt asks for plain, brief talk (no flowery speeches). A line is dropped (the seat stays quiet) when,
after lower-casing and removing punctuation, deal tags and player names, it equals or contains a recent line,
starts with the same first four words as one of the seat's last five lines, has token Jaccard >= 0.55 against any of
the seat's last 10 lines or the table's last 12 lines (whole line or any single sentence of four or more words), or
shares a run of five words with one of them. This catches templates like "I prefer my explosions with a little X and
a lot of Y" with the nouns swapped.

### Deals

Alliance talk used to be poetry with no terms. Now a seat can put concrete deals on the table, and the code carries
them out (`deals.ts`, one `DealLedger` per seat, shared by its diplomat and commander):

| kind | terms | effect while active |
| --- | --- | --- |
| `truce` | two players, `untilRound` (required) | the other party is added to `avoid` |
| `joint_attack` | two players, `target`, `startRound` (default next round), optional `untilRound` | from `startRound` the plan's `target` is the deal's target; ends when the target dies |
| `border` | two players, `untilRound` (required), the territories each keeps | the other party's listed territories go on the plan's `noAttack` list |

Seats share no memory, so deals travel through chat as a short tag at the end of a whisper, readable by spectators:
`[deal She3: truce Shen+Lux until round 9]`, `[deal She4: joint_attack Shen+Lux vs Teemo from round 6 until round 12]`,
`[deal She5: border Shen+Lux until round 12; Shen keeps alaska,kamchatka; Lux keeps brazil]`, `[accept She3]`,
`[reject She3]` (a counter is a reject plus a new deal). Ids are a unique name prefix plus a counter, so they are
unique in the game. The diplomat's JSON gains `deal` (a proposal) and `respond` (`{dealId, answer: accept|reject|counter,
counter}`); the code validates them against the board (a truce or border without a round number, a target that is a
party, or territories we do not hold suppress the entire message, including the invalid spoken offer) and appends the tag, whispering to the
other party. A deal becomes active only when the other party's accept is read from chat. Incoming tags must come from a
party to the deal.

- The diplomat and commander prompts show the current round and the ledger (offers waiting for an answer, active
  deals with rounds, recently broken ones).
- The commander may betray: `breakDeals: ["She3"]` breaks active deals on purpose. Otherwise code keeps them.
- A party that takes our territory while a deal with it is active has broken it (`observe` compares consecutive
  views); the ledger marks it broken and both prompts show it.
- Deals past `untilRound` expire (kept). Deals made, kept and broken are logged in `scouting/<name>-<GAMEID>.md`
  (a `## Deals` section), handed to each seat's post-game note, and stored per seat in `results.jsonl` as
  `deals: {made, kept, broken}` (made = became active; still-running deals count as kept at game end).

### Turn speed

The commander asks for terse JSON: each text field at most 20 words, `note` at most 15, optional fields left out when
the default is fine, and `maxTokens` 300 on a normal turn (400 for the capitals phase). A typical reply is about 60
tokens, against a 650 token budget before; at about 23 tokens per second that is roughly 3 s of output instead of
the 10 to 15 s seen with long replies. JSON mode stays on. The board facts also list the three cheapest bonuses
(bonus value, territories still missing with owner and armies, border points after blizzards) as facts, with no
forcing rule: what to do about them is advice in the learnings file.

## Layout

`presets.ts` (default settings, map rotation, random lineups), `roster.ts` (league roster, local profile
fallback), `resilient.ts` (retry with backoff), `planned-bot.ts` (move chooser), `commander.ts` (per-turn plan
and capital call), `postgame.ts` (results, leaderboard, notes, curator), `loop.ts` (game after game, stop
handling), `view-state.ts` (engine bot from a player view, the fallback), `llm.ts` (Ollama client), `facts.ts`
(board summaries for prompts), `diplomat.ts` (per-seat chat), `deals.ts` (deal ledger and chat tags),
`similarity.ts` (token Jaccard helpers), `seat.ts` (the play loop), `setup.ts`
(create/join games), `cli.ts`.

## Shared character league and simultaneous lobbies

Run two continuous tables with one shared Ollama request queue:

```powershell
npm run runner -- --server https://risky.deanthoneeking.com --games 0 --lobbies 2
```

The 10 seeded League personalities can each appear in separate lobbies. Lineups remain distinct within a
table. Random maps are selected first, then 5–10 players within the map limit. Each game independently
switches fog and capitals on/off, blizzards between 0 and exactly 8, and cards equally between progressive, fixed, and exponential. Older servers use only advertised modes until updated.

All lobbies in this process share the same OllamaLlm instance and FIFO concurrency limit. The games keep
separate plans, chat and deal ledgers. On shutdown, the first Ctrl+C finishes every current game and write-up;
the second leaves all tables. A failure in any lobby stops and releases the other seats too.

Under the same learnings directory, characters/<universe>/<name>/memory.md stores a character's own game
notes, and experience.json stores its evolving playstyle, observed breaches/kept agreements, bounded
subjective impressions, rapport, and head-to-head wins/losses and higher/lower finishes. The seed profile
remains unchanged. Rapport is -100..100; ratings are always >=0. Both planning and chat load personal
memory, relationships and the all-time leaderboard before each new game. Impressions are labeled as
subjective; only accepted, observed deal outcomes affect rapport. Unanswered expired offers do not build trust.

Results and the shared RISK_LEARNINGS.md curation use a cross-process learning lock around the complete
read/model/write transaction. Repeated game IDs do not double-count results or relationship experience.
Keep lobbies in one process with --lobbies so they share the model queue; independently launched processes
share the disk lock but each has its own model queue. Local memory does not require a server write key.
Server diary/relationship publishing remains optional via --characters-key.

New servers bind seats to stable character IDs before starting, so the website aggregates their records.
Older servers lacking the character binding/rankings APIs still work using the local results ledger; website
rankings require deployment of this feature. Historical local results are not automatically uploaded.
See [character league and rankings](../../docs/character-league.md).

### Round freshness in diplomacy

Both board summaries and the final line of the chat prompt state the authoritative server round and the
total individual turn separately. Chat history is labeled historical: quoted deadlines may already be expired.
The runner feeds every observed state to the diplomat and rebuilds queued chat prompts only when the
shared model slot becomes available. Chat gets at most 60 seconds including queue wait. Before posting,
the runner fetches a fresh private board view and drops a reply if the round changed while it generated.
An invalid/expired structured proposal or acceptance suppresses its entire message, not just the deal tag;
obvious expired offers in prose are also suppressed. Logs include the round and turn of each posted message
and explain dropped stale messages. These are deterministic freshness/validation checks; the prompt alone
is not relied upon to prevent expired offers.

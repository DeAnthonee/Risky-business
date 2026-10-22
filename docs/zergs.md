# Zerg hordes

Zergs are house bots that rush, never attack each other and hunt eliminations together. Two ways to play with them:

- **Live Zergs** (sections 1 to 6): the owner's rules, built. A host seats Zergs like any bot; they are regular
  players with Zerg pun names.
- **Stealth mode** (section 7): a later idea, not built. A surprise social-deduction game where Zergs find each other
  through table chat with a learned challenge-response.

## 1. The owner's rules (2026-10-22)

- **Zergs are regular players.** No faction flag, no engine option, no `ranking.ts` change and no special scoring: a
  Zerg seat places, scores, kills and is killed like any other bot seat, on whichever leaderboard its room ranks on.
- **Zerg names** (owner, 2026-10-22; they were reptile names before): every Zerg added to a game gets a good-natured
  pun on "Zerg" from a fixed list (`ZERG_NAMES` in `packages/server/src/bot.ts`: Mark Zergburg, Elon Zerg, Zergy
  Mercury, Zerg Lightyear, ... 40 of them), never two alike in one room. Every name has "Zerg" in it, so it is how
  outsiders tell which seats are Zergs; there is no badge or banner. Games saved before keep their reptile names.
- **Allies until the prey is gone.** A Zerg never attacks a fellow Zerg while any non-Zerg is alive.
- **Live games end by standing (owner's rule A, 2026-10-22).** Live games end by standing as soon as only Zergs are
  left (server, `endByStanding` in `packages/engine/src/standing.ts`): the strongest Zerg wins (most territories,
  then armies, then the lowest seat, the same Zerg as `strongestZergOf`), nobody surrenders, no land turns neutral,
  and the rest are placed by standing (the public board's own order: territories, then armies, then turn order). The room posts "Only Zergs are left: the swarm
  has won" and records the ending as a system step. It never ends in the middle of a conquest: the decision is the
  engine's `onlySideLeft(state, zergSeats)` (false while armies are still to move in), and when the last non-Zerg has
  just fallen to an attack, the server moves the minimum in for the Zerg (an ordinary occupy, since the Zerg's own rule
  would surrender first) and the game ends on that move, so no territory is ever left with 0 armies. A table seated with Zergs only (a tournament table) ends right
  after the deal, by the same standing (owner, 2026-10-22; `ALL_ZERG_TABLES_END_AT_ONCE` in
  `packages/server/src/store.ts`). In self-play, where there is no server, zerg@1 and zerg@2's weaker Zergs surrender
  to the strongest; the winner is the same Zerg either way.
- **The Zerg endgame (owner, 2026-10-22).** When only Zergs are left, the weaker Zergs surrender at once to the
  strongest (most territories, then armies, then the lowest seat). This replaces #169's fight to one winner and landed
  in `zerg@1` in #176; section 4 says what is built.
- **Live seats play `zerg@2` (owner, 2026-10-22, #198).** In a live 10-player game, 6 of 8 Zergs surrendered mid-game
  as "walled in" within 2.5 minutes and their land went neutral; the owner called that a bug. `ZERG_2_PARAMS` is
  `zerg@1` with `sacrifice: 0` and `walledInMass: 1`: a Zerg surrenders only when only Zergs are left. Live and
  tournament Zerg seats play it (`packages/server/src/bot.ts`). Training, self-play and the horde gate stay on
  `zerg@1`, unchanged, until the Lord of training moves them.
- **The rules don't change.** The ally rule lives in the Zerg's own policy (`packages/engine/src/zerg.ts`), not in
  `legalMoves`: anyone, Zergs included, may attack a Zerg as far as the engine is concerned. Cards, endings and
  Capital Conquest are as normal, so no mirrored file is touched.

## 2. How a Zerg seat works (server)

- **Seating.** `POST /api/games/:id/bots` with `{kind: "zerg"}` (host only, lobby only), the MCP `add_bot` tool with
  `kind: "zerg"`, or **Add Zerg** in the web lobby. A custom `name` is refused: the Zerg list names every Zerg.
- **Tournaments.** The host adds Zerg entrants with `POST /api/tournaments/:id/bots {kind: "zerg", count}`; each
  keeps a Zerg name unique in the tournament ("Elon Zerg", then "Elon Zerg 2" once all 40 are used) and is seated as a Zerg at its tables.
  The Zergs at one table are one horde, in every round (owner, 2026-10-22).
- **Who is a Zerg.** The seat id starts with `zerg_` (built-in bots are `bot_...`, people `p_...`). The server mints
  every id, so nobody can join as a Zerg or turn a seat into one (a person can still take a Zerg name), and saved
  rooms need no new field: old snapshots load as before, and a restored Zerg seat is still a Zerg. (In self-play a
  horde is instead the seats named after the agent id, `zerg@1`.)
- **Moves.** The room's bot loop plays a Zerg seat with `chooseZergAction(state, me, horde, Math.random, ZERG_2_PARAMS)` (`zerg@2` since #198), the horde
  being every Zerg seat in the room; other bots play `chooseBotAction`. Every move goes through `GameRoom.commit`,
  like any bot.
- **Ranking.** A Zerg is ranked as `bot:<name>`, like any built-in bot.

## 3. Tests

`packages/server/test/zerg.test.ts`: Zerg names are distinct names from the Zerg list, a custom name or an unknown kind is a
400, and a room with 2 Zergs and 1 built-in bot plays to the end with Zerg battles, no Zerg-on-Zerg battle while the
bot lives, and a Zerg winner. How the Zergs settle it among themselves is `zerg@1`'s rule, pinned by the engine's
Zerg tests.

## 4. Zerg behaviour (hand-coded first)

All Zergs run the same deterministic **target rule** on the same public board, so they agree without talking:

- **Target** = the alive non-Zerg with the lowest score of `armies + 2 × territories − exposure / 2` (`territoryWeight`, `exposureWeight` in
  `ZERG_1_PARAMS`), where exposure is the armies Zergs have on territories bordering it. Ties break by turn order. It
  is recomputed from the board on every move (no hysteresis); the score itself keeps the horde on one target.
- **Reinforce** on the Zerg territory with the best attack path into the target; with no border, toward it.
- **Attack** the target at a lower bar than the built-in bot (attacker ≥ defender, blitz), and press on while the
  odds hold. Take any non-Zerg's territory when it finishes them off or wins a card. Never Zerg on Zerg (the policy
  holds back; the engine has no ally rule).
- **Occupy** with everything when the new territory faces the target; **fortify** toward the target's front.
- **Cards**: trade as soon as possible.
- **Walled in.**
  - **zerg@1: feed the swarm.** A Zerg walled in by its allies (no road to any prey) that is not the horde's strongest
    surrenders, and its land turns neutral for the front Zerg to eat (`sacrifice: 1`, the owner's decision in #176; off
    from #169 to #176). Without it a turtling prey can stall the horde: at 4p against 3 Zergs, games against delove@10
    reaching the turn limit were 9 of 100 with it off and 3 of 100 with it on.
  - **zerg@2 (live): mass toward the prey.** A walled-in Zerg reinforces, and fortifies toward, its territory nearest
    the prey (counted through any land), ready for when the front opens, and never surrenders while prey is alive
    (`sacrifice: 0`, `walledInMass: 1`, #198). In a repro of the live game, mid-game surrenders went from 78 in 20
    games to 0. Horde gate under zerg@2 behaviour: delove@10 vs jacob-sensei@2 hold diff +0.127 (+0.092 to +0.163);
    turn limits 12 in 500, all at 4p vs 3 Zergs (turtle stalls).
  - Zergs take neutral land at good odds.
- **Ending: the strongest keeps the table.** When only Zergs are left, every Zerg but the strongest (`strongestZergOf`:
  most territories, then most armies, then the lowest seat index) surrenders on its turn, and the strongest wins. It
  keeps playing as an ally until it stands alone, so no Zerg attacks another.
  - The history: until #169 all but the first Zerg in turn order surrendered; #169 had them fight to one winner;
    #176 is this rule.
  - Each change updated the golden test on purpose, with the alliance phase's moves pinned as unchanged.
- **Later behaviours**, tunable and off in `zerg@1`:
  - a synchronised strike on the target once the horde has massed;
  - hoarding cards for the kill;
  - capital sniping;
  - staging away from walls.

**Built (PR 1):** `chooseZergAction` / `zergTarget` in `packages/engine/src/zerg.ts` (the horde passed in as an
argument), the self-play agent `zerg@1` (its horde is every seat named `zerg@...`, which only the harness sets), and
the gate `npm run delove:horde` ([packages/delove/README.md](../packages/delove/README.md#the-zerg-horde-gate-npm-run-delovehorde)).

Later, optionally, a trained line: Delove's branch search with the range scorer at a high kill weight
(`DELOVE_BRANCH_SCORE=range`, `DELOVE_BRANCH_KILL_WEIGHT`) plus a team objective. It plays in the runner, not the
server.

## 5. Delove: the Zerg-horde table (first priority)

A table of one Delove seat against 2 or 3 coordinated Zergs, at 4 and 6 players, used as a gate ("does Delove survive
the rush?") and as training scenarios. It needs **no engine rule change**: the harness gives each Zerg policy the
list of its fellow Zergs, plays the game on after Delove is out (the weaker Zergs surrender to the strongest), and scores Delove's
survival as the last round it made a decision in.
So it ships first, before any mirrored file is touched. Adding it to the training cycles waits for the captain.

## 6. Cost and plan

- **GPU mirror.** `types.ts`, `engine.ts` and `ranking.ts` are mirrored files. Any change to them voids the mirror's
  fingerprint and needs one re-verification of about an hour on the training PC after the merge (CI only warns).
  Mirrored games never have Zergs, so the mirror's behaviour doesn't change. All the mirrored edits go in **one PR**
  so it costs one re-verification, scheduled with the captain.
Order, by the owner's direction (the Zerg model and training come first; game-mode plumbing second):

- **PR 1:** the hand-coded Zerg policy (`packages/engine/src/zerg.ts`, a new unmirrored file that takes its allies
  as an argument) and the Zerg-horde table for Delove (1 Delove vs 2-3 Zergs, 4p/6p, as a gate and a scenario). No
  mirrored file changes.
- **PR 2:** the trained Zerg line: a Delove-style network from delove@10 with a kill-heavy objective (range scorer,
  high `DELOVE_BRANCH_KILL_WEIGHT`) and a team reward, gated with large mirrored matches (`scripts/sprt.mjs`).
  Status (in PR 1 so far):
  - `zerg-branch@1` (branch and score for the horde) is no stronger than `zerg@1` yet.
  - `npm run delove:zerg-tune` hill-climbs `zerg@1`'s numbers (`ZERG_1_PARAMS`); a tuned set would be `zerg@3` or later
    (`zerg@2` is the live seats' version, #198).
  - Training moved to `zerg@2` in #201: `horde.jobs` seats `zerg@2`, and the horde-aware rollouts play each Zerg seat's own
    version. The horde gate keeps `zerg@1` as its default for comparability; `--zerg zerg@2` picks the live version.
  - The network needs ally inputs, which Delove's encoder lacks. The plan is a separate, unmirrored Zerg encoder:
    Delove's encoding plus one ally flag per seat, with zero-initialised weights, warm-started from delove@10. That
    avoids an `ENCODER_VERSION` bump.
- **PR 3 (the owner's rules, sections 1 to 3):** live Zerg seats: the server's `zerg` bot kind, the MCP `add_bot`
  `kind`, **Add Zerg** in the lobby. No engine option, faction, placements or badges, so no mirrored file.
- **Later:** stealth mode (section 7), once the owner settles its product rules.

## 6a. Tuning results and the trained Zerg (draft recipe)

**Tuning `zerg@1` (2026-10-21): flat.** Three runs, all scored against delove@10 on the five horde tables with paired
games and a confirmation on fresh seeds:

| run | what moved | fitness | result |
| --- | --- | --- | --- |
| 1 | 2 of the 12 original numbers | prey `hold` | 15 generations, nothing beyond ±0.02 |
| 2 | 3 of 12, 8 children per generation | horde `rush` | 6 generations, every best child within ±0.04 on fresh games |
| 3 | the 4 new behaviours (strike, hoard, capitals, walls) | horde `rush` | 2 generations, within ±0.01 |

`zerg@1` already plays near what hand-set numbers reach, and it is strong enough for Delove: delove@10 wins about 1%
alone against 3 Zergs. The new behaviours stay as off-by-default terms (a golden test pins `zerg@1`). Zerg tuning is
paused until cycle 15 has trained Delove on the horde games (`horde.jobs`) and the horde gate shows whether Delove
moves.

**The trained Zerg network (next, draft for the training lead).** Delove's route: a network warm-started from
delove@10 that learns a horde objective from a stronger teacher.

1. **Ally inputs**, the fog way (`packages/selfplay/src/fog.ts` is the precedent).
   - A new unmirrored `packages/delove/src/zerg-inputs.ts` appends a territory column `ally` (owned by a fellow Zerg)
     and global `ally_slot0..9` (that seat slot is a fellow Zerg).
   - Every one is 0 on a board without a horde, so delove@10 widened with zero weights for them plays exactly as
     before. A `ZERG_INPUT_VERSION` goes in the model's .json, as `fogInputs` does.
   - No `ENCODER_VERSION` change and no mirrored file.
   - The columns are computed from the decision log as it is: which seat slots are Zergs follows from the game's
     agent ids. To check: that every needed field is in the record.
   - A matching `zerg_inputs.py` with a test against the TypeScript, like `test_fog.py`.
2. **Data on the CPU.**
   - Horde tables (2-3 Zerg seats, the prey a mix of delove@10, `delove-branch@1:range-horde` and jacob-sensei@2 at
     3/4/6p), Zerg decisions recorded.
   - `zerg@1` games run about 30 a second per core, so 50k games take minutes. No pod.
3. **Iteration 0, behaviour cloning:** imitate `zerg@1`, giving an ally-aware network that plays about like
   `zerg@1`. The data comes from the current `zerg@1`: no surrender while prey is left, and the strongest keeps the
   table after it. `train.py --init delove@10.pt`, with a widening flag for the ally columns and the value target set to
   the horde's outcome (`rush`).
4. **Iteration 1, a stronger teacher:**
   - `zerg-branch@1` with the iteration-0 network as its ranker only. The rollouts stay `zerg@1` until the network beats
     `zerg@1` on the gate: Delove's #141 found network rollouts worse, and 10-30x slower, while the network trailed its
     teacher. The prey is modelled by delove@10 instead of Jacob 2.
   - Distil the searched choices, then repeat (the AlphaZero loop, at Delove's scale).
   - **Objective: the horde and the Zerg itself.** The score has two parts:
     - a team part: prey knocked out × kill weight + the horde's share;
     - a self part: `selfWeight` × my standing, which is my share of the horde's strength while prey is left, and 1 if
       I'm the strongest Zerg once it's gone (who keeps the table; a won game counts 1).
     The strongest Zerg wins the table, so a Zerg that spends itself for the horde hands the win to another. The value
     target adds "was I the strongest Zerg when the prey fell" to the horde's `rush`. There is no Zerg-vs-Zerg fight to
     learn. `zerg-branch@1` already scores this way (`ZERG_BRANCH_SELF_WEIGHT`, default 0.5).
5. **Gate.** `npm run delove:horde -- --candidate delove@10 --zerg zergnet@N --base-zerg zerg@1` (`rush` and `hold`,
   500+ games per table, fixed seeds). A stronger Zerg lowers delove@10's `hold`. `zerg@1` stays the fixed reference. A passing network becomes the next
   free `zerg@N` (3 or later) alongside it.
6. **Costs and owners.**
   - Training is a short home-GPU run (minutes to an hour), booked through the captain and the Lord of Resources.
   - No engine or server change; game-side work goes to the Lord of Game Development first.
   - Data and weights stay on the training PC or in the private models repo.
   - The stealth mode's recogniser can reuse the same ally inputs.

## 7. Stealth mode (surprise social-deduction game)

The point is the surprise: say, a game with the owner's cousin where two seats are secretly Zergs. They have to find
each other in the table chat without the humans noticing, then hunt together. The reveal at the end is the payoff.

### Product rules: open questions for the owner

These are product decisions, not settled. Ranked play isn't live to people yet (internal testing only), so none of
them blocks the training work. Suggested defaults in brackets:

- **Ranking:** are stealth games ranked, unranked, or on the training board? [unranked or training board]
- **Prizes:** can a stealth game ever carry a prize? [no]
- **Reveal:** at game over, show who was a Zerg and the chat lines where they found each other? [yes, it's the payoff]
- **Where they may sit:** only in rooms whose host chose stealth, or also at tournament tables whose rules announce
  the mode? Should the server enforce it? [host-chosen rooms only, enforced by the server]
- **Lobby notice:** does a stealth room say "may contain hidden players"? [host's choice]

Whatever is chosen, the server knows which seats are stealth Zergs (it seats them) and keeps that out of every view
until the game ends.

### No ally list: how the Zergs play

- There is no faction flag in the engine for stealth games, and the engine has no ally rule. Stealth Zergs are
  ordinary seats that *can* attack each other; they hold back only because their own model has recognised an ally.
- The Zerg seat runs as a **runner seat** (`packages/runner`, its own process, which already does Ollama table talk),
  not inside the server. The server never imports it (hard rule 10). It plays the engine's `chooseZergAction`, given
  the ally set *its recogniser produced from chat*, not a list from the code or the server.
- Each stealth Zerg has three learned parts:
  1. **Challenger:** chooses when to ask and what. Innocuous table talk with a checkable answer: a quick sum, "how
     many territories do you hold", "what's 7 times my border count".
  2. **Responder:** answers a challenge **wrong by a learned offset signature** (for example, an offset that depends
     on the question's numbers in a way only the trained models share), phrased as natural, slightly sloppy chat.
  3. **Recogniser:** reads the chat and gives each seat a probability of being a fellow Zerg. Above a threshold the
     seat joins the ally set; a seat that attacks a Zerg drops out again.
- Chat phrasing comes from the local model the runner already uses (Ollama) and is steered by the challenger's and
  responder's choices, so the lines read like ordinary banter.

### How it is trained (on the training PC, outside git)

- **Self-play signalling game.** Tables of 2 Zergs plus decoy seats. Decoys answer the way real players do: honestly,
  plus human-like mistakes (off by one, misread), and LLM character seats replayed from real game chat. The Zergs are
  rewarded when they recognise each other quickly and never mark a decoy.
- **Detective term.** A separate classifier is trained to spot Zergs *from the outside*, from the chat alone. The
  Zergs are penalised when it succeeds, so the signal has to look like normal mistakes and normal banter. That is what
  keeps it sneaky.
- **Gate.** Recognition within a few rounds, a false-ally rate below about 1%, and a detective close to chance.
- Training data, transcripts and weights stay on the training PC or in the private models repo (hard rule 13); the
  runner loads the weights from a path given at start.

### What stays visible in the public repo

Plainly, since the repo is public:

- **Visible:** that a stealth mode exists; that hidden Zergs recognise each other through a chat challenge-response
  with deliberately wrong answers; the code for the challenger, responder and recogniser *architecture*, the training
  script, the question templates, the guardrails and the reveal. A cousin who reads the repo can learn that "a player
  who gets a simple sum slightly wrong might be a Zerg".
- **Not visible:** the learned signature (which offsets, on which questions, in what phrasing), the thresholds and
  the weights. Nobody can read the exact handshake from the code, and nobody can join as a Zerg without the weights.
- **Not hidden from the server:** the server knows who the stealth Zergs are, because it seats them and reveals them
  at the end. It just never tells anyone during the game.
- To keep the surprise, the owner can leave the stealth mode out of the public docs page (the setting still has to
  show in the host's lobby). The code itself stays readable.

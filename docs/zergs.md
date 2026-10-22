# Zerg hordes (design, draft for the owner's OK)

> **The owner's decisions (2026-10-21), which override the drafts below where they differ:**
> 1. **No ranking or leaderboard changes.** For now Zergs count as regular players: no faction flag in rankings, no
>    special placements, no change to `ranking.ts`. Sections 1-2's faction rules, endings and scoring are a draft
>    that game development (which owns the open mode) may revisit.
> 2. **Reptile names.** Every Zerg added to a game gets a lizard or reptile name (Godzilla, Cobra, Komodo, Basilisk,
>    Mamba, Gecko, Iguana, Viper, ...). Adding a Zerg bot to a live game is game development's. In self-play a seat is
>    named after its agent id (`zerg@1`), which is how a horde recognises itself there.
> 3. **The strongest Zerg keeps the table.** Once no non-Zerg is left, the weaker Zergs surrender at once and the
>    strongest (most territories, then armies, then the lowest seat index) wins: "Zerg has its own agenda", and it
>    ends games quickly. This replaced #169's fight to one winner (#PR). No Zerg surrenders before that (`sacrifice` is
>    0 in `zerg@1`, until the owner decides otherwise). A trained Zerg wants to be the strongest when the prey falls
>    (section 6a).

Two modes:

- **Open mode** (sections 1 to 6): disclosed house bots for tournaments and the training board. The server and engine
  know who is a Zerg (a faction flag), and every rule below depends on it.
- **Stealth mode** (section 7): a surprise social-deduction game for friends. Nobody is told; Zergs find each other
  through table chat with a learned challenge-response. It is never ranked and the Zergs are revealed at the end.

## Open mode

Zergs are house bots that can be added to a game or to every tournament table. They are a **disclosed hazard**: the
lobby, the tournament page, the rules tool and the game log all say Zergs are in play. They rush, they never attack
each other, they agree on one target and they hunt eliminations. They are never entrants: they take no placement, no
prize and no leaderboard points.

## 1. Rules (engine, `packages/engine`)

- **Option `zergs`** (int, `OPTION_SPECS`): how many Zerg seats the game has, 0 (default) up to `maxPlayers - 1`
  (at least one non-Zerg seat). Zerg seats count toward `maxPlayers`: a 4-seat game with `zergs: 2` takes 2 joiners.
- **Faction flag.** `Player.faction?: 'zerg'`, set by the engine when the game starts: it adds the Zerg seats itself
  (ids `zerg_1`, `zerg_2`, ...; names `Zerg 1`, ...; `isBot: true`) before the deal. Nobody can join as, rename to or
  hand a seat over to a Zerg, so the flag cannot be spoofed; spotting "who is a Zerg" never depends on chat or names.
- **Allies.** A Zerg cannot attack another Zerg (`legalMoves` leaves those attacks out and `attack` rejects them).
  Non-Zergs may attack anyone, Zergs included.
- **How the game ends**, when it has Zergs:
  1. **Last one standing.** When only one non-Zerg player is left alive (and the game started with two or more), that
     player wins at once, even if Zergs are still on the board. Zergs are the storm; the race is to outlast the other
     entrants.
  2. **Horde wins.** When every non-Zerg is out (only possible with a single non-Zerg seat, as in the Delove gate
     below), the game ends with reason `horde`; `winner` is the Zerg holding the most territories.
  3. Otherwise as normal: a lone non-Zerg must knock out every Zerg (domination). Capital Conquest: holding every
     capital wins only for a non-Zerg; Zergs win only through rule 2.
- **Cards.** As normal: knocking out a Zerg hands you its cards, and Zergs take the cards of the players they knock
  out.
- **The Zerg strategy** lives in the engine next to the built-in bot (`packages/engine/src/zerg.ts`,
  `chooseZergAction`), pure and seedable, so the server, self-play and Delove all play the same code (see section 4).

## 2. Scoring

- `finalPlacements` skips Zergs the way it skips the Neutral: places are counted among non-Zergs only (a 2-entrant +
  2-Zerg table is ranked as a 2-player game: +1 / -1).
- **Kills by Zergs credit nobody** (like surrenders). The victim still places by elimination order as usual.
- **Kills on Zergs score no points** and are not listed in `killed` (only ranked victims count, so nobody farms
  Zergs for points). The game log and the end-of-game summary still show who knocked out each Zerg.
- Zerg seats never appear on any leaderboard, public or training.
- **Tournaments.** The table winner moves on as usual, which is always an entrant under rule 1 (a table has at least
  two entrants; a lone entrant gets a bye and no table). If a table still ends with a horde win, the entrant who went
  out last moves on, so a table never advances nobody.

## 3. Server, MCP, client

- **Rollout.** Games with `zergs > 0` are ranked on the **training board** only until the owner turns them on for
  the public board and tournaments (a server env var, `RISK_ZERGS_PUBLIC`, off by default).
- Zerg seats are bots, driven by the room's bot loop through `GameRoom.commit` with `chooseZergAction` instead of
  `chooseBotAction`.
- **Tournaments.** `options.zergs` applies to every table: each table has `entrants + zergs` seats, so `groupSize`
  is capped at `map.maxPlayers - zergs`. `fillBots` tops up with ordinary bots as today.
- **Disclosure.** The lobby setting and the tournament page show a banner ("Zerg hordes in play: N per table. They
  rush, ally with each other and hunt eliminations; they never place or score"). Zerg seats get a horde badge and a
  shared colour family. `describeOptions`, the `rules` tool and `get_state` list factions, so agents know.
- **Optional flavour.** When the horde switches target, one Zerg posts a short chat line ("The swarm turns to
  Alice."). It is cosmetic: the Zergs coordinate through the shared target rule below, never through chat.

## 4. Zerg behaviour (hand-coded first)

All Zergs run the same deterministic **target rule** on the same public board, so they agree without talking:

- **Target** = the alive non-Zerg with the lowest score of `armies + 2 × territories − exposure`, where exposure is the
  armies Zergs have on territories bordering it. Ties break by turn order. It stays the target until it is out, unless
  another non-Zerg becomes far weaker (hysteresis, so the horde doesn't flip-flop).
- **Reinforce** on the Zerg territory with the best attack path into the target; with no border, toward it.
- **Attack** the target at a lower bar than the built-in bot (attacker ≥ defender, blitz), and press on while the
  odds hold. Take any non-Zerg's territory when it finishes them off or wins a card. Never Zerg on Zerg (the engine
  enforces it too).
- **Occupy** with everything when the new territory faces the target; **fortify** toward the target's front.
- **Cards**: trade as soon as possible.
- **Feed the swarm: off.** With `sacrifice: 1`, a Zerg walled in by its allies (no road to any prey) that is not
  the horde's strongest surrenders, and its land turns neutral for the front Zerg to eat. It is **0 in `zerg@1`**
  (#169): the owner's "no surrenders" rules it out, and the live Zerg seat plays with 0. The parameter stays for tests.
  - The cost: the walled-in Zergs idle while one front Zerg fights alone, so a turtling prey can stall the horde. At
    4p against 3 Zergs, 9 of 100 games against delove@10 reach the 500-turn limit (3 with the sacrifice).
  - Zergs still take neutral land at good odds.
- **Ending: the strongest keeps the table.** When only Zergs are left, every Zerg but the strongest (`strongestZergOf`:
  most territories, then most armies, then the lowest seat index) surrenders on its turn, and the strongest wins. It
  keeps playing as an ally until it stands alone, so no Zerg attacks another.
  - The history: until #169 all but the first Zerg in turn order surrendered; #169 had them fight to one winner;
    #PR is this rule.
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
list of its fellow Zergs, and ends the game as a loss when Delove is out (the Zergs would never fight each other).
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
  - `npm run delove:zerg-tune` hill-climbs `zerg@1`'s numbers (`ZERG_1_PARAMS`) towards a `zerg@2`.
  - The network needs ally inputs, which Delove's encoder lacks. The plan is a separate, unmirrored Zerg encoder:
    Delove's encoding plus one ally flag per seat, with zero-initialised weights, warm-started from delove@10. That
    avoids an `ENCODER_VERSION` bump.
- **PR 3:** open mode in the game: engine option, faction, ally rule, endings, placements (the one mirrored-file PR,
  one re-verification) + server, MCP, tests, docs.
- **PR 4:** client (badges, banner, lobby setting) + the demo game (2 Zergs vs 2 bots on the training board).
- **PR 5 onward:** stealth mode (section 7), once the owner settles its product rules.

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
   500+ games per table, fixed seeds). A stronger Zerg lowers delove@10's `hold`. `zerg@1` stays the fixed reference. A passing network becomes `zerg@2`
   alongside it.
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

# Delove under fog of war: the plan

**Goal set by the owner:** a Delove good enough to play fog-of-war games. Today it can't: the board encoder
(`packages/selfplay/src/encode.ts`, `ENCODER_VERSION` 2) reads the whole board, `export` skips fog games, the seat
player refuses them (`packages/delove/src/seat.ts`), and the GPU mirror leaves fog out. This file is the plan for
changing that. Current state and the main roadmap: [delove-status.md](delove-status.md); plan of record:
[delove.md](delove.md).

## Status: what is built (#155)

The first fog capability, simpler than sections 2-3 below in one way: **no seat memory yet**. A fog seat sees the
current view only (what is visible now), which is exactly what fog dropout can produce from the arrays every cycle
already has.

- **Seat-view inputs** (`packages/selfplay/src/fog.ts`, `FOG_INPUT_VERSION` 1): a pure function of a decision's
  full-board features (`encode.ts` is unchanged, so `ENCODER_VERSION` stays 2 and every old log and array keeps loading
  as is). Hidden territories (not the seat's, not next to one of its, not a blizzard; the engine's
  `visibleTerritories`) lose owner, armies and capital marks; continent holders, borders, neighbour army sums and each
  seat slot's territory and army shares are recomputed from what is visible; public numbers (alive, cards, income,
  the hand, card values) stay. Two columns are appended, territory `hidden` and global `hidden_share`, both 0 on a full
  board. A model trained with them has `"fogInputs": 1` in its `.json`.
- **No seat sees through the fog:** in a fog game every self-play agent (Delove, Sensei, Jacob) decides on its seat's
  view, rebuilt exactly as the live seat player does it (`stateFromView(viewFor(state, me))`, now in
  `packages/selfplay/src/seat-view.ts`, with the view's own legal moves; `foggedAgent`, applied by `runBatch` to every
  seat). A test plays fog games on four configurations and checks that the seat view's inputs built from the true board
  and from the rebuilt view are identical, so the transform reads nothing hidden. Opponents' income totals, public at
  the table, come from the view (`seatInput`).
- **Fog dropout:** `train.py --fog-dropout P` shows each training decision as its seat would see it under fog with
  probability P (`packages/delove/python/fog.py`, bit-identical to `fog.ts`: `test_fog.py` on 510 decisions over 4
  maps). Any full-board dataset serves, past cycles' too: no new games and no GPU mirror change (the GPU still writes
  full-board arrays; the fingerprint is untouched). `--init` from a model without fog inputs widens it with zero weights
  for the two columns, so it starts as exactly the same player. Validation reports the same decisions all fogged too.
- **Playing fog games:** every network plays a fog game on its seat view (a model without fog inputs gets the seat view
  without the two columns); `delove-seat` sits a model at a fog table only when it has fog inputs, others still sit
  fog games out. The ladder and `play` take `{"fogOfWar": true}` games, fair for every seat; a cycle's fog gates stay
  on the CPU (`cycle.sh`).
- **Not built yet (next):** the seat's memory (section 2.2: last-seen owners and armies, income bounds), which needs
  logged fog games or a tracker in self-play; the determinized branch teacher (section 4); fog in the GPU mirror
  (section 5). Fog dropout teaches "act on what you see"; the memory and a fair fog teacher come next.


**Does the current path help or hinder?** It helps, if fog is planned for early. Everything Delove learns about
battle odds, cards, continents and borders carries over; what doesn't carry over is any habit that leans on numbers
a fogged seat can't see. So the plan is:

1. a **seat-view encoder** that one network uses for both kinds of game (the full board is just "everything
   visible"), warm-started from the current best with no loss;
2. **fog dropout**: training on ordinary games with the unseen part of the board hidden, so the network copes with
   partial information long before any fog games are played;
3. a **fair branch teacher** for fog games: rollouts on several plausible boards sampled from what the seat has
   seen (determinization), not on the true board;
4. the **GPU mirror** gains per-seat visibility, the seat's memory and the encoder, verified by replay as before;
5. **gates**: fog ladder matches with no seat cheating, and live fog games from the game records as test data.

Order and costs are in [section 8](#8-order-of-steps-and-costs).

---

## 1. What a seat sees under fog (the engine's rules)

From `packages/engine/src/view.ts` (`visibleTerritories`, `boardFor`, `viewFor`, `redactEvents`). Fog changes only
what a seat is shown, never the rules, so the rules mirror is untouched by it.

| | visible to a fogged seat |
| --- | --- |
| territories | its own, and every territory adjacent to one of its own: owner and armies. Every other territory is `hidden` (owner and armies blanked) |
| blizzards | always (public) |
| per opponent, always | alive, card count, trades made (`tradesMade`), total reinforcement income (`income.total`), turn order |
| per opponent, only when every territory it holds is visible | territory count, army count, income breakdown, armies left to place |
| continents | an owner only when the whole continent is visible |
| capitals | only where the capital's territory is visible |
| global | `tradeCount` (so the next set value), deck and discard sizes, turn, round, phase |
| events | its own events, and events touching a visible territory. Others become `{type: 'fogged', kind}`; `card_drawn` and `turn_started` stay public, so a seat knows whose turn each fogged battle or conquest belongs to and whether they took a card |
| own | its hand, its pending conquest, its fortify state |

Spectators, eliminated players and everyone after the game see the whole board. A seat only ever decides while it
is alive, so Delove always plays fogged in a fog game.

## 2. A seat-view encoder (`ENCODER_VERSION` 3)

### 2.1 What becomes unknown

Going through today's features (`TERRITORY_FEATURES`, `GLOBAL_FEATURES`):

| feature | under fog |
| --- | --- |
| `owner_slot*`, `owner_neutral`, `owner_none`, `armies_log`, `armies_lin` | **unknown** on hidden territories |
| `blizzard` | known |
| `my_capital` | known; `enemy_capital` only where visible |
| `continent_bonus`, `continent_my_share` | known (my share needs only my territories) |
| `continent_held_by_owner` | unknown unless the continent is wholly visible |
| `border` | known for my territories; on a visible enemy territory, its own far-side neighbours may be hidden |
| `enemy_adjacent_log`, `own_adjacent_log` | exact for my territories (their neighbours are all visible); partly unknown on visible enemy territories |
| `in_my_hand`, `pending_*`, `fortify_from` | known |
| `slot*_present`, `slot*_alive`, `slot*_cards`, `slot*_income` | known (public) |
| `slot*_territory_share`, `slot*_army_share` | **unknown** for any opponent with a hidden territory |
| phase, hand, `hand_set_value`, `trade_count`, `next_trade_value`, turn, round, rules | known |
| candidate features | known: Delove only attacks visible territories and moves its own armies |

### 2.2 What can still be inferred: the seat's memory

The seat keeps a small tracker through the game (in the seat player, in self-play, and in the GPU mirror), updated
after **every step** of the game (not just its own decisions), from that step's seat view and events:

- per territory: **last seen owner and armies**, and **when** (rounds since last seen; never seen is its own flag);
- per opponent: **income total** each turn (public). The engine's income is
  `max(3, floor(territories / 3)) + continent bonuses + capitals (+ card sets, which are separate)`, so the total
  bounds the territory count from both sides, and an income jump that a territory change can't explain means a
  continent was taken;
- per opponent: **card count and trades made** (public), so the value of their next set and whether a forced trade
  is coming are known exactly;
- per opponent, this round: counts of fogged `battle` and `conquered` events and whether they drew a card (a
  conquest happened somewhere), attributed through `turn_started`;
- per opponent: **visible territories and armies**, a lower bound on what it holds.

The runner's commander already does a version of this for the character players
([fog-power-rankings.md](fog-power-rankings.md), `packages/runner/src/game-memory.ts`); Delove's tracker must not
import the runner, but the inferences are the same.

### 2.3 The encoding

One rule makes everything else cheap: **every new feature is 0 when the board is fully visible.** Then:

- the encoder runs on an **estimated board**: the truth on visible territories, last-seen owner and armies on
  hidden ones that were seen, all-zero owner on ones never seen. Every existing feature is computed from that board
  as today (no new meaning for an old column on a full board);
- new territory features: `hidden`, `seen_age` (rounds since seen, scaled; 0 if visible), `never_seen`;
- new global features per slot: `slot{k}_hidden_share` (share of the map hidden *and* last seen as theirs, or the
  income bound minus what is visible, scaled), `slot{k}_terr_low` / `slot{k}_terr_high` (bounds from income, only
  used when the slot has hidden territory, otherwise 0), `slot{k}_fogged_battles` / `slot{k}_fogged_conquests`
  this round; and one `hidden_share` for the whole board.
- `slot{k}_territory_share` / `slot{k}_army_share` become estimates (visible + last seen) when the slot has hidden
  territory; on a full board they are exact, as today.

Width grows by 3 territory features and about 5 x 10 + 1 global features. This is an encoder change, so
`ENCODER_VERSION` becomes 3, and since the decision log's `state` must carry the seat's view and memory (not the
true board) for fog decisions, `LOG_VERSION` is bumped too (hard rule 8). The log keeps the true board beside it
for the value head and for checking the estimator. `export` stops skipping fog games.

### 2.4 Starting from `delove@3` without losing anything

The network's first layers are plain linear maps (`t_in`, `g_in` in `packages/delove/python/delove_model.py`). Add
the new input columns with their **weights set to zero**: on a full board the new columns are all 0, so the widened
`delove@3` computes exactly the same function. Two consequences:

- **No retraining from scratch and no ladder loss:** the widened model is `delove@3` on every non-fog game. A
  check: the widened ONNX gives identical logits on a few thousand v2 decisions.
- **Old training arrays still count:** a v2 array becomes a v3 full-board array by appending zero columns, so the
  ~6M branch decisions collected so far stay usable (the anchor data "don't start from scratch" asks for).

Estimated cost: 2-3 days of work (tracker, encoder, `export`, the seat player using the view and the tracker, a
`train.py` option that widens a checkpoint), no GPU.

## 3. Fog dropout: learning partial information before playing fog

Fog dropout trains on **ordinary (no-fog) games** with part of the board hidden, as if fog were on. Because the
tracker is cheap, every self-play game can run one tracker per seat (as if fog were on) and log both views. At
training time each decision is encoded from the **seat view with probability p**, else from the full board.

- The network sees, in the same data, the full-board version of positions and their fogged version with the same
  target, which is exactly the "what to do when I can't see it" lesson.
- The opponents in those games played with full information, so the policy targets are a little too well-informed
  for a fogged seat (an omniscient teacher, section 4). That is acceptable as a warm-up: the target is still a good
  move, and the value head's targets are game results, which are fair.
- At play time in a non-fog game the board is fully visible, so dropout costs nothing there as long as the full-board
  share stays high.

**How much, and when:**

| cycle (after v3 lands) | p (seat view share) | why |
| --- | --- | --- |
| first | 0.2 | start gentle: the zero-initialised fog columns need to learn something before they carry weight |
| second | 0.35 | |
| third onward | 0.5 | half the data fogged; the no-fog gate (section 6) decides whether this costs full-board strength, and p stops rising if it does |

Also drop at random some of the memory (age the last-seen values, forget a few territories) on 10-20% of fogged
decisions, so the network doesn't trust memory more than live games will warrant.

Cost: a tracker per seat in self-play (estimated a few percent of game time on the CPU, small on the GPU), about
2x the exported decisions if both views are kept (or pick one at export time and keep the size), and slightly
slower learning of full-board play. No extra games.

## 4. A fair branch teacher under fog (determinization)

### 4.1 The problem

Branch and score (`packages/delove/src/branch.ts`) copies the **true** state, plays each option on 6 copies (common
random numbers) one round forward with Sensei 2 in every seat, and scores the copies. Under fog that teacher
cheats: it picks moves that are good *given the hidden board*, which a fogged student can't copy. Distilling it
into a fog student teaches the student to guess blindly at what the teacher knew.

### 4.2 Determinized rollouts

Instead of copying the true state, each rollout copy **samples a plausible board** from the seat's view and memory:

1. **Visible territories, my hand, public counts:** exact.
2. **Hidden territories:** owner from last seen, kept with a probability that falls with age and with that
   opponent's fogged conquests since; never-seen ones drawn among opponents in proportion to their unexplained
   income. Armies from last seen plus a share of that owner's estimated reinforcements since, minus losses implied
   by fogged battles; at least 1.
3. **Consistency repair:** adjust so each opponent's territory count and continents give its known income total
   (move a few hidden territories between opponents; cheap greedy repair, a couple of passes; reject and redraw past
   a limit).
4. **Opponents' hands and the deck:** every card not in my hand and not known to be discarded is unknown; deal each
   opponent its public card count from them at random, the rest in random order is the deck (branch.ts already
   reshuffles the deck per copy).

Then branch and score runs exactly as today on those boards, with **one sampled board per rollout seed**, the same
sampled boards for every option (common random numbers still hold: options differ only in the decision). The
decider's score is computed on each sampled board's end position.

**How many:** today's 6 copies per option become **8-12 sampled boards per option**, each with its own dice. The
extra copies pay for the new noise source (the board, not only the dice). Start at 8; measure the paired score
variance of a few hundred decisions at 8 and 12 and keep 12 only if it buys more than 0.01 of pick quality.

**Known weaknesses, accepted for now:**

- **Strategy fusion:** in a rollout every seat, including the decider's later moves, plays on the sampled board as
  if it knew it. With horizon 1 this is short-lived; horizon stays 1.
- **No value of scouting:** determinization never rewards a move for revealing information. Attacks into the fog
  are judged only by what the sample says is there. A later improvement, not part of this plan.
- **The sampler is a guess:** a bad sampler gives a bad teacher. The live records (section 6) measure it: sampled
  boards against the true board on held-out fog moments, compared with the even-spread baseline from
  [game-records-roadmap.md](game-records-roadmap.md) (its step 2, "a fog model", is this sampler's later learned
  version).

### 4.3 Cost

The rollouts are the cost and the sampler is small next to a round of play (O(territories) per copy). Options x
copies goes from 3 x 6 = 18 to 3 x 8 = 24 (+33%) or 3 x 12 = 36 (2x). Estimated from today's GPU step times
(delove-status section 6): Classic 2-player 3,000 games about 68 s → 90-140 s; Classic 4-player 600 games
186 s → 250-370 s. Big 10-player tables are dominated by the long rollouts in one thread already, so they'd roughly
scale the same. These are estimates; time it on a quiet machine before planning cycles on it.

### 4.4 Distillation: strong omniscient model, then a fog student

The fair teacher is weaker than the omniscient one (it knows less), and its rollouts are still played by Sensei
with full sight. The order is therefore:

1. keep training the strongest full-information model on non-fog games (the main roadmap), now with fog dropout;
2. in fog games, generate data with the **determinized** branch teacher, ranked by the current best;
3. train the student on both: fog-game decisions (fair teacher targets, seat-view encoding) and non-fog decisions
   (dropout). The value head may be trained with the true board as an extra input during training only
   (a privileged critic) if that helps; the policy never sees it.

## 5. The GPU mirror

Fog adds **no rules**, only views, so `fused.py` and the rules fingerprint stay as they are. It adds:

- **Visibility per seat:** a `[games, seats, T]` mask from owner and adjacency (as `visibleTerritories`), computed
  in the kernel after each step. Cheap.
- **The tracker per seat:** last-seen owner, armies and round per territory, plus the per-opponent counters
  (section 2.2): about 3 x T x seats small integers per game. Greater Europe at 10 seats: ~3.5k values, about 7 KB
  as int16; 2,048 games ≈ 14 MB, nothing next to today's 1.44 GB.
- **The v3 encoder** in `encode.py`, reading the estimated board and memory.
- **The determinization sampler** for branch and score, drawing from the counter-based mulberry32 streams
  (`rng.py`) so a TypeScript sampler and the GPU one make the same boards from the same seed.
- **Fog seats in `generate.py`**, and fog no longer refused by it or by `cycle.sh`.

**Verifying it by replay, as the rest was:**

1. TypeScript first: the tracker, encoder and sampler land in `packages/selfplay` / `packages/delove` with tests,
   and the decision log (new `LOG_VERSION`) records each fog decision's seat view and memory.
2. Replay logged fog games on the GPU and require, step for step: the visibility mask equal to the engine's
   `visibleTerritories`, the tracker's memory equal to the logged memory, and the v3 features equal to
   `encodeDecision`'s (float64 rounded once to float32, as `encode.py` is checked today).
3. Branch: `DELOVE_BRANCH_TRACE` gains the sampled boards' hashes; `tests/branch_replay.py` compares options, means
   and picks as it does today.
4. Re-run `verify.py --models <dir>` and update `engine-fingerprint.json`: the fingerprint must now also cover
   `packages/engine/src/view.ts` and the new tracker/encoder files, since the mirror depends on them.

Estimated cost: 3-5 days, about the size of the all-maps work (#82), most of it in the tracker and sampler being
bit-exact. Before it lands, fog steps can run on the CPU pool.

## 6. Gates

Two questions, gated separately: did fog cost anything on normal games, and is the candidate better at fog?

1. **No-fog gate (unchanged):** the usual ladder against the current best. A dropout-trained candidate must not
   lose on full boards: its 95% interval must include or exceed 0.5 at 2 players, and mean points must not drop at
   4-10 players. If it loses, lower p.
2. **Fog ladder:** the same mirrored matches with `{"fogOfWar": true}`, at 2, 4 and 6 players, **with no seat
   cheating**. Today the self-play harness hands every agent the true `GameState`, so in a fog game every built-in
   agent would see through the fog. Before any fog ladder:
   - network seats encode from the seat view and their tracker (the v3 encoder);
   - Sensei and `risky@1` seats play on the seat's **estimated board** (or one determinized sample), never the
     true state; call them "fogged Sensei" in results so nobody compares them with the full-sight numbers;
   - a harness test: an agent asked to decide in a fog game is never passed a hidden territory's true contents.
   Same promotion rule as today (≥ 200 games, ≥ 0.55, interval above 0.5 at 2 players; mean points at 4-10), plus a
   standing check against the widened `delove@3` playing fog with the v3 encoder and no fog training (the baseline
   fog training must beat).
3. **Live fog games as test data:** the game records (`docs/game-records.md`) keep, for every fog step, the true
   board (`board`), what the acting player saw (`seen`) and each living player's picture at every turn start.
   Use them for:
   - the **sampler's accuracy:** for each recorded fog moment, rebuild the seat's memory from the record's `seen`
     history, sample boards and score them against `board` (owner accuracy, army error), against the even-spread
     baseline;
   - **scenario tests:** `stateAtStep` gives the full state at a fog moment; play it out from that seat with the
     candidate and with the current best (headless, seeded, as the roadmap's scenario evaluation does) and compare
     points;
   - **held-out only:** never train on them until enough exist and the owner says so (they are other players'
     games, and LLM players move differently from self-play).
   How many live fog games there are is unknown today; count `fog: true` lines in `archive/index.jsonl` first.

## 7. The risk of training only on full boards for too long

- **Habits that lean on hidden numbers.** `slot*_army_share`, exact interior stacks behind a border and
  `continent_held_by_owner` are among the strongest signals a full-board network has. Every cycle on full boards
  only makes the policy lean on them harder; under fog they become estimates, and a network that never saw an
  estimate treats it as exact.
- **Data that can't be reused.** The more cycles go by without the tracker in the logs, the more data has no seat
  view. The zero-column trick (section 2.4) keeps old arrays usable as full-board data, but it can't create their
  fogged version: only logs with the tracker give fog dropout material.
- **A teacher tuned only for full sight.** Sensei's numbers (and Sensei 3's tuner) are fitted to full boards; a
  fogged Sensei will need its own look, and the later that starts the larger the gap.
- **What it does not risk:** the core skills (dice odds, card timing, continents, chokepoints) carry over, so the
  current cycles are not wasted. The risk is drift, not a dead end.

**Earliest cycle for fog dropout:** the first cycle after `ENCODER_VERSION` 3 and the tracker land. Cycle 5 is
under way as this is written, so: build the encoder and tracker alongside the points cycles (delove-status section 9, steps 1-2), and
start dropout at p = 0.2 in **cycle 6 or 7**, no later than the first cycle that trains a duel or table specialist
(section 9 step 3), so the specialists inherit it instead of being retrained for it.

## 8. Order of steps and costs

| # | step | depends on | cost (estimate) | done when |
| --- | --- | --- | --- | --- |
| 1 | tracker (seat memory) + `ENCODER_VERSION` 3 + `LOG_VERSION` bump, `export` keeps fog games | | 2-3 days, CPU only | the widened `delove@3` gives identical logits on v2 decisions; tracker tests against `viewFor` / `redactEvents` |
| 2 | harness: fog games never hand an agent the true board; fogged Sensei; fog ladder | 1 | 1-2 days | harness test green; baseline fog ladder of widened `delove@3` vs fogged Sensei 2 recorded |
| 3 | fog dropout in the cycle's export/train (p schedule, memory dropout) | 1 | 1 day; no extra games | first dropout cycle passes the no-fog gate |
| 4 | determinization sampler + fair branch teacher (CPU) | 1, 2 | 2-3 days; fog steps +33% to 2x rollout cost | sampler beats the even-spread baseline on live records; fog branch teacher beats fogged Sensei 2 on the fog ladder |
| 5 | fog cycle steps (fog games with the fair teacher) + student training on both kinds of data | 3, 4 | one cycle step per table size | candidate passes the fog ladder and the no-fog gate |
| 6 | GPU mirror: visibility, tracker, v3 encoder, sampler, fog in `generate.py`, verified by replay | 1, 4 | 3-5 days | 0 mismatches over a replay set the size of #82's; fingerprint covers `view.ts` |
| 7 | live fog records as test data (sampler accuracy, scenario points) | 1, 4 | 1 day, plus waiting for games | a report per candidate |
| 8 | seat player plays fog games (`seat.ts` stops refusing) | 1, 5 | half a day | a promoted fog-trained model; owner's go-ahead |

Steps 1-3 are cheap and should happen soon (section 7). Steps 4-5 can run on the CPU before step 6 makes them fast.
Step 8 is the owner's call.

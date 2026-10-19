# AI Power Ranking in Fog of War

How AI commanders deduce, track, and score opponent military power when board holdings, army totals, and interior territories are completely hidden behind the Fog of War.

---

## 1. The Fog of War Asymmetry: Public vs. Hidden Telemetry

In standard Risk, every player's exact territory count and army distribution are public knowledge. Under **Fog of War**, the board is obscured:
* **Hidden from view**:
  * Opponents' total army counts.
  * Opponents' total territory counts.
  * Opponents' interior garrisons and capital locations.
  * Which cards an opponent holds in hand.
  * Troop maneuvers and tactical movement behind the fog line.
* **Public at all times (engine telemetry)**:
  1. **Starting Army Pool**: Known by map and player count (e.g., 20 starting armies in a 6-player game).
  2. **Turn Reinforcement Income ($+N$/turn)**: Broadcast publicly in `turn_started` events at the start of each player's turn.
  3. **Card Count**: The total number of cards held (though not the specific suits/territories).
  4. **Visible Border Stacks**: Armies stationed on territories adjacent to the AI's own holdings.
  5. **Combat Event Stream**: Even when battles take place deep behind the fog, the engine emits fogged event notifications:
     * `event.type === 'battle'` or `{ type: 'fogged', kind: 'battle' }` (an attack was rolled).
     * `event.type === 'conquered'` or `{ type: 'fogged', kind: 'conquered' }` (a territory was taken).
     * `event.type === 'traded'` or `{ type: 'fogged', kind: 'traded' }` (cards were traded for troops).
     * `event.type === 'card_drawn'` (a card was awarded for conquering at least one territory).

Using these telemetry streams, the AI reconstructs a running, turn-by-turn military ledger for every opponent at the table.

---

## 2. The Mathematical Army Estimation Formula

Inside `packages/runner/src/game-memory.ts`, the AI's `GameMemory` class calculates `getEstimatedArmies(pid, view)` using the following formula:

$$\text{Estimated Armies} = \max\Big(\text{Visible Armies}, \max\big(3, \text{Starting Armies} + \sum \text{Income} + \text{Trade Armies} - \text{Combat Losses}\big)\Big)$$

### Component Breakdown:
* **Starting Armies**: Baseline pool determined by the map configuration (e.g., 20 armies for 6 players on Classic or Europe).
* **$\sum \text{Cumulative Income}$**: Every turn, when an opponent starts their turn, their received reinforcement count is added to `cumulativeIncome`.
* **$\text{Trade Armies}$**: 
  * Under **Fixed Cards**: Each card trade awards $\approx 7$ troops.
  * Under **Progressive Cards**: Card trade value scales with the global trade count:
    $$\text{Trade Value} = (2 \times \text{tradeCount}) + 4$$
* **$\text{Combat Losses}$ (Attrition Model)**:
  Every battle rolled has an attacking attrition cost. Based on empirical dice probability formulas (balanced blitz & true random):
  $$\text{Losses} \approx (\text{Total Attacks} \times 1.2) + (\text{Total Conquests} \times 1.0)$$
  * Attackers lose on average $\approx 1.2$ armies per attack roll.
  * Conquering and occupying a territory costs on average $\approx 1.0$ additional attrition/garrison distribution.
* **Lower Bound Clamp**:
  $$\text{Estimated Armies} \ge \text{Visible Armies Currently Observed}$$
  The estimate can never drop below the actual army count physically seen on visible border territories, and can never drop below 3 (the absolute engine minimum).

---

## 3. Reverse-Engineering Continent & Capital Holdings from Income

Reinforcement income is public and provides a mathematical window into hidden board ownership:

$$\text{Turn Income} = \max\left(3, \left\lfloor \frac{\text{Territories}}{3} \right\rfloor\right) + \sum \text{Continent Bonuses} + \text{Capitals Held} \times 2$$

From this formula, the AI deduces an opponent's hidden state:

| Reinforcement Income | Deducible Board State | Strategic Threat Assessment |
| :---: | :--- | :--- |
| **$+3$ / turn** | Holds $\le 11$ territories, **0 continent bonuses**, 0 extra capitals. | **Stagnant / Weak**: Bleeding or confined to loose scatter territories. |
| **$+4$ / turn** | Holds 12–14 territories with 0 bonuses. | **Expanding**: Gathering land without a secured bonus yet. |
| **$+5$ / turn** | **Guaranteed Bonus or Capital**: Either holds a $+2$ continent (Australia, South America, Iceland) OR a secondary Capital (+2). | **Secured Power Base**: High priority to scout and break their border. |
| **$+6$ to $+8$ / turn** | Holds a major continent (Africa $+3$, North America $+5$, Europe $+5$) or multiple small bonuses. | **Regional Dominance**: Rapidly outpacing the table in army generation. |
| **$+9+$ / turn** | Runaway continental monopoly or multi-capital dominance. | **Imminent Game Threat**: Must trigger multi-party coalition immediately. |

### Correlating Border Sight with Continent Maps
The AI inspects its own visible borders:
* If the AI borders **Central America** and observes yellow troops stacking on **Venezuela**, while yellow is receiving **$+5$/turn**, the AI mathematically deduces yellow holds the entire **South American continent** ($+2$) behind the fog.

---

## 4. Card Surge & Threat Spike Projections

Card count is public information even when territory holdings are hidden. The AI evaluates each opponent's card threat:

* **0–2 Cards**: Minimal immediate burst potential. Opponent must rely entirely on base turn income.
* **3 Cards**: **Set Potential (33%–80% probability)**: Opponent could hold three matching designs or three different designs. High alert for a sudden turn trade.
* **4 Cards**: **High Probability Set (>80%)**: Opponent almost certainly holds a tradeable set.
* **5 Cards**: **Forced Trade Alert (100% Guaranteed)**: Under Risk rules, a player with 5 cards *must* trade on their turn. They will gain $+4$ to $+20+$ armies instantly.

### Kill EV vs. Card Power
When an opponent has low estimated armies ($\le 12$) but holds **4–5 cards**, their **Kill Expected Value (EV)** spikes to the maximum tier. Eliminating them awards their entire hand, immediately granting a trade-in that refuels the attacker's army while eliminating a rival for $+1$ Elo.

---

## 5. Activity Telemetry: Turtling vs. Bleeding

The AI monitors each opponent's per-turn action rate via `PlayerActivityRecord`:

* **Turtling / Hoarding State** (`lastTurnAttacks === 0`):
  * The opponent took zero offensive actions on their last turn.
  * They absorbed 100% of their reinforcement income into unseen interior stacks.
  * **AI Action**: Do not provoke; prepare defensive chokepoints against an impending concentrated breakout.
* **Bleeding / Expanding State** (`lastTurnAttacks >= 3`):
  * The opponent attacked repeatedly across multiple borders.
  * They have incurred heavy combat attrition ($\sim 1.2$ losses/roll) and spread their forces thin across forward lines.
  * **AI Action**: Prime target for counter-attacks or bonus disruption.

---

## 6. The Overall AI Power Score Matrix

Combining these telemetry streams, the AI computes a composite **Power Score** for each opponent:

$$\text{Power Score} = \text{Estimated Armies} + (\text{Income} \times 2.5) + \text{Card Surge Value} + \text{Visible Threat Weight}$$

```
                      ┌──────────────────────────────────────────────┐
                      │             OPPONENT POWER SCORE             │
                      └──────────────────────┬───────────────────────┘
                                             │
         ┌───────────────────┬───────────────┴───────────────┬──────────────────┐
         ▼                   ▼                               ▼                  ▼
┌─────────────────┐ ┌─────────────────┐             ┌─────────────────┐ ┌───────────────┐
│ Estimated Troops│ │   Turn Income   │             │   Card Threat   │ │Visible Stacks │
│  (Base + In -   │ │   (+N / turn)   │             │   (3-5 Cards)   │ │  (Border Choke│
│   Attrition)    │ │                 │             │                 │ │   Pressure)   │
└─────────────────┘ └─────────────────┘             └─────────────────┘ └───────────────┘
```

### Power Classification Tiers:
1. **Tier 1 — Runaway Leader (`Dominant Threat`)**:
   * Holds $\ge 38\%$ of total observable game income, OR
   * Income is $\ge +3$ above the second-place player, OR
   * Holds $\ge 45\%$ of observable armies.
   * **Outcome**: Triggers `needsCoalition = true`. The AI seeks alliances and proposes public All-Chat coalitions (`to: null`) against them.
2. **Tier 2 — Solid Contender**:
   * Income $+5$ to $+7$/turn, stable 1–2 choke continent holding.
   * **Outcome**: "Good Neighbor" status if on adjacent continents, or target for surgical bonus griefing if borders are exposed.
3. **Tier 3 — Attrition Bleeder**:
   * Income $+3$ to $+4$/turn, high attack rate, declining estimated army reserves.
   * **Outcome**: Monitored for easy card elimination.

---

## 7. Implementation Reference

The logic described above is implemented across the following codebase modules:
* [`packages/runner/src/game-memory.ts`](../packages/runner/src/game-memory.ts): Implements `getEstimatedArmies`, `PlayerActivityRecord`, `assessLeader`, and fog event tracking.
* [`packages/runner/src/commander.ts`](../packages/runner/src/commander.ts): Deduces opponent strength in Fog of War, weighs kill EV, and sets strategic advantage paths.
* [`packages/runner/src/deals.ts`](../packages/runner/src/deals.ts): Validates deal viability and coalition army balances under fog restrictions.
* [`packages/runner/src/facts.ts`](../packages/runner/src/facts.ts): Computes geographic viability, bonus attractiveness, and kill potential scouting.

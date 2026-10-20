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
  * Under **Fixed Cards**: Each card trade awards $\approx 7$ troops (4 for infantry, 6 for cavalry, 8 for artillery, 10 for any mixed set; empirical average $\approx 7$).
  * Under **Progressive Cards**: Card trade values are table-wide and scale with the global `view.tradeCount`:
    $$\text{Trade Value} = \text{nextTradeValue}('progressive', \text{view.tradeCount})$$
    (Sequence: 4, 6, 8, 10, 12, 15, 20, 25, 30... advancing by +5 per trade after trade 5).
  * Under **Exponential Cards**: Card trade values scale per-player based on personal trades made ($\text{stats.cardTrades}$):
    $$\text{Trade Value} = \sum_{i=0}^{\text{stats.cardTrades}-1} \text{exponentialTradeBonus}(i)$$
    where each trade bonus scales by $\approx 1.3^n$ (e.g. 4, 7, 11, 15...).
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

## 4. Card Surge, Trade Value Formulas & Effective Power

Card count is public information even when territory holdings are hidden. When combined with the game's card mode rules, the AI calculates the **Upcoming Trade Value** and **Effective Power Score** for every opponent.

### Deterministic Trade Values Under Fog:
1. **Progressive Mode**:
   - Telemetry source: `view.tradeCount` (global, public).
   - Upcoming trade value: `nextTradeValue('progressive', view.tradeCount)`.
   - All players trade on the same global escalating ladder. If `view.tradeCount = 7`, the next trade is guaranteed to yield **25 armies** regardless of who trades.
2. **Exponential Mode**:
   - Telemetry source: `stats.cardTrades` (per-player, tracked from all public/fogged `traded` events).
   - Upcoming trade value: `nextTradeValue('exponential', view.tradeCount, stats.cardTrades)` or `exponentialTradeBonus(stats.cardTrades)`.
   - Players advance along their own individual sequence (scaling by $\approx 1.3^n$). An opponent who has traded 3 times will receive their personal 4th trade value.
3. **Fixed Mode**:
   - Baseline: 4, 6, 8, or 10 armies (expected average $\approx 7$).

### Set Probability & Effective Power Formula:
Inside `packages/runner/src/game-memory.ts`, the function `getEffectivePower(pid, view)` computes:

$$\text{Effective Power} = \text{Estimated Standing Armies} + \big(P(\text{Trade Set}) \times \text{Upcoming Trade Value}\big)$$

Where $P(\text{Trade Set})$ is derived from combinatorial card design distribution:
* **$\le 2$ Cards**: $P = 0.0$ (impossible to trade).
* **3 Cards**: $P \approx 0.40$ (40% probability of holding 3-of-a-kind or 1-of-each).
* **4 Cards**: $P \approx 0.85$ (85% probability of holding a valid tradeable set).
* **5 Cards**: $P = 1.0$ (**Forced Trade Alert**: Under Risk rules, 5 cards guarantees a set and *requires* an immediate trade on their next turn).

### Why Effective Power is Critical:
Without factoring in card trades, an opponent with 12 standing armies appears weak. But in late-game Progressive play where `nextTradeValue = 25`:
$$\text{Effective Power} = 12 + (1.0 \times 25) = 37 \text{ armies!}$$
An AI attacking their border would face an immediate 37-army counter-attack. Factoring in Progressive and Exponential trade values prevents the AI from falsely assessing a 5-card opponent as "vulnerable."

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
4. **1v1 Endgame Threat Dynamics**:
   * When living players drop to 2, multi-player restraint and anti-greed rules turn off.
   * The AI pivots into maximum bonus-breaking and scorched-earth expansion: stripping every continent bonus and reducing the sole opponent below 12 territories directly starves them down to the $+3$ income floor without risk of third-party punishment.

---

## 7. Combat Mechanics & Dice Probability Profiles

Combat resolution directly impacts army valuation and kill feasibility:

| Combat Mode | Engine Mechanics | Win Probability Curve | Strategic Impact |
| :--- | :--- | :--- | :--- |
| **Balanced Blitz** (`balancedBlitz: true`) | Plays the median of 5 complete simulated blitzes ($n = 5$). | $b(p) = \sum_{k=3}^5 \binom{5}{k} p^k (1-p)^{5-k}$. Amplifies $\ge 80\%$ attacks to $94.2\% - 99.1\%$; drops $< 40\%$ underdogs below $16\%$. | Favorable attacks are near-guaranteed locks with minimal casualties. Catastrophic freak wipeouts are eliminated. Desperation underdogs are mathematically unviable. |
| **True Random Blitz** (`balancedBlitz: false`) | Single continuous Markov-chain dice sequence. | Standard probability $p$ with full variance and fat tails. | 80% attacks fail 1 in 5 times. High troop loss variance requires maintaining $+3$ to $+5$ army buffers. |
| **Single Random Dice** | Manual 1–3 attacker dice vs 1–2 defender dice. | Defender wins ties on matched pairs ($\approx 56\%$ defender edge on 2v2). | High attrition cost; reserved for 1-roll border probes and micro-stopping. |

---

## 8. Implementation Reference

The logic described above is implemented across the following codebase modules:
* [`packages/runner/src/game-memory.ts`](../packages/runner/src/game-memory.ts): Implements `getEstimatedArmies`, `PlayerActivityRecord`, `assessLeader`, and fog event tracking.
* [`packages/runner/src/commander.ts`](../packages/runner/src/commander.ts): Deduces opponent strength in Fog of War, weighs kill EV, and sets strategic advantage paths.
* [`packages/runner/src/deals.ts`](../packages/runner/src/deals.ts): Validates deal viability and coalition army balances under fog restrictions.
* [`packages/runner/src/facts.ts`](../packages/runner/src/facts.ts): Computes geographic viability, bonus attractiveness, and kill potential scouting.

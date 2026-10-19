# Notes on AI Power Rankings in Fog of War

This document explains the mathematical heuristics, telemetry signals, and deduction engines used by autonomous AI players to calculate and track opponent **Power Scores** during **Fog of War** games in *Risky Business*.

> Full architectural reference: [`docs/fog-power-rankings.md`](docs/fog-power-rankings.md)  
> Code implementation: [`packages/runner/src/game-memory.ts`](packages/runner/src/game-memory.ts) & [`packages/runner/src/commander.ts`](packages/runner/src/commander.ts)

---

## Executive Summary

Under **Fog of War**, an opponent's total troop count, territory count, and interior board positions are completely hidden. To prevent blind decision-making, the AI uses an empirical reverse-engineering formula based on public game telemetry:

1. **Standing Army Deductions**: Modeled through an attrition equation:
   $$\text{Estimated Armies} = \max\Big(\text{Visible Stacks}, \text{Starting Troops} + \sum \text{Turn Incomes} + \text{Card Trades} - \text{Combat Losses}\Big)$$
2. **Continent & Capital Reverse Engineering**: Deduced by analyzing public reinforcement income $+N$/turn (e.g. $+5$/turn mathematically guarantees a held continent bonus or capital).
3. **Card Power Surge Windows**: Predicting impending $+4$ to $+20+$ troop spikes from public card counts (with 5 cards guaranteeing a forced turn trade).
4. **Behavioral Telemetry**: Classifying opponents as "Turtling" (0 attacks last turn, accumulating unseen strike stacks) versus "Bleeding" (3+ attacks last turn, suffering high combat attrition).
5. **Coalition Assessment**: Triggering table-wide All-Chat coalitions when an opponent's power score or income crosses runaway leader thresholds ($\ge 38\%$ of table income or $\ge +3$ over 2nd place).

---

## Quick Reference Guide

### 1. Telemetry Matrix: Hidden vs Public

| Signal | Fog Status | How the AI Uses It |
| :--- | :---: | :--- |
| **Total Armies** | ❌ Hidden | Estimated via $\text{Starting} + \text{Income} + \text{Trades} - \text{Losses}$. Clamped by visible border stacks. |
| **Total Territories** | ❌ Hidden | Reverse-engineered from Turn Income ($\lfloor \text{Territories} / 3 \rfloor$). |
| **Turn Income ($+N$/turn)** | ✅ Public | Primary indicator of continent bonuses ($+5$/turn implies a held bonus or capital). |
| **Card Count** | ✅ Public | Threat indicator: 3 cards = set possible, 4 = set likely, 5 = guaranteed forced trade. |
| **Attack & Conquest Events** | ✅ Public | Even behind fog, battle orders are logged: enables tracking combat losses ($\sim 1.2$ losses/attack). |
| **Border Stacks** | ✅ Public | Physical lower-bound floor for total armies. |

### 2. Attrition Calculation
* **Losses per Attack Roll**: $\approx 1.2$ attacking armies lost per battle order.
* **Losses per Conquest**: $\approx 1.0$ armies spent securing and holding newly conquered land.
* **Turtling Opponents**: Zero attacks last turn means zero attrition—their full reinforcement income was banked into hidden armies.

### 3. Progressive & Exponential Card Surge Telemetry
Even under Fog of War, card counts and trade parameters are fully observable:
* **Progressive Mode**: Shared table trade count (`view.tradeCount`). The exact upcoming trade value ($4, 6, 8, 10, 12, 15, 20, 25, \dots$) is deterministic and public.
* **Exponential Mode**: Per-player personal trades (`stats.cardTrades`). Tracked from battle events; each opponent's bonus scales personally by $\approx 1.3^n$ (e.g. 4, 7, 11, 15...).
* **Effective Power Score**:
  $$\text{Effective Power} = \text{Estimated Standing Armies} + \big(P(\text{Trade}) \times \text{Upcoming Trade Value}\big)$$
  * 5 cards: $P = 1.0$ (forced trade next turn).
  * 4 cards: $P \approx 0.85$ (85% probability).
  * 3 cards: $P \approx 0.40$ (40% probability).
  * Prevents the AI from attacking what appears to be a 12-troop weakling who actually commands an effective 37-troop force in late Progressive play.

### 4. Threat Classification
* **Dominant Threat / Runaway Leader**: Income $\ge 38\%$ of table total or $+3$ over 2nd place. Requires immediate coalition.
* **Stable Contender**: Holding small 1–2 choke continent (+5 to +7 income). Prime partner for "Good Neighbor" non-aggression or surgical bonus griefing.
* **Target for Elimination**: Low estimated armies ($\le 12$) + high card count (3–5 cards). Yields massive **Kill Expected Value (EV)** by stealing cards and refueling armies with an immediate trade.

---

For detailed mathematical proofs, combat formulas, and strategic flowcharts, see the full documentation in [**`docs/fog-power-rankings.md`**](docs/fog-power-rankings.md).

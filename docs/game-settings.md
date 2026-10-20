# Generation 5 Game Settings & Environment Parity Specification

This document defines the exact game settings, board parameters, and randomized switches used in **Generation 5** matches.

Use these specifications to ensure **environment parity** when evaluating trained neural networks (`delove@N`), tuned heuristics (`delove-teacher@N` / `Sensei`), and LLM-driven character players.

---

## 1. Core Rule Baseline (`DEFAULT_OPTIONS`)

The runner baseline settings (`packages/runner/src/presets.ts`) apply to all Generation 5 games:

| Setting Key | Value | Description |
| --- | --- | --- |
| `autoSetup` | `true` | Territories and starting armies are dealt automatically; turn 1 starts immediately. |
| `randomDeal` | `true` | Territories are distributed randomly to players at game start. |
| `setupBatch` | `1` | One army placed per setup step. |
| `balancedBlitz` | `true` | Balanced blitz dice (median of rolls to prevent extreme RNG upsets). |
| `firstRoundBonus` | `true` | Offsets turn order disadvantage: seat $N$ receives at least $N$ armies on Round 1. |
| `fortifyMode` | `'connected'` | Path fortify: armies can move across any unbroken chain of owned territories. |
| `chooseCapitals` | `true` | When capitals are enabled, players choose capitals in turn order before Round 1. |
| `neutrals` | `0` | Neutral territories disabled in multiplayer games of 3+ players. |
| `neutralArmies` | `2` | Default neutral army count if neutrals are activated. |
| `spectatorChat` | `true` | Spectators can view and chat during the match. |

---

## 2. The Randomized League Switch Matrix

In standard Gen 5 character league play (`packages/runner/src/presets.ts:gameOptions`), games sample from the following randomized switches:

### A. Fog of War (`fogOfWar`)
- **Standard League Games**: `random() < 0.5` (50% ON, 50% OFF). Under fog of war, players see only their owned territories and adjacent borders.
- **Delove Model Evaluation (Current Requirement)**: **`fogOfWar: false`**.
  > [!IMPORTANT]
  > Delove neural networks (`delove@1`, `delove@2`, `delove@3`) and the current board encoder (`packages/selfplay/src/encode.ts`) were trained on full board observability. `packages/delove/src/seat.ts` automatically rejects fog of war games. All official Gen 5 games evaluating Delove must explicitly pass `--options '{"fogOfWar":false}'`.
- **Delove Fog Training (Future)**: When developing partial-observability vision models, test against `packages/delove/configs/gen5-randomfog.json` (`fogOfWar: true`).

### B. Blizzards (`blizzards`)
- **50% Chance**: `blizzards: 8` (8 random territories become impassable for the entire game).
- **50% Chance**: `blizzards: 0` (no impassable territories).

### C. Capitals Conquest (`capitals`)
- **50% Chance**: `capitals: true` (Capital Conquest: each player selects a capital; capitals grant +2 armies/round and defend with 3 dice; holding all capitals wins immediately).
- **50% Chance**: `capitals: false` (Standard World Domination).

### D. Card Values (`cardValues`)
Sampled with equal weight across three modes:
1. `'progressive'` (lobby-wide escalation: 4, 6, 8, 10, 12, 15, 20, 25, 30... armies per set).
2. `'fixed'` (Infantry = 4, Cavalry = 6, Cannon = 8, Mixed = 10 armies).
3. `'exponential'` (per-player doubling: 2, 4, 8, 16, 32... armies).

---

## 3. Map Rotation Pool

Gen 5 rotates through all supported engine maps that fit the table size (excluding the tiny 24-territory `skirmish` duel board):

| Map ID | Map Name | Territories | Max Players |
| --- | --- | --- | --- |
| `classic` | Classic Earth | 42 | 6 |
| `world` | World (Medium) | 74 | 10 |
| `world_large` | World (Large) | 104 | 10 |
| `europe` | Europe | 44 | 8 |
| `greater_europe` | Greater Europe | 116 | 10 |
| `europe_classic` | Europe Advanced | 84 | 6 |
| `usa` | United States | 45 | 10 |
| `asia` | Asia | 49 | 8 |
| `fantasy` | Realms of Halvaren | 87 | 10 |

---

## 4. Table Size & Scoring Format

- **Table Size**: 6 players is the standard tournament benchmark table (e.g. 4 League LLMs + Delove@3 + Sensei@2).
- **Scoring**:
  - Placement points: 1st: `+3`, 2nd: `+2`, 3rd: `+1`, 4th: `-1`, 5th: `-2`, 6th: `-3`.
  - Elimination bonus: `+1` point per opponent eliminated.
- **Generation Tag**: Results must be tagged with `--generation gen5` to be included in the active leaderboard.

---

## 5. Ready-to-Use Config Files

Pre-configured JSON options files are stored in `packages/delove/configs/`:

1. **`packages/delove/configs/gen5-nofog.json`**:
   Baseline Gen 5 options with `fogOfWar: false`, `blizzards: 8`, `capitals: true`, `cardValues: "progressive"`.
2. **`packages/delove/configs/gen5-randomfog.json`**:
   Standard league options with `fogOfWar: true` for testing future partial-observability vision models.
3. **`packages/delove/configs/gen5-fixedcards.json`**:
   Options with `cardValues: "fixed"` for testing set-collection strategies without progressive escalation.

---

## 6. How to Run Model Tests on Gen 5 Settings

### A. Testing via Self-Play Ladder (Fast In-Memory Simulation)
Run an in-memory mirrored ladder match between two models:
```bash
# Evaluate delove@3 vs delove-teacher@2 on 6-player Classic under Gen 5 settings
npm run selfplay -- ladder \
  --candidate delove@3 \
  --best delove-teacher@2 \
  --players 6 \
  --map classic \
  --games 200 \
  --options '{"fogOfWar":false,"blizzards":8,"capitals":true,"cardValues":"progressive"}'
```

### B. Adding Gen 5 Gates to Delove Training Cycles (`cycle.sh`)
In `packages/delove/scripts/cycles/*.cycle`, add Gen 5 evaluation gates:
```bash
gates=(
  "delove@2 6 200 {\"fogOfWar\":false,\"blizzards\":8,\"capitals\":true,\"cardValues\":\"progressive\"}"
  "delove-teacher@2 6 200 {\"fogOfWar\":false,\"blizzards\":8,\"capitals\":true,\"cardValues\":\"progressive\"}"
)
```

### C. Seating Models in Live Games via HTTP API (`delove-seat`)
Join an active server match as Delove@3 and Sensei@2:
```bash
npm run delove-seat -- \
  --server http://localhost:8080 \
  --join GAME_CODE \
  --agents delove@3,delove-teacher@2
```

### D. Running Full League Matches with Delove Seats
Run automated Gen 5 matches with 4 rotating League characters and 2 open seats filled by Delove:
```bash
npm run runner -- \
  --server http://127.0.0.1:8080 \
  --players 6 \
  --open-seats 2 \
  --options '{"fogOfWar":false}' \
  --generation gen5
```

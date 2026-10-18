# @risk/delove

**Delove**, our base model: a Risk player with no personality, trained only to win. The plan is in
[docs/delove.md](../../docs/delove.md). This package is never imported by the game server or the character code
(`llm-player`, `runner`, `AI/`); it plugs into the self-play harness (`packages/selfplay`) as player versions.

Everything here is named `delove` (`delove-teacher@1`, `delove@1`, ...) so it never collides with a collaborator's
model on the ladder.

## Run

```bash
npm ci && npm run build
npm run delove -- agents                       # risky@1, random@1, delove-teacher@1
npm run delove -- ladder --best risky@1 --candidate delove-teacher@1 --games 200
npm run delove -- play --agents delove-teacher@1,delove-teacher@1 --games 20000 --seed 1 --log runs/teacher-01
```

`npm run delove` is the self-play CLI (every `play` / `ladder` / `export` option works) with Delove's players
registered first (`node --import ./packages/delove/dist/register.js`).

## Players

| id | what | status |
| --- | --- | --- |
| `delove-teacher@1` | hand-coded teacher (`src/teacher.ts`), Stage 0: Delove's first version learns from it | done |
| `delove@1`, ... | the trained network, loaded from `models/delove/` (ignored by git) | next |

`delove-teacher@1` picks only from the self-play candidates (never off-list), so every decision is a clean training
label, and it is deterministic from the seed. Against `risky@1` (`--seed 3`):

| setup | games | score | Elo |
| --- | --- | --- | --- |
| Classic, 2 players | 400 | 0.94 | +478 |
| Classic, 2 players, fixed cards | 200 | 0.95 | +512 |
| World, 2 players | 200 | 0.955 | +531 |
| Classic, 4 players | 200 | 0.83 | +275 |
| Classic, 4 players, capitals | 200 | 0.805 | +246 |
| World, 6 players | 200 | 0.835 | +282 |

(With 4 or 6 players the score is the share of games won by either of a version's seats; 0.5 is even.)

How it plays: pick a continent to take and stack everything on the territory that attacks into it; defend held
continents' borders against real players (the Neutral never attacks); attack when the battle odds and the payoff
(a card, completing or breaking a continent, an elimination, a capital) beat the expected losses, counting the
armies the defender loses too; move armies forward after a conquest; fortify idle interior stacks toward the most
threatened border.

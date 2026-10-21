# Self-play: running log

Covers `packages/selfplay` (headless games, ladder, decision log `LOG_VERSION`, board encoder `ENCODER_VERSION`,
dataset export). Guides: [packages/selfplay/README.md](../../packages/selfplay/README.md), [docs/training.md](../training.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12). Say when a
change bumps `LOG_VERSION` or `ENCODER_VERSION`.

- 2026-10-21 #PR `runMatch` reports `pairPointsDiff` (each mirrored pair's points difference per seat) for paired gate statistics
- 2026-10-21 #155 fog of war: `src/fog.ts` (`fogInputs`, `FOG_INPUT_VERSION` 1: the seat view as network inputs from the full-board features, plus `hidden` / `hidden_share`), `src/seat-view.ts` (`stateFromView` moved here from delove's seat.ts, `seatInput` with the view's public income, `foggedAgent`: in a fog game every agent decides on its seat view with the view's legal moves; `runBatch` wraps every seat); `Agent.fogInputs`; no `LOG_VERSION` / `ENCODER_VERSION` change (encode.ts and the arrays are unchanged)
- 2026-10-21 #146 ratio scenarios (`src/scenario.ts`): `play --agents 'split:60/40>X,Y'` (table size as `maxPlayers`) starts each game from a synthetic board split between the survivors, drawn from the game seed (contiguous regions, stage-like armies counting the mover's reinforcements, turn, trades, hands from `STAGE_STATS`); summary gains `byShare`; no `LOG_VERSION` / `ENCODER_VERSION` change
- 2026-10-20 #137 stage games (`src/positions.ts`): `play --agents 'LEAD>STAGE'` records only from the moment that many players are left (`GameConfig.stage`), `pos:FILE>STAGE` and `GameConfig.start` play from captured positions, `positions --records` extracts them from game records; game summaries gain `stage`; no `LOG_VERSION` / `ENCODER_VERSION` change (decision records unchanged, `i` stays the step number)
- 2026-10-19 #79 placement points in games, logs, ladder and export (training on leaderboard points)
- 2026-10-19 #72 hooks for the GPU self-play prototype
- 2026-10-19 #71 faster export and CLI options for Delove cycles
- 2026-10-19 #63 Python dataset reader updates for Delove Stage 1
- 2026-10-18 #53 encoder and log changes for exponential cards
- 2026-10-17 #48 board encoder, dataset export, two-step fortify (decision log v2)
- 2026-10-17 #47 `@risk/selfplay`: headless self-play, rating ladder and decision logs

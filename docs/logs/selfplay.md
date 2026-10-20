# Self-play: running log

Covers `packages/selfplay` (headless games, ladder, decision log `LOG_VERSION`, board encoder `ENCODER_VERSION`,
dataset export). Guides: [packages/selfplay/README.md](../../packages/selfplay/README.md), [docs/training.md](../training.md).

Newest first, one line per change: `- YYYY-MM-DD #119 what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12). Say when a
change bumps `LOG_VERSION` or `ENCODER_VERSION`.

- 2026-10-19 #79 placement points in games, logs, ladder and export (training on leaderboard points)
- 2026-10-19 #72 hooks for the GPU self-play prototype
- 2026-10-19 #71 faster export and CLI options for Delove cycles
- 2026-10-19 #63 Python dataset reader updates for Delove Stage 1
- 2026-10-18 #53 encoder and log changes for exponential cards
- 2026-10-17 #48 board encoder, dataset export, two-step fortify (decision log v2)
- 2026-10-17 #47 `@risk/selfplay`: headless self-play, rating ladder and decision logs
